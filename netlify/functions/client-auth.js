const { buildHeaders } = require('./_auth');

exports.handler = async (event) => {
  const headers = buildHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, message: 'Method not allowed' }),
    };
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, message: 'Supabase env missing on server' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    body = {};
  }

  const email = String(body.email || '').trim();
  const password = String(body.password || '');

  if (!email || !password) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, message: 'email and password are required' }),
    };
  }

  try {
    const response = await fetch(supabaseUrl + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (error) {
      data = {};
    }

    if (!response.ok) {
      const isEmailNotConfirmed = data.error_code === 'email_not_confirmed';
      return {
        statusCode: isEmailNotConfirmed ? 403 : 401,
        headers,
        body: JSON.stringify({
          ok: false,
          code: data.error_code || null,
          message: isEmailNotConfirmed
            ? 'E-Mail noch nicht bestaetigt. Bitte in Supabase Auth > Users den Nutzer bestaetigen oder E-Mail-Confirm deaktivieren.'
            : (data.error_description || data.msg || 'Login failed'),
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        tokenType: data.token_type,
        user: data.user ? { id: data.user.id, email: data.user.email } : null,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, message: 'Could not reach Supabase auth' }),
    };
  }
};
