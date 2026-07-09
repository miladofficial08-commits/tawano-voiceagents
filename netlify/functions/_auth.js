const DEFAULT_ROLES = ['client_viewer'];

function getAllowedOrigin(event) {
  const configured = process.env.ALLOWED_ORIGIN || '*';
  if (configured === '*') return '*';

  const requestOrigin = event && event.headers
    ? (event.headers.origin || event.headers.Origin || '')
    : '';
  const allowedOrigins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const defaultAllowedOrigins = [
    'https://tawano.de',
    'https://www.tawano.de',
    'https://tawanoai.netlify.app',
  ];
  const allAllowedOrigins = [...allowedOrigins, ...defaultAllowedOrigins];
  return requestOrigin && allAllowedOrigins.includes(requestOrigin) ? requestOrigin : configured;
}

function buildHeaders(event, extra) {
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

function parseBearerToken(event) {
  const header = event && event.headers
    ? (event.headers.authorization || event.headers.Authorization || '')
    : '';
  if (!header || typeof header !== 'string') return '';
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

function normalizeRoles(rawRoles) {
  if (Array.isArray(rawRoles)) {
    return rawRoles
      .filter(Boolean)
      .map((r) => String(r).trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof rawRoles === 'string' && rawRoles.trim()) {
    return [rawRoles.trim().toLowerCase()];
  }
  return [];
}

function getEmailBindings() {
  const raw = process.env.AUTH_EMAIL_BINDINGS || '{}';
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

async function fetchSupabaseUser(accessToken) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, statusCode: 500, message: 'Supabase environment variables are missing' };
  }

  try {
    const res = await fetch(supabaseUrl + '/auth/v1/user', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        apikey: supabaseAnonKey,
      },
    });

    if (!res.ok) {
      return { ok: false, statusCode: 401, message: 'Invalid or expired session' };
    }

    const user = await res.json();
    return { ok: true, user };
  } catch (error) {
    return { ok: false, statusCode: 500, message: 'Could not verify session token' };
  }
}

function extractAuthContext(user) {
  const appMeta = user && user.app_metadata ? user.app_metadata : {};
  const userMeta = user && user.user_metadata ? user.user_metadata : {};
  const email = (user && user.email ? String(user.email) : '').trim().toLowerCase();
  const emailBindings = getEmailBindings();
  const binding = email && emailBindings[email] && typeof emailBindings[email] === 'object'
    ? emailBindings[email]
    : null;

  const tenantId = appMeta.tenant_id || userMeta.tenant_id || (binding && binding.tenantId) || null;
  const roles = normalizeRoles(appMeta.roles || userMeta.roles || appMeta.role || userMeta.role);
  const boundRoles = binding ? normalizeRoles(binding.roles) : [];
  const safeRoles = roles.length ? roles : (boundRoles.length ? boundRoles : DEFAULT_ROLES);
  const isAgencyAdmin = safeRoles.includes('agency_admin');

  return {
    userId: user.id,
    email: user.email || '',
    tenantId,
    roles: safeRoles,
    isAgencyAdmin,
  };
}

function hasAnyRequiredRole(contextRoles, requiredRoles) {
  if (!requiredRoles || !requiredRoles.length) return true;
  return requiredRoles.some((role) => contextRoles.includes(String(role).toLowerCase()));
}

async function requireAuth(event, options) {
  const requiredRoles = options && Array.isArray(options.requiredRoles)
    ? options.requiredRoles.map((r) => String(r).toLowerCase())
    : [];

  const token = parseBearerToken(event);
  if (!token) {
    return {
      ok: false,
      response: {
        statusCode: 401,
        headers: buildHeaders(event),
        body: JSON.stringify({ ok: false, message: 'Authentication required' }),
      },
    };
  }

  const userResult = await fetchSupabaseUser(token);
  if (!userResult.ok) {
    return {
      ok: false,
      response: {
        statusCode: userResult.statusCode,
        headers: buildHeaders(event),
        body: JSON.stringify({ ok: false, message: userResult.message }),
      },
    };
  }

  const authContext = extractAuthContext(userResult.user);
  if (!authContext.tenantId && !authContext.isAgencyAdmin) {
    return {
      ok: false,
      response: {
        statusCode: 403,
        headers: buildHeaders(event),
        body: JSON.stringify({ ok: false, message: 'No tenant assigned to this user' }),
      },
    };
  }

  if (!hasAnyRequiredRole(authContext.roles, requiredRoles)) {
    return {
      ok: false,
      response: {
        statusCode: 403,
        headers: buildHeaders(event),
        body: JSON.stringify({ ok: false, message: 'Insufficient role permissions' }),
      },
    };
  }

  return { ok: true, auth: authContext };
}

function canAccessTenant(auth, tenantId) {
  if (auth.isAgencyAdmin) return true;
  return !!tenantId && auth.tenantId === tenantId;
}

module.exports = {
  buildHeaders,
  requireAuth,
  canAccessTenant,
};
