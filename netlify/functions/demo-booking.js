const nodemailer = require('nodemailer');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, message: 'Method not allowed' }) };
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const smtpRequireTLS = String(process.env.SMTP_REQUIRE_TLS || 'true').toLowerCase() === 'true';
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || `Tawano <${smtpUser || ''}>`;
  const notifyEmail = process.env.CONTACT_RECEIVER || smtpUser;

  if (!smtpHost || !smtpUser || !smtpPass || !notifyEmail) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'SMTP not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) { body = {}; }

  const { name, company, email, message, sourcePage } = body;

  if (!name || !company || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: 'name, company and email are required' }) };
  }

  const cleanMessage = typeof message === 'string' ? message.trim() : '';
  const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const cleanSource = typeof sourcePage === 'string' && sourcePage.trim() ? sourcePage.trim() : 'unbekannt';

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    requireTLS: smtpRequireTLS,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const internalHtml = `
    <h2>Neue Buchung/Nachricht</h2>
    <p><strong>Name:</strong> ${escapeHtml(name)}</p>
    <p><strong>Firma:</strong> ${escapeHtml(company)}</p>
    <p><strong>E-Mail:</strong> ${escapeHtml(email)}</p>
    <p><strong>Nachricht:</strong> ${escapeHtml(cleanMessage || '-')}</p>
    <p><strong>Seite:</strong> ${escapeHtml(cleanSource)}</p>
    <p><strong>Zeitpunkt:</strong> ${escapeHtml(now)}</p>
  `;

  const firstName = name.split(' ')[0];
  const customerHtml = `
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
      subject: `Neue Buchung/Nachricht: ${name} (${company})`,
      text: `Name: ${name}\nFirma: ${company}\nE-Mail: ${email}\nNachricht: ${cleanMessage || '-'}\nSeite: ${cleanSource}\nZeitpunkt: ${now}`,
      html: internalHtml,
    });

    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: 'Ihre Anfrage bei Tawano',
      text: `Guten Tag ${firstName},\n\nvielen Dank fuer Ihre Anfrage.\nWir melden uns innerhalb von 24 Stunden.\n\nFreundliche Gruesse\nIhr Tawano-Team`,
      html: customerHtml,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Mail error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'sending failed' }) };
  }
};
