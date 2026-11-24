create function public.can_manage_account(p_tenant uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_superadmin()
    and exists (select 1 from public.tenant_memberships where tenant_id=p_tenant and user_id=p_user)
    and not exists (select 1 from public.platform_admins where user_id=p_user)
$$;
revoke all on function public.can_manage_account(uuid, uuid) from public;
grant execute on function public.can_manage_account(uuid, uuid) to authenticated;
