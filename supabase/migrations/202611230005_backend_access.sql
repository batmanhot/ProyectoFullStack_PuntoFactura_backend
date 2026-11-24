create function public.managed_account_list()
returns table (tenant_id uuid, user_id uuid, name text, email text, role public.member_role, active boolean, temporary boolean)
language sql stable security definer set search_path = '' as $$
  select m.tenant_id, m.user_id, coalesce(u.raw_user_meta_data->>'name', ''), u.email::text, m.role, m.is_active,
    coalesce((u.raw_app_meta_data->>'must_change_password')::boolean, false)
  from public.tenant_memberships m join auth.users u on u.id = m.user_id
  where public.is_superadmin()
  order by m.tenant_id, m.role, u.email;
$$;
revoke all on function public.managed_account_list() from public, anon, authenticated;
grant execute on function public.managed_account_list() to authenticated;

grant select on public.platform_admins, public.service_plans, public.tenants, public.tenant_memberships,
  public.tenant_companies, public.tenant_branches, public.document_series, public.tenant_customers, public.tenant_products,
  public.tenant_inventory, public.tenant_subscriptions, public.monthly_emission_usage, public.electronic_documents,
  public.tenant_overage_charges, public.tenant_audit_log to authenticated;
grant insert, update on public.tenant_customers, public.tenant_products to authenticated;
revoke delete on public.tenant_products, public.tenant_customers, public.tenant_branches from authenticated;
revoke update on public.tenant_companies from authenticated;

grant select, insert, update on public.tenant_memberships, public.tenant_audit_log to service_role;
grant select on public.platform_admins, public.service_plans, public.tenant_companies to service_role;

-- Remove the retired browser path for tenant-managed invitations.
drop policy "tenant admins update companies" on public.tenant_companies;
drop policy "tenant admins manage branches" on public.tenant_branches;

create or replace function public.business_access()
returns table (tenant_id uuid, business_name text, member_role public.member_role, has_access boolean, expires_on date, days_remaining integer)
language sql stable security definer set search_path = '' as $$
  select t.id, t.display_name, m.role, public.account_is_ready() and public.tenant_has_access(t.id), s.current_period_end,
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

create function public.provision_business(
  p_slug text, p_display_name text, p_plan_code text, p_ruc text, p_legal_name text,
  p_admin_user_id uuid, p_actor_user_id uuid, p_admin_email text, p_fiscal_address text, p_expires_on date
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_today date := (now() at time zone 'America/Lima')::date;
begin
  if p_expires_on is not null and p_expires_on <= v_today then
    raise exception 'El vencimiento inicial debe ser posterior a hoy';
  end if;
  v_id := public.provision_tenant(p_slug, p_display_name, p_plan_code, p_ruc, p_legal_name,
    p_admin_user_id, p_actor_user_id, p_admin_email, p_fiscal_address);
  if p_expires_on is not null then
    update public.tenant_subscriptions set current_period_end = p_expires_on where tenant_id = v_id;
    update public.tenants set trial_ends_at = p_expires_on::timestamp at time zone 'America/Lima' where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.provision_business(text, text, text, text, text, uuid, uuid, text, text, date) from public, anon, authenticated;
grant execute on function public.provision_business(text, text, text, text, text, uuid, uuid, text, text, date) to service_role;
