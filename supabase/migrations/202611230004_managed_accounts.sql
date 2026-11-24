-- Check current account state in the database, even if an older token is still open.
create function public.account_is_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u where u.id = auth.uid()
      and not coalesce((u.raw_app_meta_data->>'must_change_password')::boolean, false)
      and coalesce((auth.jwt()->>'iat')::bigint, 0) >= coalesce((u.raw_app_meta_data->>'login_after')::bigint, 0)
  );
$$;

create or replace function public.is_tenant_member(target_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.account_is_ready() and public.tenant_has_access(target_tenant) and exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = target_tenant and m.user_id = auth.uid() and m.is_active
  );
$$;
create or replace function public.has_tenant_role(target_tenant uuid, allowed_roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select public.account_is_ready() and public.tenant_has_access(target_tenant) and exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = target_tenant and m.user_id = auth.uid() and m.is_active and m.role = any(allowed_roles)
  );
$$;
create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.account_is_ready() and exists (select 1 from public.platform_admins where user_id = auth.uid() and role = 'superadmin');
$$;

create function public.update_managed_membership(p_tenant_id uuid, p_user_id uuid, p_role public.member_role, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_membership public.tenant_memberships%rowtype;
  v_limit integer;
begin
  if not public.is_superadmin() then raise exception 'Acceso reservado a SuperAdmin' using errcode = '42501'; end if;
  select p.included_users into strict v_limit from public.tenants t
  join public.service_plans p on p.id = t.plan_id where t.id = p_tenant_id for update of t;
  select * into strict v_membership from public.tenant_memberships
  where tenant_id = p_tenant_id and user_id = p_user_id for update;
  if p_role is null or p_active is null or
    (v_membership.role = 'owner' and p_role <> 'owner') or
    (p_role = 'owner' and v_membership.role <> 'owner') then raise exception 'No se puede reasignar el rol propietario'; end if;
  if p_active and not v_membership.is_active and
    (select count(*) from public.tenant_memberships where tenant_id = p_tenant_id and is_active) >= v_limit
    then raise exception 'Se alcanzó el límite de usuarios'; end if;
  update public.tenant_memberships set role = p_role, is_active = p_active
  where tenant_id = p_tenant_id and user_id = p_user_id;
  insert into public.tenant_audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_tenant_id, auth.uid(), 'tenant.member_updated', 'membership', p_user_id::text,
    jsonb_build_object('role', p_role, 'active', p_active));
end;
$$;

revoke all on function public.account_is_ready(), public.update_managed_membership(uuid, uuid, public.member_role, boolean) from public, anon, authenticated;
grant execute on function public.update_managed_membership(uuid, uuid, public.member_role, boolean) to authenticated;
