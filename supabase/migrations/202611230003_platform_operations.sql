create policy "superadmin reads tenants" on public.tenants for select to authenticated using (public.is_superadmin());
create policy "superadmin reads plans" on public.service_plans for select to authenticated using (public.is_superadmin());
create policy "superadmin reads companies" on public.tenant_companies for select to authenticated using (public.is_superadmin());
create policy "superadmin reads subscriptions" on public.tenant_subscriptions for select to authenticated using (public.is_superadmin());
create policy "superadmin reads memberships" on public.tenant_memberships for select to authenticated using (public.is_superadmin());
create policy "superadmin reads usage" on public.monthly_emission_usage for select to authenticated using (public.is_superadmin());
create policy "superadmin reads audit" on public.tenant_audit_log for select to authenticated using (public.is_superadmin());

create table public.subscription_renewals (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  plan_id uuid not null references public.service_plans(id),
  previous_expiry date not null,
  new_expiry date not null check (new_expiry > previous_expiry),
  amount_pen numeric(10,2) not null check (amount_pen >= 0),
  paid_on date not null,
  payment_reference text not null check (length(btrim(payment_reference)) between 1 and 250),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.subscription_renewals enable row level security;
create policy "superadmin reads renewals" on public.subscription_renewals for select to authenticated using (public.is_superadmin());
grant select on public.subscription_renewals to authenticated;
revoke insert, update, delete, truncate on public.subscription_renewals from anon, authenticated;

create function public.renew_subscription(
  p_tenant_id uuid, p_request_id uuid, p_amount numeric, p_paid_on date, p_reference text
)
returns public.subscription_renewals
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant public.tenants%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_renewal public.subscription_renewals%rowtype;
  v_today date := (now() at time zone 'America/Lima')::date;
  v_expiry date;
begin
  if not public.is_superadmin() then raise exception 'Acceso reservado a SuperAdmin' using errcode = '42501'; end if;
  select * into strict v_tenant from public.tenants where id = p_tenant_id for update;
  if v_tenant.status = 'cancelled' then raise exception 'El negocio está cancelado'; end if;
  select * into v_renewal from public.subscription_renewals where id = p_request_id;
  if found then
    if v_renewal.tenant_id <> p_tenant_id or v_renewal.amount_pen is distinct from p_amount
      or v_renewal.paid_on is distinct from p_paid_on or v_renewal.payment_reference is distinct from btrim(p_reference) then
      raise exception 'La solicitud de renovación ya fue utilizada';
    end if;
    return v_renewal;
  end if;
  if p_paid_on is null or p_paid_on > v_today or p_amount is null or p_amount <> round(p_amount, 2) then
    raise exception 'Ingresa la fecha y el importe del pago';
  end if;
  select * into strict v_subscription from public.tenant_subscriptions where tenant_id = p_tenant_id
  order by created_at desc, id desc limit 1 for update;
  v_expiry := (greatest(v_today, v_subscription.current_period_end) +
    case when v_subscription.billing_cycle = 'annual' then interval '1 year' else interval '1 month' end)::date;

  insert into public.subscription_renewals (id, tenant_id, plan_id, previous_expiry, new_expiry, amount_pen, paid_on, payment_reference, created_by)
  values (p_request_id, p_tenant_id, v_tenant.plan_id, v_subscription.current_period_end, v_expiry, p_amount, p_paid_on, btrim(p_reference), auth.uid())
  returning * into v_renewal;
  update public.tenant_subscriptions
  set status = 'active', current_period_start = least(v_today, current_period_start), current_period_end = v_expiry,
    plan_id = v_tenant.plan_id, updated_at = now()
  where id = v_subscription.id;
  update public.tenants set status = 'active', trial_ends_at = null, updated_at = now() where id = p_tenant_id;
  insert into public.tenant_audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_tenant_id, auth.uid(), 'subscription.renewed', 'subscription', v_subscription.id::text,
    jsonb_build_object('renewal_id', p_request_id, 'previous_expiry', v_renewal.previous_expiry, 'new_expiry', v_expiry));
  return v_renewal;
end;
$$;

create function public.update_business(
  p_tenant_id uuid, p_company_id uuid, p_name text, p_legal_name text, p_address text, p_email text,
  p_plan_id uuid, p_status public.tenant_status
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_superadmin() then raise exception 'Acceso reservado a SuperAdmin' using errcode = '42501'; end if;
  perform 1 from public.tenants where id = p_tenant_id for update;
  if p_status is null or p_status not in ('trial', 'active', 'suspended') or coalesce(btrim(p_name), '') = ''
    or coalesce(btrim(p_legal_name), '') = '' or not exists (select 1 from public.service_plans where id = p_plan_id and is_active)
    then raise exception 'Completa los datos y selecciona un plan activo'; end if;
  if (select count(*) from public.tenant_memberships where tenant_id = p_tenant_id and is_active)
    > (select included_users from public.service_plans where id = p_plan_id)
    or (select count(*) from public.tenant_companies where tenant_id = p_tenant_id)
    > (select included_rucs from public.service_plans where id = p_plan_id) then
    raise exception 'El negocio supera el cupo del plan seleccionado';
  end if;
  update public.tenant_companies set legal_name = btrim(p_legal_name), commercial_name = btrim(p_name),
    fiscal_address = nullif(btrim(p_address), ''), email = nullif(btrim(p_email), ''), updated_at = now()
  where id = p_company_id and tenant_id = p_tenant_id;
  if not found then raise exception 'La empresa no pertenece al negocio'; end if;
  update public.tenants set display_name = btrim(p_name), plan_id = p_plan_id, status = p_status, updated_at = now()
  where id = p_tenant_id;
  update public.tenant_subscriptions set plan_id = p_plan_id, updated_at = now() where id = (
    select id from public.tenant_subscriptions where tenant_id = p_tenant_id order by created_at desc, id desc limit 1
  );
  insert into public.tenant_audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_tenant_id, auth.uid(), 'tenant.updated', 'tenant', p_tenant_id::text,
    jsonb_build_object('plan_id', p_plan_id, 'status', p_status));
end;
$$;

create function public.update_service_plan(
  p_plan_id uuid, p_name text, p_price numeric, p_limit integer, p_users integer,
  p_rucs integer, p_overage_allowed boolean, p_overage_price numeric
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_superadmin() then raise exception 'Acceso reservado a SuperAdmin' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' or (p_overage_allowed and coalesce(p_overage_price, 0) <= 0) then
    raise exception 'Ingresa un nombre y una tarifa si se permite exceder el cupo';
  end if;
  update public.service_plans set name = btrim(p_name), monthly_price_pen = p_price,
    monthly_document_limit = p_limit, included_users = p_users, included_rucs = p_rucs,
    overage_allowed = p_overage_allowed, overage_price_pen = p_overage_price, updated_at = now()
  where id = p_plan_id;
  if not found then raise exception 'Plan no encontrado'; end if;
end;
$$;

create function public.update_platform_igv(p_rate numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_superadmin() then raise exception 'Acceso reservado a SuperAdmin' using errcode = '42501'; end if;
  update public.platform_settings set igv_rate = p_rate where singleton;
end;
$$;

create function public.business_access()
returns table (tenant_id uuid, business_name text, member_role public.member_role, has_access boolean, expires_on date, days_remaining integer)
language sql stable security definer set search_path = '' as $$
  select t.id, t.display_name, m.role, public.tenant_has_access(t.id), s.current_period_end,
    s.current_period_end - (now() at time zone 'America/Lima')::date
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  left join lateral (
    select current_period_end from public.tenant_subscriptions where tenant_id = t.id
    order by created_at desc, id desc limit 1
  ) s on true
  where m.user_id = auth.uid() and m.is_active
  order by t.display_name, t.id;
$$;

revoke all on function public.renew_subscription(uuid, uuid, numeric, date, text),
  public.update_business(uuid, uuid, text, text, text, text, uuid, public.tenant_status),
  public.update_service_plan(uuid, text, numeric, integer, integer, integer, boolean, numeric),
  public.update_platform_igv(numeric), public.business_access() from public, anon, authenticated;
grant execute on function public.renew_subscription(uuid, uuid, numeric, date, text),
  public.update_business(uuid, uuid, text, text, text, text, uuid, public.tenant_status),
  public.update_service_plan(uuid, text, numeric, integer, integer, integer, boolean, numeric),
  public.update_platform_igv(numeric), public.business_access() to authenticated;
