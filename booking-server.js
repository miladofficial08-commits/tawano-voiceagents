require('dotenv').config();

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 4000);

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const smtpRequireTLS = String(process.env.SMTP_REQUIRE_TLS || 'true').toLowerCase() === 'true';
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM || `Tawano <${smtpUser || ''}>`;
const notifyEmail = process.env.CONTACT_RECEIVER || smtpUser;
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

// Retell AI config
const RETELL_API_KEY = process.env.RETELL_API_KEY || '';
const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || '';
const RETELL_WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || '';
const DEFAULT_TAWANO_AGENT = 'agent_6cada34aac5785c950da3d919b';
const DEFAULT_KRANKEN_AGENT = 'agent_69344ddb9d60cf9fa9f6a30aa0';
const DEFAULT_BEAUTY_AGENT  = 'agent_2b923be111a55cac5e2ac3d547';
// Agent IDs per page — set in .env or fall back to one default
const RETELL_AGENT_IDS = {
  'tawano-general':     process.env.RETELL_AGENT_TAWANO      || DEFAULT_TAWANO_AGENT,
  'handwerker-demo':    process.env.RETELL_AGENT_HANDWERKER  || process.env.RETELL_AGENT_DEFAULT || '',
  'punkt24-demo':       process.env.RETELL_AGENT_KRANKEN     || DEFAULT_KRANKEN_AGENT,
  'beautyworlds-demo':  process.env.RETELL_AGENT_BEAUTY      || DEFAULT_BEAUTY_AGENT,
};

// seven.io SMS config
const SEVEN_API_KEY  = process.env.SEVEN_API_KEY || '';
const SMS_FROM       = process.env.SMS_FROM || 'Tawano';          // Absendername (max. 11 Zeichen) oder Nummer
const SMS_ENABLED    = Boolean(SEVEN_API_KEY);
const SMS_TEMPLATE   = process.env.SMS_AFTER_CALL_TEMPLATE ||
  'Vielen Dank für Ihr Gespräch mit unserem KI-Assistenten! Falls Sie Fragen haben, melden wir uns bei Ihnen. – Ihr Tawano-Team';

const callDebugStore = new Map();
const MAX_ANALYTICS = 10000;
const analyticsFile = path.join(__dirname, 'data', 'analytics-events.json');
const analyticsEvents = loadAnalyticsEvents();

if (!smtpHost || !smtpUser || !smtpPass || !notifyEmail) {
  console.error('Missing SMTP credentials. Set SMTP_HOST, SMTP_USER, SMTP_PASS and CONTACT_RECEIVER in .env');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpSecure,
  requireTLS: smtpRequireTLS,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

app.use(cors({ origin: allowedOrigin === '*' ? true : allowedOrigin }));
app.use(express.json({ limit: '200kb' }));

// Statische Dateien (HTML, CSS, JS, Audio, Bilder)
app.use(express.static(path.join(__dirname)));

// Saubere URLs: / → index.html, /handwerker → handwerker.html etc.
app.get('/handwerker', (_, res) => res.sendFile(path.join(__dirname, 'handwerker.html')));
app.get('/krankenbefoerderung', (_, res) => res.sendFile(path.join(__dirname, 'krankenbefoerderung.html')));
app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/beautyworlds-dashboard', (_, res) => res.sendFile(path.join(__dirname, 'beautyworlds-dashboard.html')));

app.get('/health', (_, res) => {
  res.json({ ok: true, smsEnabled: SMS_ENABLED });
});

app.get('/api/debug/calls', (_, res) => {
  const recent = Array.from(callDebugStore.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 25)
    .map(summarizeCallDebug);

  res.json({ ok: true, calls: recent });
});

// ── Retell webhook — call lifecycle events ─────────────────────────────────
app.post('/api/webhooks/retell', async (req, res) => {
  // Verify signature if secret is set
  if (RETELL_WEBHOOK_SECRET) {
    const signature = req.headers['x-retell-signature'] || '';
    const body = JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', RETELL_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).json({ ok: false, message: 'Invalid signature' });
    }
  }

  const { event, call } = req.body || {};
  if (!event || !call) return res.status(400).json({ ok: false, message: 'Missing event or call' });

  console.log(`[Retell webhook] event=${event} callId=${call.call_id} status=${call.call_status}`);

  // Update our local store
  const record = callDebugStore.get(call.call_id);
  if (record) {
    record.status = call.call_status || record.status;
    record.retellStatus = call.call_status || null;
    record.disconnectionReason = call.disconnection_reason || null;
    record.startTimestamp = call.start_timestamp || null;
    record.endTimestamp = call.end_timestamp || null;
    record.durationMs = call.duration_ms || null;
    record.callAnalysis = call.call_analysis || null;
    record.updatedAt = new Date().toISOString();
    record.events.push({ at: record.updatedAt, type: 'webhook_' + event });
  }

  // Send SMS after call ends
  if (event === 'call_ended' && call.to_number) {
    const smsSent = await sendSmsAfterCall(call.to_number, call);
    if (record) {
      record.smsSent = smsSent;
      record.smsError = smsSent ? null : 'SMS sending failed or disabled';
      record.events.push({ at: new Date().toISOString(), type: smsSent ? 'sms_sent' : 'sms_skipped' });
    }
  }

  res.json({ ok: true });
});

// ── SMS helper ─────────────────────────────────────────────────────────────
async function sendSmsAfterCall(toNumber, callData) {
  if (!SMS_ENABLED) {
    console.log('[SMS] Skipped — SEVEN_API_KEY not configured');
    return false;
  }
  const message = SMS_TEMPLATE.replace('{number}', toNumber);
  try {
    const params = new URLSearchParams({
      to:   toNumber,
      text: message,
      from: SMS_FROM,
      json: '1',
    });
    const res = await fetch('https://gateway.seven.io/api/sms', {
      method: 'POST',
      headers: {
        'X-Api-Key': SEVEN_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (data.success === '100') {
      console.log(`[SMS] Sent to ${toNumber} via seven.io — balance: ${data.balance}`);
      return true;
    }
    console.error(`[SMS] seven.io error:`, data);
    return false;
  } catch (err) {
    console.error(`[SMS] Failed to send to ${toNumber}:`, err.message);
    return false;
  }
}

// ── Retell AI: outbound demo call ──────────────────────────────────────────
app.post('/api/call', async (req, res) => {
  const { agentId, phoneNumber } = req.body || {};
  const debugId = createDebugId();
  const createdAt = new Date().toISOString();

  if (!phoneNumber) {
    return res.status(400).json({ ok: false, message: 'phoneNumber is required' });
  }
  if (!RETELL_API_KEY) {
    return res.status(500).json({ ok: false, message: 'Retell API key not configured' });
  }
  if (!RETELL_FROM_NUMBER) {
    return res.status(500).json({ ok: false, message: 'RETELL_FROM_NUMBER not configured' });
  }

  const isDirectAgentId = typeof agentId === 'string' && /^agent_[a-zA-Z0-9]+$/.test(agentId);
  const resolvedAgentId = isDirectAgentId
    ? agentId
    : (RETELL_AGENT_IDS[agentId] || process.env.RETELL_AGENT_DEFAULT || '');
  if (!resolvedAgentId) {
    return res.status(500).json({ ok: false, message: 'No Retell agent ID configured for: ' + agentId });
  }

  const record = {
    debugId,
    createdAt,
    updatedAt: createdAt,
    requestedAgentId: agentId,
    resolvedAgentId,
    phoneNumber,
    status: 'starting',
    events: [{ at: createdAt, type: 'request_received' }],
  };

  callDebugStore.set(debugId, record);

  try {
    const retellRes = await fetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RETELL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        override_agent_id: resolvedAgentId,
        from_number: RETELL_FROM_NUMBER,
        to_number: phoneNumber,
        metadata: {
          debug_id: debugId,
          website_agent_id: agentId,
        },
      }),
    });

    const data = await retellRes.json();

    if (!retellRes.ok) {
      console.error('Retell error:', data);
      record.status = 'retell_error';
      record.error = {
        statusCode: retellRes.status,
        message: data.message || 'Retell call failed',
        retellStatus: data.status || null,
      };
      record.updatedAt = new Date().toISOString();
      record.events.push({ at: record.updatedAt, type: 'retell_error', error: record.error });
      return res.status(502).json({ ok: false, debugId, message: data.message || 'Retell call failed' });
    }

    record.callSid = data.call_id;
    record.retellStatus = data.call_status || null;
    record.telephonyIdentifier = data.telephony_identifier || null;
    record.agentName = data.agent_name || null;
    record.status = data.call_status || 'registered';
    record.updatedAt = new Date().toISOString();
    record.events.push({ at: record.updatedAt, type: 'retell_registered', callSid: data.call_id, status: data.call_status || null });

    if (data.call_id) {
      callDebugStore.set(data.call_id, record);
    }

    res.json({
      ok: true,
      debugId,
      callSid: data.call_id,
      callStatus: data.call_status || null,
      telephonyIdentifier: data.telephony_identifier || null,
      updatedAt: record.updatedAt,
    });
  } catch (err) {
    console.error('Retell fetch error:', err);
    record.status = 'network_error';
    record.error = { message: 'Could not reach Retell API' };
    record.updatedAt = new Date().toISOString();
    record.events.push({ at: record.updatedAt, type: 'network_error', error: record.error });
    res.status(500).json({ ok: false, debugId, message: 'Could not reach Retell API' });
  }
});

app.get('/api/call/:callId/status', async (req, res) => {
  const { callId } = req.params;

  if (!RETELL_API_KEY) {
    return res.status(500).json({ ok: false, message: 'Retell API key not configured' });
  }

  try {
    const retellRes = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + RETELL_API_KEY,
      },
    });

    const data = await retellRes.json();
    if (!retellRes.ok) {
      return res.status(retellRes.status).json({ ok: false, message: data.message || 'Could not fetch call status', retell: data });
    }

    const record = callDebugStore.get(callId);
    if (record) {
      record.status = data.call_status || record.status;
      record.retellStatus = data.call_status || null;
      record.telephonyIdentifier = data.telephony_identifier || record.telephonyIdentifier || null;
      record.disconnectionReason = data.disconnection_reason || null;
      record.startTimestamp = data.start_timestamp || null;
      record.endTimestamp = data.end_timestamp || null;
      record.durationMs = data.duration_ms || null;
      record.callAnalysis = data.call_analysis || null;
      record.updatedAt = new Date().toISOString();
      record.events.push({ at: record.updatedAt, type: 'status_fetched', status: data.call_status || null, disconnectionReason: data.disconnection_reason || null });
    }

    res.json({
      ok: true,
      callId,
      debugId: record ? record.debugId : null,
      status: data.call_status || null,
      disconnectionReason: data.disconnection_reason || null,
      fromNumber: data.from_number || null,
      toNumber: data.to_number || null,
      telephonyIdentifier: data.telephony_identifier || null,
      startTimestamp: data.start_timestamp || null,
      endTimestamp: data.end_timestamp || null,
      durationMs: data.duration_ms || null,
      callAnalysis: data.call_analysis || null,
      transcript: data.transcript || null,
      transcriptObject: data.transcript_object || null,
      transcriptAvailable: Boolean(data.transcript),
      updatedAt: record ? record.updatedAt : new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Could not reach Retell API' });
  }
});

app.post('/api/demo-booking', async (req, res) => {
  const { name, company, email, message, sourcePage } = req.body || {};

  if (!name || !company || !email) {
    return res.status(400).json({ ok: false, message: 'name, company and email are required' });
  }

  const cleanMessage = typeof message === 'string' ? message.trim() : '';
  const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const cleanSource = typeof sourcePage === 'string' && sourcePage.trim() ? sourcePage.trim() : 'unbekannt';

  const internalSubject = `Neue Buchung/Nachricht: ${name} (${company})`;
  const internalTextBody = [
    'Neue Buchung/Nachricht eingegangen',
    '----------------------------------',
    `Name: ${name}`,
    `Firma: ${company}`,
    `E-Mail: ${email}`,
    `Nachricht: ${cleanMessage || '-'}`,
    `Seite: ${cleanSource}`,
    `Zeitpunkt: ${now}`,
  ].join('\n');

  const internalHtmlBody = `
    <h2>Neue Buchung/Nachricht</h2>
    <p><strong>Name:</strong> ${escapeHtml(name)}</p>
    <p><strong>Firma:</strong> ${escapeHtml(company)}</p>
    <p><strong>E-Mail:</strong> ${escapeHtml(email)}</p>
    <p><strong>Nachricht:</strong> ${escapeHtml(cleanMessage || '-')}</p>
    <p><strong>Seite:</strong> ${escapeHtml(cleanSource)}</p>
    <p><strong>Zeitpunkt:</strong> ${escapeHtml(now)}</p>
  `;

  const firstName = name.split(' ')[0];
  const customerSubject = 'Ihre Anfrage bei Tawano';
  const customerTextBody = [
    `Guten Tag ${firstName},`,
    '',
    'vielen Dank fuer Ihre Anfrage und Ihr Interesse an Tawano.',
    '',
    'Wir haben Ihre Anfrage erhalten und pruefen diese aktuell.',
    'Unser Team meldet sich in der Regel innerhalb von 24 Stunden persoenlich bei Ihnen.',
    '',
    'Falls Sie weitere Informationen ergaenzen moechten, koennen Sie einfach auf diese E-Mail antworten.',
    '',
    'Freundliche Gruesse',
    'Ihr Tawano-Team',
  ].join('\n');

  const customerHtmlBody = `
    <p>Guten Tag ${escapeHtml(firstName)},</p>
    <p>vielen Dank f&uuml;r Ihre Anfrage und Ihr Interesse an Tawano.</p>
    <p>
      Wir haben Ihre Anfrage erhalten und pr&uuml;fen diese aktuell.<br>
      Unser Team meldet sich in der Regel innerhalb von <strong>24 Stunden</strong> pers&ouml;nlich bei Ihnen.
    </p>
    <p>Falls Sie weitere Informationen erg&auml;nzen m&ouml;chten, k&ouml;nnen Sie einfach auf diese E-Mail antworten.</p>
    <p>Freundliche Gr&uuml;&szlig;e<br>Ihr Tawano-Team</p>
  `;

  try {
    await transporter.sendMail({
      from: smtpFrom,
      to: notifyEmail,
      replyTo: email,
      subject: internalSubject,
      text: internalTextBody,
      html: internalHtmlBody,
    });

    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: customerSubject,
      text: customerTextBody,
      html: customerHtmlBody,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to send demo booking email:', error);
    res.status(500).json({ ok: false, message: 'sending failed' });
  }
});

// ── Analytics store ──────────────────────────────────────────────────────────
app.post('/api/analytics', (req, res) => {
  const ev = req.body || {};
  if (!ev.type || typeof ev.type !== 'string') return res.status(400).json({ ok: false, message: 'type required' });
  ev.receivedAt = new Date().toISOString();
  analyticsEvents.push(ev);
  if (analyticsEvents.length > MAX_ANALYTICS) analyticsEvents.splice(0, analyticsEvents.length - MAX_ANALYTICS);
  saveAnalyticsEvents();
  res.json({ ok: true });
});

app.get('/api/analytics', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '5000'), 10000);
  const since = req.query.since ? new Date(req.query.since) : null;
  let evs = since ? analyticsEvents.filter(e => new Date(e.receivedAt || e.ts) >= since) : analyticsEvents;
  evs = evs.slice(-limit);
  res.json({ ok: true, total: analyticsEvents.length, returned: evs.length, events: evs });
});

app.listen(port, () => {
  console.log(`Booking mailer running on http://localhost:${port}`);
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createDebugId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex');
}

function summarizeCallDebug(record) {
  return {
    debugId: record.debugId,
    callSid: record.callSid || null,
    phoneNumber: record.phoneNumber,
    requestedAgentId: record.requestedAgentId,
    resolvedAgentId: record.resolvedAgentId,
    status: record.status,
    retellStatus: record.retellStatus || null,
    disconnectionReason: record.disconnectionReason || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error || null,
    telephonyIdentifier: record.telephonyIdentifier || null,
    smsSent: record.smsSent ?? null,
    smsError: record.smsError || null,
    events: Array.isArray(record.events) ? record.events.slice(-8) : [],
  };
}

function loadAnalyticsEvents() {
  try {
    if (!fs.existsSync(analyticsFile)) return [];
    const raw = fs.readFileSync(analyticsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_ANALYTICS) : [];
  } catch (error) {
    console.error('Failed to load analytics events:', error.message);
    return [];
  }
}

function saveAnalyticsEvents() {
  try {
    fs.mkdirSync(path.dirname(analyticsFile), { recursive: true });
    fs.writeFileSync(analyticsFile, JSON.stringify(analyticsEvents.slice(-MAX_ANALYTICS), null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save analytics events:', error.message);
  }
}
