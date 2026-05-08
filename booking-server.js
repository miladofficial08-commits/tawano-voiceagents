require('dotenv').config();

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const port = Number(process.env.PORT || 8787);

const senderEmail = process.env.GMAIL_SENDER_EMAIL;
const appPassword = process.env.GMAIL_SENDER_APP_PASSWORD;
const notifyEmail = process.env.BOOKING_NOTIFY_EMAIL || senderEmail;
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

// Retell AI config
const RETELL_API_KEY = process.env.RETELL_API_KEY || '';
const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || '';
// Agent IDs per page — set in .env or fall back to one default
const RETELL_AGENT_IDS = {
  'tawano-general':    process.env.RETELL_AGENT_TAWANO       || process.env.RETELL_AGENT_DEFAULT || '',
  'handwerker-demo':   process.env.RETELL_AGENT_HANDWERKER   || process.env.RETELL_AGENT_DEFAULT || '',
  'punkt24-demo':      process.env.RETELL_AGENT_KRANKEN       || process.env.RETELL_AGENT_DEFAULT || '',
};

const callDebugStore = new Map();

if (!senderEmail || !appPassword) {
  console.error('Missing SMTP credentials. Set GMAIL_SENDER_EMAIL and GMAIL_SENDER_APP_PASSWORD in .env');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: senderEmail,
    pass: appPassword,
  },
});

app.use(cors({ origin: allowedOrigin === '*' ? true : allowedOrigin }));
app.use(express.json({ limit: '200kb' }));

app.get('/health', (_, res) => {
  res.json({ ok: true });
});

app.get('/api/debug/calls', (_, res) => {
  const recent = Array.from(callDebugStore.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 25)
    .map(summarizeCallDebug);

  res.json({ ok: true, calls: recent });
});

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

  const resolvedAgentId = RETELL_AGENT_IDS[agentId] || process.env.RETELL_AGENT_DEFAULT || '';
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
      from: `Tawano Website <${senderEmail}>`,
      to: notifyEmail,
      replyTo: email,
      subject: internalSubject,
      text: internalTextBody,
      html: internalHtmlBody,
    });

    await transporter.sendMail({
      from: `Tawano <${senderEmail}>`,
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
    events: Array.isArray(record.events) ? record.events.slice(-8) : [],
  };
}
