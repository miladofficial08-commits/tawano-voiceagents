# Multi-Tenant Security Setup

This project is now prepared for a single-platform multi-tenant setup (not one dashboard copy per customer).

## 1) Required environment variables

Set these in Netlify or your backend host:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `RETELL_API_KEY`
- `RETELL_FROM_NUMBER`
- `ALLOWED_ORIGIN` (for example `https://your-domain.com`)
- `RETELL_TENANT_AGENT_MAP` (JSON map, example below)

Example `RETELL_TENANT_AGENT_MAP`:

```json
{"punkt24":"agent_xxx","beautyworlds":"agent_yyy"}
```

## 2) Login requirement

- Frontend login is handled with Supabase Auth in `beautyworlds-dashboard.html`.
- Backend routes require bearer tokens and reject anonymous access.

## 3) Roles

Supported roles:

- `client_viewer`: can read tenant data
- `client_admin`: can read + trigger calls in own tenant
- `agency_admin`: can read/write across tenants

Store role and tenant in Supabase user metadata/app metadata.

## 4) RLS

Run the SQL migration in `supabase/migrations/001_multi_tenant_rls.sql`.

This creates:

- tenant-aware tables (`tenants`, `profiles`, `calls`)
- strict row-level policies by tenant and role

## 5) Retell key safety

- `RETELL_API_KEY` is backend-only.
- Never expose it in browser code.
- Browser only talks to your own API routes.

## 6) 24/7 hosting

Suggested production setup:

- Frontend: Netlify or Vercel
- Backend: Netlify Functions, Vercel Functions, Railway/Render/Fly.io, Supabase Edge Functions, or VPS

## 7) Security minimum checklist

- Login mandatory: yes
- Tenant isolation: yes
- RLS active: yes (after SQL migration)
- API keys in browser: no
- HTTPS: enabled by Netlify/Vercel automatically
- API rate limit: enabled on protected routes
- Monitoring/logs: use host logs + error tracking (Sentry recommended)
- Daily backups: enable Supabase PITR/backups in project settings
