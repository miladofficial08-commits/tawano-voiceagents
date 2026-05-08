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
  const RETELL_AGENT_IDS = {
    'tawano-general':  process.env.RETELL_AGENT_TAWANO   || process.env.RETELL_AGENT_DEFAULT || '',
    'handwerker-demo': process.env.RETELL_AGENT_HANDWERKER || process.env.RETELL_AGENT_DEFAULT || '',
    'punkt24-demo':    process.env.RETELL_AGENT_KRANKEN   || process.env.RETELL_AGENT_DEFAULT || '',
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) { body = {}; }

  const { agentId, phoneNumber } = body;

  if (!phoneNumber) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: 'phoneNumber is required' }) };
  }
  if (!RETELL_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'Retell API key not configured' }) };
  }
  if (!RETELL_FROM_NUMBER) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'RETELL_FROM_NUMBER not configured' }) };
  }

  const resolvedAgentId = RETELL_AGENT_IDS[agentId] || process.env.RETELL_AGENT_DEFAULT || '';
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
      }),
    });

    const data = await retellRes.json();

    if (!retellRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, message: data.message || 'Retell call failed' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, callSid: data.call_id, callStatus: data.call_status || null }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: 'Could not reach Retell API' }) };
  }
};
