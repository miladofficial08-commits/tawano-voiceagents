const { KEYS, readArray, readValue } = require('./_store');
const { buildHeaders, requireAuth, canAccessTenant } = require('./_auth');
const { checkRateLimit } = require('./_rate-limit');

function parseTenantAgentMap() {
  try {
    const parsed = JSON.parse(process.env.RETELL_TENANT_AGENT_MAP || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function parseHistoryAgentMap() {
  try {
    const parsed = JSON.parse(process.env.RETELL_TENANT_HISTORY_AGENT_MAP || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function asAgentIdArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function resolveTenantAgentIds(tenantId) {
  const byRouting = parseTenantAgentMap();
  const byHistory = parseHistoryAgentMap();
  const ids = [
    ...asAgentIdArray(byRouting[tenantId]),
    ...asAgentIdArray(byHistory[tenantId]),
  ];
  return [...new Set(ids)];
}

function toIsoFromMs(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function normalizeRetellCall(call, tenantId) {
  const createdAt = toIsoFromMs(call.start_timestamp) || toIsoFromMs(call.end_timestamp) || new Date().toISOString();
  return {
    debugId: call.call_id || null,
    callSid: call.call_id || null,
    createdAt,
    updatedAt: toIsoFromMs(call.end_timestamp) || createdAt,
    requestedAgentId: call.agent_id || null,
    resolvedAgentId: call.agent_id || null,
    tenantId: tenantId || null,
    status: call.call_status || null,
    retellStatus: call.call_status || null,
    disconnectionReason: call.disconnection_reason || null,
    durationMs: call.duration_ms || null,
    callAnalysis: call.call_analysis || null,
    customerName: call.to_number || call.from_number || null,
    phoneNumber: call.to_number || null,
    fromNumber: call.from_number || null,
    toNumber: call.to_number || null,
    source: 'retell_history',
  };
}

async function fetchRetellHistoryForTenant(tenantId) {
  const apiKey = process.env.RETELL_API_KEY || '';
  if (!apiKey || !tenantId) return [];

  const tenantAgentIds = resolveTenantAgentIds(tenantId);
  if (!tenantAgentIds.length) return [];

  try {
    const response = await fetch('https://api.retellai.com/v2/list-calls', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 500 }),
    });

    if (!response.ok) return [];

    const payload = await response.json();
    const calls = Array.isArray(payload) ? payload : [];
    return calls
      .filter((call) => tenantAgentIds.includes(String(call.agent_id || '')))
      .map((call) => normalizeRetellCall(call, tenantId));
  } catch (error) {
    return [];
  }
}

function toTimeMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function afterReset(calls, resetAt) {
  const resetMs = toTimeMs(resetAt);
  if (!resetMs) return calls;
  return calls.filter((call) => toTimeMs(call.createdAt || call.updatedAt) >= resetMs);
}

exports.handler = async (event) => {
  const headers = buildHeaders(event);
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, message: 'Method not allowed' }) };
  }

  const authResult = await requireAuth(event, { requiredRoles: ['client_viewer', 'client_admin', 'agency_admin'] });
  if (!authResult.ok) return authResult.response;

  const rate = checkRateLimit(event, 'calls:list', { windowMs: 60 * 1000, maxRequests: 60 });
  if (!rate.allowed) {
    return {
      statusCode: 429,
      headers: buildHeaders(event, { 'Retry-After': String(rate.retryAfterSec) }),
      body: JSON.stringify({ ok: false, message: 'Rate limit exceeded. Try again shortly.' }),
    };
  }

  const queryTenant = event.queryStringParameters && event.queryStringParameters.tenantId
    ? String(event.queryStringParameters.tenantId)
    : authResult.auth.tenantId;

  if (!canAccessTenant(authResult.auth, queryTenant)) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ ok: false, message: 'Tenant access denied' }),
    };
  }

  const calls = await readArray(KEYS.calls);
  const scoped = calls.filter((call) => String(call.tenantId || '') === String(queryTenant || ''));
  const resetMap = await readValue('dashboard-reset-map', {});
  const tenantResetAt = resetMap && typeof resetMap === 'object' ? resetMap[queryTenant] : null;

  const historyCalls = afterReset(await fetchRetellHistoryForTenant(queryTenant), tenantResetAt);
  const scopedAfterReset = afterReset(scoped, tenantResetAt);

  const mergedById = new Map();
  [...historyCalls, ...scopedAfterReset].forEach((call) => {
    const key = String(call.callSid || call.debugId || call.id || Math.random());
    mergedById.set(key, call);
  });
  const merged = Array.from(mergedById.values());

  const sorted = [...merged].sort((a, b) => {
    const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bt - at;
  });

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, calls: sorted.slice(0, 100) }) };
};
