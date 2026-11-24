create function public.audit_managed_password_reset(p_tenant uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_manage_account(p_tenant, p_user) then
    raise exception 'Cuenta fuera del negocio' using errcode = '42501';
  end if;
  insert into public.tenant_audit_log(tenant_id,actor_user_id,action,resource_type,resource_id)
    values(p_tenant,auth.uid(),'tenant.member_password_reset','membership',p_user::text);
end;
$$;
revoke all on function public.audit_managed_password_reset(uuid, uuid) from public;
grant execute on function public.audit_managed_password_reset(uuid, uuid) to service_role;
