const crypto = require('crypto');

// Lazy-load store so a blobs failure never blocks the actual call
let _store;
function getStore() {
  if (!_store) {
    try { _store = require('./_store'); } catch (e) { _store = null; }
  }
  return _store;
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, message: 'Method not allowed' }) };
  }

  const RETELL_API_KEY = process.env.RETELL_API_KEY || '';
  const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || '';
  const DEFAULT_TAWANO_AGENT = 'agent_6cada34aac5785c950da3d919b';
  const DEFAULT_KRANKEN_AGENT = 'agent_69344ddb9d60cf9fa9f6a30aa0';
  const DEFAULT_BEAUTY_AGENT = 'agent_2b923be111a55cac5e2ac3d547';
  const RETELL_AGENT_IDS = {
    'tawano-general':    process.env.RETELL_AGENT_TAWANO      || DEFAULT_TAWANO_AGENT,
    'handwerker-demo':  process.env.RETELL_AGENT_HANDWERKER  || process.env.RETELL_AGENT_DEFAULT || '',
    'punkt24-demo':     process.env.RETELL_AGENT_KRANKEN     || DEFAULT_KRANKEN_AGENT,
    'beautyworlds-demo': process.env.RETELL_AGENT_BEAUTY     || DEFAULT_BEAUTY_AGENT,
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) { body = {}; }

  const { agentId, phoneNumber } = body;
  const debugId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(12).toString('hex');
  const createdAt = new Date().toISOString();

  if (!phoneNumber) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: 'phoneNumber is required' }) };
  }
  if (!RETELL_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'Retell API key not configured' }) };
  }
  if (!RETELL_FROM_NUMBER) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'RETELL_FROM_NUMBER not configured' }) };
  }

  const isDirectAgentId = typeof agentId === 'string' && /^agent_[a-zA-Z0-9]+$/.test(agentId);
  const resolvedAgentId = isDirectAgentId
    ? agentId
    : (RETELL_AGENT_IDS[agentId] || process.env.RETELL_AGENT_DEFAULT || DEFAULT_TAWANO_AGENT);
  if (!resolvedAgentId) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'No Retell agent configured for: ' + agentId }) };
  }

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
          website_agent_id: agentId || 'unknown',
        },
      }),
    });

    const data = await retellRes.json();

    if (!retellRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, message: data.message || 'Retell call failed' }) };
    }

    try {
      const store = getStore();
      if (store) {
        await store.appendLimited(store.KEYS.calls, {
          debugId,
          callSid: data.call_id || null,
          createdAt,
          updatedAt: new Date().toISOString(),
          requestedAgentId: agentId || 'tawano-general',
          resolvedAgentId,
          phoneNumber,
          status: data.call_status || 'registered',
          retellStatus: data.call_status || null,
          telephonyIdentifier: data.telephony_identifier || null,
          events: [{ at: createdAt, type: 'retell_registered', callSid: data.call_id || null }],
        }, store.LIMITS.calls);
      }
    } catch (storeError) {
      // Keep call flow intact even if dashboard persistence fails.
      console.error('Failed to persist debug call record:', storeError);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, debugId, callSid: data.call_id, callStatus: data.call_status || null }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'Could not reach Retell API' }) };
  }
};
