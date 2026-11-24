alter table public.tenants
  add column external_emission_enabled boolean not null default false;

alter table public.document_transmission_attempts
  drop constraint document_transmission_attempts_state_check,
  add constraint document_transmission_attempts_state_check check (state <> 'queued'),
  add column external_document_id uuid,
  add column external_number text;

create unique index document_transmission_attempts_external_id_idx
  on public.document_transmission_attempts(external_document_id)
  where external_document_id is not null;

create function public.set_external_emission_enabled(p_tenant_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner','admin']::public.member_role[]) then
    raise exception 'Acceso reservado al propietario o administrador' using errcode = '42501';
  end if;
  update public.tenants set external_emission_enabled=p_enabled, updated_at=now()
    where id=p_tenant_id and status in ('active','trial');
  if not found then raise exception 'El negocio no está disponible'; end if;
  return p_enabled;
end;
$$;
revoke all on function public.set_external_emission_enabled(uuid,boolean) from public,anon;
grant execute on function public.set_external_emission_enabled(uuid,boolean) to authenticated;
