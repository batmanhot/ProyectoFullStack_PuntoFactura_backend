create type public.transmission_state as enum ('queued', 'processing', 'accepted', 'observed', 'rejected', 'failed');

alter table public.electronic_documents
  add column transmission_state public.transmission_state,
  add column transmission_attempts integer not null default 0 check (transmission_attempts >= 0),
  add column transmission_response jsonb not null default '{}'::jsonb,
  add column transmitted_at timestamptz,
  add column transmission_requested_at timestamptz,
  add constraint electronic_documents_reference_not_self check (related_document_id is null or related_document_id <> id);

create table public.document_transmission_attempts (
  id uuid primary key,
  tenant_id uuid not null,
  company_id uuid not null,
  document_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  transport text not null check (transport = 'simulator'),
  state public.transmission_state not null check (state <> 'queued' and state <> 'processing'),
  response jsonb not null default '{}',
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  foreign key (tenant_id, company_id, document_id)
    references public.electronic_documents(tenant_id, company_id, id) on delete cascade,
  unique (document_id, attempt_number)
);
alter table public.document_transmission_attempts enable row level security;
create policy "members read transmission attempts" on public.document_transmission_attempts
  for select to authenticated using (public.is_tenant_member(tenant_id));
grant select on public.document_transmission_attempts to authenticated;
revoke insert, update, delete, truncate on public.document_transmission_attempts from anon, authenticated;

create function public.simulate_document_transmission(
  p_tenant_id uuid, p_document_id uuid, p_request_id uuid, p_result text
)
returns public.electronic_documents language plpgsql security definer set search_path = '' as $$
declare
  v_document public.electronic_documents%rowtype;
  v_attempt public.document_transmission_attempts%rowtype;
  v_company public.tenant_companies%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_plan public.service_plans%rowtype;
  v_usage integer;
  v_period date := date_trunc('month', (now() at time zone 'America/Lima'))::date;
  v_response jsonb;
  v_state public.transmission_state;
  v_status public.emission_status;
  v_attempt_number integer;
begin
  if p_result not in ('accepted', 'observed', 'rejected', 'failed') then
    raise exception 'Selecciona un resultado disponible en el simulador' using errcode = '22023';
  end if;
  if p_request_id is null then raise exception 'Falta el identificador del intento'; end if;

  perform 1 from public.tenants where id = p_tenant_id for update;
  if not public.has_tenant_role(p_tenant_id, array['owner','admin','seller']::public.member_role[]) then
    raise exception 'El negocio o el usuario no tiene acceso de envío' using errcode = '42501';
  end if;
  select * into strict v_document from public.electronic_documents
    where tenant_id = p_tenant_id and id = p_document_id for update;
  select * into v_attempt from public.document_transmission_attempts where document_id = p_document_id and id = p_request_id;
  if found then
    if v_attempt.response->>'simulated_result' <> p_result then
      raise exception 'El identificador del intento ya pertenece a otro resultado' using errcode = '22023';
    end if;
    return v_document;
  end if;
  if v_document.status = 'accepted' or v_document.status = 'voided' then
    raise exception 'El documento ya fue aceptado o anulado';
  end if;
  if v_document.transmission_state in ('queued', 'processing') then
    raise exception 'El documento ya tiene un envío en curso';
  end if;

  select * into strict v_company from public.tenant_companies where id = v_document.company_id and tenant_id = p_tenant_id;
  select * into strict v_subscription from public.tenant_subscriptions where tenant_id = p_tenant_id
    order by created_at desc, id desc limit 1;
  if v_subscription.current_period_end <= v_period then raise exception 'La suscripción venció'; end if;
  select * into strict v_plan from public.service_plans where id = v_subscription.plan_id;
  select coalesce(sum(sent_count), 0)::integer into v_usage from public.monthly_emission_usage
    where tenant_id = p_tenant_id and period_start = v_period;
  if v_usage >= v_plan.monthly_document_limit and (not v_plan.overage_allowed or v_plan.overage_price_pen <= 0) then
    raise exception 'Se alcanzó el límite mensual de envíos';
  end if;

  v_state := p_result::public.transmission_state;
  v_status := case p_result
    when 'accepted' then 'accepted'::public.emission_status
    when 'rejected' then 'rejected'::public.emission_status
    else 'sent'::public.emission_status end;
  v_attempt_number := v_document.transmission_attempts + 1;
  v_response := jsonb_build_object(
    'source', 'simulator',
    'message', case p_result
      when 'accepted' then 'Respuesta simulada: comprobante aceptado.'
      when 'observed' then 'Respuesta simulada: comprobante observado.'
      when 'rejected' then 'Respuesta simulada: comprobante rechazado.'
      else 'Fallo simulado: el envío no fue completado.' end,
    'response_code', case p_result when 'accepted' then 'SIM-000' when 'observed' then 'SIM-OBS'
      when 'rejected' then 'SIM-REJ' else 'SIM-ERR' end,
    'external_reference', 'SIM-' || upper(left(replace(p_request_id::text, '-', ''), 16)),
    'simulated_result', p_result
  );
  insert into public.document_transmission_attempts
    (id, tenant_id, company_id, document_id, attempt_number, transport, state, response, created_by)
    values (p_request_id, p_tenant_id, v_document.company_id, p_document_id, v_attempt_number, 'simulator',
      v_state, v_response, auth.uid());
  update public.electronic_documents set status = v_status, transmission_state = v_state,
    transmission_attempts = v_attempt_number, transmission_requested_at = now(), transmitted_at = now(),
    provider_reference = v_response->>'external_reference', provider_response = v_response,
    transmission_response = v_response, sent_at = now()
    where id = p_document_id returning * into v_document;

  if p_result = 'accepted' then
    insert into public.monthly_emission_usage (tenant_id, company_id, period_start, sent_count)
      values (p_tenant_id, v_document.company_id, v_period, 1)
      on conflict (tenant_id, company_id, period_start)
      do update set sent_count = public.monthly_emission_usage.sent_count + 1, updated_at = now();
    if v_usage + 1 > v_plan.monthly_document_limit then
      insert into public.tenant_overage_charges
        (tenant_id, company_id, document_id, period_start, unit_price_pen, amount_pen)
      values (p_tenant_id, v_document.company_id, p_document_id, v_period, v_plan.overage_price_pen, v_plan.overage_price_pen)
      on conflict (document_id) do nothing;
    end if;
  end if;
  insert into public.tenant_audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (p_tenant_id, auth.uid(), 'document.transmission_simulated', 'electronic_document', p_document_id::text,
      jsonb_build_object('attempt', v_attempt_number, 'result', p_result, 'source', 'local_simulator'));
  return v_document;
end;
$$;

revoke all on function public.simulate_document_transmission(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.simulate_document_transmission(uuid, uuid, uuid, text) to authenticated;
