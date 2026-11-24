-- PuntoFactura multi-tenant core (Supabase/PostgreSQL)
-- Tenant provisioning and subscription mutations must run in a trusted server/Edge Function.

create extension if not exists pgcrypto;

create type public.tenant_status as enum ('trial', 'active', 'past_due', 'suspended', 'cancelled');
create type public.member_role as enum ('owner', 'admin', 'seller', 'accountant', 'viewer');
create type public.emission_status as enum ('draft', 'queued', 'sent', 'accepted', 'rejected', 'voided');

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('support', 'billing', 'superadmin')),
  created_at timestamptz not null default now()
);

create table public.service_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  monthly_price_pen numeric(10,2) not null check (monthly_price_pen >= 0),
  monthly_document_limit integer not null check (monthly_document_limit > 0),
  included_users integer not null default 2 check (included_users >= 1),
  included_rucs integer not null default 1 check (included_rucs >= 1),
  overage_price_pen numeric(10,4) not null default 0 check (overage_price_pen >= 0),
  features jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  status public.tenant_status not null default 'trial',
  plan_id uuid not null references public.service_plans(id),
  trial_ends_at timestamptz,
  billing_period_start date not null default date_trunc('month', now())::date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'viewer',
  is_active boolean not null default true,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (tenant_id, user_id)
);

create table public.tenant_companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ruc char(11) not null unique check (ruc ~ '^[0-9]{11}$'),
  legal_name text not null,
  commercial_name text,
  fiscal_address text,
  email text,
  phone text,
  tax_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.tenant_branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  code text not null,
  name text not null,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id) on delete cascade,
  unique (tenant_id, id),
  unique (tenant_id, id, company_id),
  unique (company_id, code)
);

create table public.document_series (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  branch_id uuid,
  document_type text not null check (document_type in ('01', '03', '07', '08')),
  series text not null check (series ~ '^[A-Z][A-Z0-9]{3}$'),
  next_correlativo bigint not null default 1 check (next_correlativo > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id) on delete cascade,
  foreign key (tenant_id, branch_id, company_id) references public.tenant_branches(tenant_id, id, company_id) on delete cascade,
  unique (company_id, document_type, series)
);

create table public.tenant_customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  document_type text,
  document_number text not null,
  name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id) on delete cascade,
  unique (company_id, document_number),
  unique (tenant_id, id)
);

create table public.tenant_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  sku text not null,
  name text not null,
  category text,
  unit_code text not null default 'NIU',
  price numeric(14,2) not null default 0 check (price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id) on delete cascade,
  unique (company_id, sku),
  unique (tenant_id, id),
  unique (tenant_id, id, company_id)
);

create table public.tenant_inventory (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  stock numeric(14,3) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (branch_id, product_id),
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id) on delete cascade,
  foreign key (tenant_id, branch_id, company_id) references public.tenant_branches(tenant_id, id, company_id) on delete cascade,
  foreign key (tenant_id, product_id, company_id) references public.tenant_products(tenant_id, id, company_id) on delete cascade
);

create table public.tenant_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  plan_id uuid not null references public.service_plans(id),
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'annual')),
  current_period_start date not null,
  current_period_end date not null,
  payment_provider text,
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.monthly_emission_usage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  period_start date not null check (period_start = date_trunc('month', period_start::timestamp)::date),
  sent_count integer not null default 0 check (sent_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, company_id, period_start),
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id) on delete cascade
);

create table public.electronic_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  branch_id uuid,
  document_type text not null check (document_type in ('01', '03', '07', '08')),
  series text not null,
  correlativo bigint not null check (correlativo > 0),
  customer_document text,
  customer_name text not null,
  currency char(3) not null default 'PEN',
  total numeric(14,2) not null check (total >= 0),
  status public.emission_status not null default 'draft',
  idempotency_key text not null,
  provider_reference text,
  xml_storage_key text,
  pdf_storage_key text,
  cdr_storage_key text,
  provider_response jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id),
  foreign key (tenant_id, branch_id, company_id) references public.tenant_branches(tenant_id, id, company_id),
  unique (company_id, document_type, series, correlativo),
  unique (tenant_id, idempotency_key)
);

create table public.tenant_overage_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  document_id uuid not null unique references public.electronic_documents(id) on delete cascade,
  period_start date not null check (period_start = date_trunc('month', period_start::timestamp)::date),
  unit_price_pen numeric(10,4) not null check (unit_price_pen > 0),
  amount_pen numeric(10,4) not null check (amount_pen > 0),
  status text not null default 'pending' check (status in ('pending', 'invoiced', 'paid', 'waived')),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, company_id) references public.tenant_companies(tenant_id, id) on delete cascade
);

create table public.tenant_audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  action text not null,
  resource_type text not null,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index tenant_memberships_user_idx on public.tenant_memberships(user_id, is_active);
create index tenant_companies_tenant_idx on public.tenant_companies(tenant_id);
create index tenant_branches_tenant_idx on public.tenant_branches(tenant_id, company_id);
create index tenant_customers_tenant_idx on public.tenant_customers(tenant_id, company_id);
create index tenant_products_tenant_idx on public.tenant_products(tenant_id, company_id);
create index electronic_documents_tenant_created_idx on public.electronic_documents(tenant_id, created_at desc);
create index electronic_documents_company_period_idx on public.electronic_documents(company_id, sent_at desc) where sent_at is not null;
create index tenant_audit_log_tenant_created_idx on public.tenant_audit_log(tenant_id, created_at desc);

create or replace function public.is_tenant_member(target_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = target_tenant and m.user_id = (select auth.uid()) and m.is_active
  );
$$;

create or replace function public.has_tenant_role(target_tenant uuid, allowed_roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = target_tenant and m.user_id = (select auth.uid())
      and m.is_active and m.role = any(allowed_roles)
  );
$$;

create or replace function public.prevent_tenant_reassignment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'Records cannot be moved between tenants' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.provision_tenant(
  p_slug text,
  p_display_name text,
  p_plan_code text,
  p_ruc text,
  p_legal_name text,
  p_admin_user_id uuid,
  p_actor_user_id uuid,
  p_admin_email text,
  p_fiscal_address text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_tenant_id uuid := gen_random_uuid();
  v_company_id uuid := gen_random_uuid();
  v_branch_id uuid := gen_random_uuid();
  v_plan_id uuid;
  v_today date := (now() at time zone 'America/Lima')::date;
  v_period_start date := date_trunc('month', (now() at time zone 'America/Lima'))::date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Tenant provisioning requires a trusted platform service' using errcode = '42501';
  end if;

  select id into v_plan_id from public.service_plans where code = p_plan_code and is_active;
  if v_plan_id is null then
    raise exception 'Plan is not available for new subscriptions' using errcode = '22023';
  end if;
  if p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 48 then
    raise exception 'Invalid tenant slug' using errcode = '22023';
  end if;
  if p_ruc !~ '^[0-9]{11}$' then
    raise exception 'RUC must have 11 digits' using errcode = '22023';
  end if;

  insert into public.tenants (id, slug, display_name, status, plan_id, trial_ends_at, billing_period_start)
  values (v_tenant_id, p_slug, p_display_name, 'trial', v_plan_id, now() + interval '14 days', v_period_start);
  insert into public.tenant_memberships (tenant_id, user_id, role, is_active)
  values (v_tenant_id, p_admin_user_id, 'owner', true);
  insert into public.tenant_companies (id, tenant_id, ruc, legal_name, commercial_name, fiscal_address, email)
  values (v_company_id, v_tenant_id, p_ruc, p_legal_name, p_display_name, p_fiscal_address, p_admin_email);
  insert into public.tenant_branches (id, tenant_id, company_id, code, name, address)
  values (v_branch_id, v_tenant_id, v_company_id, '000', 'Principal', p_fiscal_address);
  insert into public.document_series (tenant_id, company_id, branch_id, document_type, series)
  values (v_tenant_id, v_company_id, v_branch_id, '01', 'F001'), (v_tenant_id, v_company_id, v_branch_id, '03', 'B001');
  insert into public.tenant_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
  values (v_tenant_id, v_plan_id, 'trialing', v_today, v_today + 14);
  insert into public.tenant_audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_tenant_id, p_actor_user_id, 'tenant.provisioned', 'tenant', v_tenant_id::text,
    jsonb_build_object('plan_code', p_plan_code, 'admin_email', p_admin_email));

  return v_tenant_id;
end;
$$;

revoke all on function public.provision_tenant(text, text, text, text, text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.provision_tenant(text, text, text, text, text, uuid, uuid, text, text) to service_role;

create or replace function public.add_tenant_member(
  p_tenant_id uuid,
  p_member_user_id uuid,
  p_actor_user_id uuid,
  p_role public.member_role
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_tenant public.tenants%rowtype;
  v_plan public.service_plans%rowtype;
  v_member_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Membership changes require a trusted tenant service' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'Owner role cannot be assigned through invitations' using errcode = '42501';
  end if;

  select * into v_tenant from public.tenants where id = p_tenant_id for update;
  if not found or v_tenant.status not in ('trial', 'active') then
    raise exception 'Tenant is not active' using errcode = '42501';
  end if;
  select * into v_plan from public.service_plans where id = v_tenant.plan_id;
  select count(*)::integer into v_member_count
  from public.tenant_memberships where tenant_id = p_tenant_id and is_active;
  if v_member_count >= v_plan.included_users then
    raise exception 'Included user limit reached' using errcode = 'P0001';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, role, is_active)
  values (p_tenant_id, p_member_user_id, p_role, true);
  insert into public.tenant_audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_tenant_id, p_actor_user_id, 'tenant.member_invited', 'membership', p_member_user_id::text,
    jsonb_build_object('role', p_role));
end;
$$;

revoke all on function public.add_tenant_member(uuid, uuid, uuid, public.member_role) from public, anon, authenticated;
grant execute on function public.add_tenant_member(uuid, uuid, uuid, public.member_role) to service_role;

create trigger tenant_companies_immutable_tenant before update on public.tenant_companies
  for each row execute function public.prevent_tenant_reassignment();
create trigger tenant_branches_immutable_tenant before update on public.tenant_branches
  for each row execute function public.prevent_tenant_reassignment();
create trigger document_series_immutable_tenant before update on public.document_series
  for each row execute function public.prevent_tenant_reassignment();
create trigger tenant_customers_immutable_tenant before update on public.tenant_customers
  for each row execute function public.prevent_tenant_reassignment();
create trigger tenant_products_immutable_tenant before update on public.tenant_products
  for each row execute function public.prevent_tenant_reassignment();
create trigger tenant_inventory_immutable_tenant before update on public.tenant_inventory
  for each row execute function public.prevent_tenant_reassignment();
create trigger tenant_subscriptions_immutable_tenant before update on public.tenant_subscriptions
  for each row execute function public.prevent_tenant_reassignment();
create trigger electronic_documents_immutable_tenant before update on public.electronic_documents
  for each row execute function public.prevent_tenant_reassignment();

revoke all on function public.is_tenant_member(uuid) from public;
revoke all on function public.has_tenant_role(uuid, public.member_role[]) from public;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.has_tenant_role(uuid, public.member_role[]) to authenticated;

alter table public.service_plans enable row level security;
alter table public.platform_admins enable row level security;
alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.tenant_companies enable row level security;
alter table public.tenant_branches enable row level security;
alter table public.document_series enable row level security;
alter table public.tenant_customers enable row level security;
alter table public.tenant_products enable row level security;
alter table public.tenant_inventory enable row level security;
alter table public.tenant_subscriptions enable row level security;
alter table public.monthly_emission_usage enable row level security;
alter table public.electronic_documents enable row level security;
alter table public.tenant_overage_charges enable row level security;
alter table public.tenant_audit_log enable row level security;

create policy "authenticated users read active plans" on public.service_plans
  for select to authenticated using (is_active);

create policy "platform admins can read their own admin role" on public.platform_admins
  for select to authenticated using (user_id = (select auth.uid()));

create policy "members read own tenants" on public.tenants
  for select to authenticated using (public.is_tenant_member(id));

create policy "members read tenant membership list" on public.tenant_memberships
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "tenant admins update companies" on public.tenant_companies
  for update to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]));

create policy "tenant admins delete companies" on public.tenant_companies
  for delete to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]));

create policy "members read companies" on public.tenant_companies
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "tenant admins manage branches" on public.tenant_branches
  for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]));

create policy "members read branches" on public.tenant_branches
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "members read series" on public.document_series
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "tenant admins manage series" on public.document_series
  for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]));

create policy "members read customers" on public.tenant_customers
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "sales roles manage customers" on public.tenant_customers
  for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[]));

create policy "members read products" on public.tenant_products
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "sales roles manage products" on public.tenant_products
  for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[]));

create policy "members read inventory" on public.tenant_inventory
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "sales roles manage inventory" on public.tenant_inventory
  for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[]));

create policy "tenant admins read subscription" on public.tenant_subscriptions
  for select to authenticated using (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]));

create policy "members read usage" on public.monthly_emission_usage
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "members read documents" on public.electronic_documents
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "authorized members create drafts" on public.electronic_documents
  for insert to authenticated
  with check (
    public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[])
    and status = 'draft' and sent_at is null and provider_reference is null
    and created_by = (select auth.uid())
  );

create policy "authorized members update drafts" on public.electronic_documents
  for update to authenticated
  using (
    public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[])
    and status = 'draft'
  )
  with check (
    public.has_tenant_role(tenant_id, array['owner','admin','seller']::public.member_role[])
    and status = 'draft' and sent_at is null and provider_reference is null
  );

create policy "members read audit log" on public.tenant_audit_log
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "tenant admins read overage charges" on public.tenant_overage_charges
  for select to authenticated using (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]));

-- No authenticated-user policies are defined for tenant creation, membership changes,
-- subscriptions, plan edits, usage increments, audit inserts or final emission status.
-- Those operations must be performed by trusted server functions with service credentials.

create or replace function public.mark_document_sent(
  p_document_id uuid,
  p_provider_reference text,
  p_provider_response jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_document public.electronic_documents%rowtype;
  v_tenant public.tenants%rowtype;
  v_plan public.service_plans%rowtype;
  v_current_usage integer;
  v_period_start date := date_trunc('month', (now() at time zone 'America/Lima'))::date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'This operation requires a trusted emission service' using errcode = '42501';
  end if;

  select * into v_document
  from public.electronic_documents
  where id = p_document_id
  for update;

  if not found then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_document.status not in ('draft', 'queued') then
    raise exception 'Document has already left the sendable state' using errcode = '23514';
  end if;

  select * into v_tenant from public.tenants where id = v_document.tenant_id for update;
  if v_tenant.status not in ('trial', 'active')
    or (v_tenant.status = 'trial' and v_tenant.trial_ends_at is not null and v_tenant.trial_ends_at <= now()) then
    raise exception 'Tenant subscription does not allow emissions' using errcode = '42501';
  end if;
  select * into v_plan from public.service_plans where id = v_tenant.plan_id;
  if not found then
    raise exception 'Tenant plan is unavailable' using errcode = '23514';
  end if;
  select coalesce(sum(sent_count), 0)::integer into v_current_usage
  from public.monthly_emission_usage
  where tenant_id = v_document.tenant_id and period_start = v_period_start;
  if v_current_usage >= v_plan.monthly_document_limit and v_plan.overage_price_pen = 0 then
    raise exception 'Monthly document allowance reached' using errcode = 'P0001';
  end if;

  update public.electronic_documents
  set status = 'sent', sent_at = now(), provider_reference = p_provider_reference,
      provider_response = coalesce(p_provider_response, '{}'::jsonb)
  where id = p_document_id;

  insert into public.monthly_emission_usage (tenant_id, company_id, period_start, sent_count)
  values (v_document.tenant_id, v_document.company_id, v_period_start, 1)
  on conflict (tenant_id, company_id, period_start)
  do update set sent_count = public.monthly_emission_usage.sent_count + 1, updated_at = now();

  if v_current_usage + 1 > v_plan.monthly_document_limit then
    insert into public.tenant_overage_charges (tenant_id, company_id, document_id, period_start, unit_price_pen, amount_pen)
    values (v_document.tenant_id, v_document.company_id, v_document.id, v_period_start,
      v_plan.overage_price_pen, v_plan.overage_price_pen);
  end if;
end;
$$;

revoke all on function public.mark_document_sent(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_document_sent(uuid, text, jsonb) to service_role;

create or replace function public.reserve_document_number(
  p_tenant_id uuid,
  p_company_id uuid,
  p_branch_id uuid,
  p_document_type text
)
returns table (reserved_series text, reserved_correlativo bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Number reservation requires a trusted emission service' using errcode = '42501';
  end if;

  return query
  update public.document_series s
  set next_correlativo = s.next_correlativo + 1
  where s.tenant_id = p_tenant_id
    and s.company_id = p_company_id
    and s.branch_id is not distinct from p_branch_id
    and s.document_type = p_document_type
    and s.is_active
  returning s.series, s.next_correlativo - 1;

  if not found then
    raise exception 'No active document series configured for this tenant and company' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.reserve_document_number(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_document_number(uuid, uuid, uuid, text) to service_role;

insert into public.service_plans (code, name, monthly_price_pen, monthly_document_limit, included_users, included_rucs, overage_price_pen, features)
values
  ('inicio-100', 'Inicio', 29.00, 100, 2, 1, 0.15, '{"core_modules":true,"email_support":true}'::jsonb),
  ('emprende-300', 'Emprende', 49.00, 300, 2, 1, 0.13, '{"core_modules":true,"email_support":true,"exports":true}'::jsonb),
  ('negocio-1000', 'Negocio', 79.00, 1000, 2, 1, 0.11, '{"core_modules":true,"priority_support":true,"exports":true}'::jsonb),
  ('alto-volumen-3000', 'Alto volumen', 129.00, 3000, 2, 1, 0.09, '{"core_modules":true,"priority_support":true,"api":true,"exports":true}'::jsonb)
on conflict (code) do nothing;

-- Electronic files are private and stored under <tenant UUID>/<company UUID>/...
insert into storage.buckets (id, name, public)
values ('tenant-documents', 'tenant-documents', false)
on conflict (id) do update set public = false;

create policy "tenant members read own electronic files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-documents'
    and exists (
      select 1 from public.tenant_memberships m
      where m.tenant_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid()) and m.is_active
    )
  );

create policy "authorized members upload tenant electronic files" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-documents'
    and exists (
      select 1 from public.tenant_memberships m
      where m.tenant_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid()) and m.is_active
        and m.role in ('owner', 'admin', 'seller')
    )
  );
