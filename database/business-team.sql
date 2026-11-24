create function public.business_team(p_tenant uuid)
returns table(id uuid, name text, email text, role public.member_role, active boolean, temporary boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, coalesce(nullif(u.raw_user_meta_data->>'name', ''), u.email), u.email, m.role, m.is_active,
    coalesce((u.raw_app_meta_data->>'must_change_password')::boolean, false)
  from public.tenant_memberships m join auth.users u on u.id=m.user_id
  where m.tenant_id=p_tenant and public.has_tenant_role(p_tenant, array['owner','admin']::public.member_role[])
  order by m.is_active desc, u.email
$$;
revoke all on function public.business_team(uuid) from public;
grant execute on function public.business_team(uuid) to authenticated;

create policy "business admins read own renewals" on public.subscription_renewals
  for select to authenticated
  using (public.has_tenant_role(tenant_id, array['owner','admin']::public.member_role[]));
