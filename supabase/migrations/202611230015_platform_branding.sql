alter table public.platform_settings
  add column application_name text not null default 'puntofactura'
    check (char_length(btrim(application_name)) between 2 and 40),
  add column application_mark text not null default 'p'
    check (char_length(btrim(application_mark)) between 1 and 3),
  add column application_icon_data text
    check (application_icon_data is null or (
      char_length(application_icon_data) <= 140000
      and application_icon_data ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
    ));

create function public.update_platform_branding(
  p_application_name text, p_application_mark text, p_application_icon_data text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_superadmin() then raise exception 'Acceso reservado a SuperAdmin' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_application_name, ''))) not between 2 and 40
    or char_length(btrim(coalesce(p_application_mark, ''))) not between 1 and 3
    or (p_application_icon_data is not null and (
      char_length(p_application_icon_data) > 140000
      or p_application_icon_data !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
    )) then
    raise exception 'Revisa el nombre, el símbolo y la imagen de marca';
  end if;
  update public.platform_settings set
    application_name = btrim(p_application_name),
    application_mark = btrim(p_application_mark),
    application_icon_data = p_application_icon_data
  where singleton;
end;
$$;

revoke all on function public.update_platform_branding(text, text, text) from public, anon, authenticated;
grant execute on function public.update_platform_branding(text, text, text) to authenticated;
