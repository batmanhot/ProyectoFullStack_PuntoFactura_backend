do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}'
);
create table auth.sessions (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
create index sessions_user_idx on auth.sessions(user_id);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('pf.user_id', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select current_setting('pf.role', true)
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('iat', extract(epoch from now())::bigint)
$$;
grant usage on schema auth to authenticated, service_role;
