alter table public.document_transmission_attempts
  drop constraint document_transmission_attempts_transport_check,
  add constraint document_transmission_attempts_transport_check check (transport in ('simulator', 'http')),
  add column external_reference text,
  add column endpoint text,
  add column request_hash text;

alter table public.document_transmission_attempts
  add constraint document_transmission_attempts_request_hash_check
  check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');

create function public.record_external_transmission_result(
  p_tenant_id uuid, p_document_id uuid, p_request_id uuid, p_response jsonb
)
returns public.electronic_documents language plpgsql security definer set search_path = '' as $$
declare
  v_document public.electronic_documents%rowtype;
  v_attempt public.document_transmission_attempts%rowtype;
  v_response jsonb := coalesce(p_response, '{}'::jsonb);
  v_state public.transmission_state;
  v_status public.emission_status;
  v_external text;
  v_authority text;
  v_attempts integer;
  v_usage integer;
  v_period date := date_trunc('month', (now() at time zone 'America/Lima'))::date;
  v_plan public.service_plans%rowtype;
begin
  if jsonb_typeof(v_response) <> 'object' or v_response->>'schema_version' <> 'puntofactura.response.v1'
    or v_response->>'transmission_id' <> p_request_id::text then
    raise exception 'Contrato de respuesta inválido' using errcode = '22023';
  end if;
  if v_response->>'status' not in ('accepted', 'observed', 'rejected', 'failed') then
    raise exception 'Estado externo inválido' using errcode = '22023';
  end if;
  if p_request_id is null then raise exception 'Falta identificador de intento'; end if;

  perform 1 from public.tenants where id = p_tenant_id for update;
  select * into strict v_document from public.electronic_documents
    where id = p_document_id and tenant_id = p_tenant_id for update;
  select * into v_attempt from public.document_transmission_attempts
    where id = p_request_id and document_id = p_document_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'Intento no encontrado' using errcode = 'P0002'; end if;
  if v_attempt.transport <> 'http' then raise exception 'El resultado no corresponde a un intento HTTP' using errcode = '23514'; end if;
  if v_attempt.state <> 'processing' then
    if v_attempt.response = v_response then return v_document; end if;
    raise exception 'El intento ya tiene otra respuesta' using errcode = '23514';
  end if;

  v_external := nullif(v_response->>'external_reference', '');
  v_authority := nullif(v_response->>'authority_code', '');
  v_state := (v_response->>'status')::public.transmission_state;
  select coalesce(jsonb_agg(
    jsonb_build_object('id', a.id, 'attempt_number', a.attempt_number, 'transport', a.transport,
      'state', a.state, 'external_reference', a.external_reference,
      'response', a.response, 'started_at', a.started_at, 'completed_at', a.completed_at)
    order by a.attempt_number
  ), '[]'::jsonb) into v_document.provider_response
  from public.document_transmission_attempts a
  where a.document_id = p_document_id and a.id <> p_request_id;
  v_document.provider_response := v_document.provider_response || jsonb_build_array(
      jsonb_build_object('id', p_request_id, 'attempt_number', v_attempt.attempt_number, 'transport', 'http',
        'state', v_state, 'external_reference', v_external, 'response', v_response,
        'started_at', v_attempt.started_at, 'completed_at', now()));
  v_attempts := v_document.transmission_attempts;
  v_status := case v_state
    when 'accepted' then 'accepted'::public.emission_status
    when 'rejected' then 'rejected'::public.emission_status
    else 'sent'::public.emission_status end;

  update public.document_transmission_attempts set state = v_state, response = v_response,
    external_reference = v_external, completed_at = now()
    where id = p_request_id;
  update public.electronic_documents set status = v_status, transmission_state = v_state,
    transmitted_at = now(), provider_reference = v_external,
    provider_response = v_document.provider_response, transmission_response = v_response, sent_at = now()
    where id = p_document_id returning * into v_document;
  v_document.transmission_attempts := v_attempts;

  if v_state = 'accepted' then
    perform 1 from public.tenants where id = p_tenant_id for update;
    select * into strict v_plan from public.service_plans p join public.tenants t on t.plan_id = p.id where t.id = p_tenant_id;
    select coalesce(sum(sent_count), 0)::integer into v_usage from public.monthly_emission_usage
      where tenant_id = p_tenant_id and period_start = v_period;
    insert into public.monthly_emission_usage(tenant_id, company_id, period_start, sent_count)
      values(p_tenant_id, v_document.company_id, v_period, 1)
      on conflict(tenant_id, company_id, period_start)
      do update set sent_count = public.monthly_emission_usage.sent_count + 1, updated_at = now();
    if v_usage + 1 > v_plan.monthly_document_limit and v_plan.overage_allowed and v_plan.overage_price_pen > 0 then
      insert into public.tenant_overage_charges(tenant_id, company_id, document_id, period_start, unit_price_pen, amount_pen)
        values(p_tenant_id, v_document.company_id, p_document_id, v_period, v_plan.overage_price_pen, v_plan.overage_price_pen)
        on conflict(document_id) do nothing;
    end if;
  end if;
  insert into public.tenant_audit_log(tenant_id, action, resource_type, resource_id, metadata)
    values(p_tenant_id, 'document.transmission_http_result', 'electronic_document', p_document_id::text,
      jsonb_build_object('attempt', v_attempt.attempt_number, 'status', v_state, 'external_reference', v_external, 'authority_code', v_authority));
  return v_document;
end;
$$;

revoke all on function public.record_external_transmission_result(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_external_transmission_result(uuid, uuid, uuid, jsonb) to service_role;
