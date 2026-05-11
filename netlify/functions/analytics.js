const { KEYS, LIMITS, readArray, appendLimited } = require('./_store');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod === 'POST') {
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
      receivedAt: new Date().toISOString(),
    };

    await appendLimited(KEYS.analytics, item, LIMITS.analytics);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod === 'GET') {
    const limitRaw = event.queryStringParameters && event.queryStringParameters.limit;
    const limit = Math.min(parseInt(limitRaw || '5000', 10) || 5000, LIMITS.analytics);
    const sinceRaw = event.queryStringParameters && event.queryStringParameters.since;
    const since = sinceRaw ? new Date(sinceRaw) : null;

    let events = await readArray(KEYS.analytics);
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
