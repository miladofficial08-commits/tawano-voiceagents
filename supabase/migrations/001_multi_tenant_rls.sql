-- Multi-tenant base schema + RLS for customer-isolated dashboard access.
-- Run in Supabase SQL editor or via supabase migration tooling.

create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete restrict,
  role text not null check (role in ('client_viewer', 'client_admin', 'agency_admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  call_sid text,
  phone_number text,
  requested_agent_id text,
  resolved_agent_id text,
  status text,
  retell_status text,
  duration_ms integer,
  transcript text,
  call_analysis jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_calls_tenant_created_at on public.calls(tenant_id, created_at desc);
create index if not exists idx_profiles_tenant on public.profiles(tenant_id);

alter table public.profiles enable row level security;
alter table public.calls enable row level security;

create or replace function public.current_role()
returns text
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), 'client_viewer')
$$;

create or replace function public.current_tenant()
returns text
language sql
stable
as $$
  select coalesce(
    auth.jwt() -> 'app_metadata' ->> 'tenant_id',
    auth.jwt() -> 'user_metadata' ->> 'tenant_id'
  )
$$;

create policy profiles_self_or_agency_select
  on public.profiles
  for select
  using (
    auth.uid() = user_id
    or public.current_role() = 'agency_admin'
  );

create policy calls_tenant_select
  on public.calls
  for select
  using (
    public.current_role() = 'agency_admin'
    or tenant_id = public.current_tenant()
  );

create policy calls_tenant_insert
  on public.calls
  for insert
  with check (
    public.current_role() in ('client_admin', 'agency_admin')
    and (
      public.current_role() = 'agency_admin'
      or tenant_id = public.current_tenant()
    )
  );

create policy calls_tenant_update
  on public.calls
  for update
  using (
    public.current_role() in ('client_admin', 'agency_admin')
    and (
      public.current_role() = 'agency_admin'
      or tenant_id = public.current_tenant()
    )
  )
  with check (
    public.current_role() in ('client_admin', 'agency_admin')
    and (
      public.current_role() = 'agency_admin'
      or tenant_id = public.current_tenant()
    )
  );

-- Optional bootstrap examples
insert into public.tenants(id, name) values ('punkt24', 'Punkt24') on conflict (id) do nothing;
