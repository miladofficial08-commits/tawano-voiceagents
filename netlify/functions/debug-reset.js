const { KEYS, writeArray, readValue, writeValue } = require('./_store');
const { buildHeaders, requireAuth } = require('./_auth');
const { checkRateLimit } = require('./_rate-limit');

exports.handler = async (event) => {
  const headers = buildHeaders(event);
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, message: 'Method not allowed' }) };
  }

  const authResult = await requireAuth(event, { requiredRoles: ['client_viewer', 'client_admin', 'agency_admin'] });
  if (!authResult.ok) return authResult.response;

  const rate = checkRateLimit(event, 'dashboard:reset', { windowMs: 60 * 1000, maxRequests: 5 });
  if (!rate.allowed) {
    return {
      statusCode: 429,
      headers: buildHeaders(event, { 'Retry-After': String(rate.retryAfterSec) }),
      body: JSON.stringify({ ok: false, message: 'Rate limit exceeded. Try again shortly.' }),
    };
  }

  const tenantId = String(authResult.auth.tenantId || '').trim();
  if (!tenantId) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: 'tenantId missing in auth context' }) };
  }

  const now = new Date().toISOString();

  const allCalls = await readValue(KEYS.calls, []);
  const calls = Array.isArray(allCalls) ? allCalls : [];
  const keptCalls = calls.filter((call) => String(call.tenantId || '') !== tenantId);
  await writeArray(KEYS.calls, keptCalls);

  const allAnalytics = await readValue(KEYS.analytics, []);
  const events = Array.isArray(allAnalytics) ? allAnalytics : [];
  const keptEvents = events.filter((ev) => String(ev.tenantId || '') !== tenantId);
  await writeArray(KEYS.analytics, keptEvents);

  const resetMapRaw = await readValue('dashboard-reset-map', {});
  const resetMap = resetMapRaw && typeof resetMapRaw === 'object' ? resetMapRaw : {};
  resetMap[tenantId] = now;
  await writeValue('dashboard-reset-map', resetMap);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, tenantId, resetAt: now }),
  };
};
