const { KEYS, LIMITS, readArray, appendLimited } = require('./_store');
const { buildHeaders, requireAuth, canAccessTenant } = require('./_auth');
const { checkRateLimit } = require('./_rate-limit');

exports.handler = async (event) => {
  const headers = buildHeaders(event);
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod === 'POST') {
    const rate = checkRateLimit(event, 'analytics:write', { windowMs: 60 * 1000, maxRequests: 120 });
    if (!rate.allowed) {
      return {
        statusCode: 429,
        headers: buildHeaders(event, { 'Retry-After': String(rate.retryAfterSec) }),
        body: JSON.stringify({ ok: false, message: 'Rate limit exceeded. Try again shortly.' }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (error) {
      body = {};
    }

    if (!body.type || typeof body.type !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: 'type required' }) };
    }

    const item = {
      ...body,
      tenantId: 'public',
      userId: null,
      receivedAt: new Date().toISOString(),
    };

    await appendLimited(KEYS.analytics, item, LIMITS.analytics);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod === 'GET') {
    const authResult = await requireAuth(event, { requiredRoles: ['client_viewer', 'client_admin', 'agency_admin'] });
    if (!authResult.ok) return authResult.response;

    const rate = checkRateLimit(event, 'analytics:read', { windowMs: 60 * 1000, maxRequests: 80 });
    if (!rate.allowed) {
      return {
        statusCode: 429,
        headers: buildHeaders(event, { 'Retry-After': String(rate.retryAfterSec) }),
        body: JSON.stringify({ ok: false, message: 'Rate limit exceeded. Try again shortly.' }),
      };
    }

    const limitRaw = event.queryStringParameters && event.queryStringParameters.limit;
    const limit = Math.min(parseInt(limitRaw || '5000', 10) || 5000, LIMITS.analytics);
    const sinceRaw = event.queryStringParameters && event.queryStringParameters.since;
    const since = sinceRaw ? new Date(sinceRaw) : null;
    const queryTenant = event.queryStringParameters && event.queryStringParameters.tenantId
      ? String(event.queryStringParameters.tenantId)
      : authResult.auth.tenantId;

    if (!canAccessTenant(authResult.auth, queryTenant)) {
      return { statusCode: 403, headers, body: JSON.stringify({ ok: false, message: 'Tenant access denied' }) };
    }

    let events = await readArray(KEYS.analytics);
    events = events.filter((ev) => String(ev.tenantId || '') === String(queryTenant || ''));
    if (since && !Number.isNaN(since.getTime())) {
      events = events.filter((ev) => {
        const ts = ev.receivedAt || ev.ts;
        return ts ? new Date(ts) >= since : false;
      });
    }

    const sliced = events.slice(-limit);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, total: events.length, returned: sliced.length, events: sliced }),
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ ok: false, message: 'Method not allowed' }) };
};
