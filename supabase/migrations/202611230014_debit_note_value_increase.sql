-- Debit notes for value increases refer to original item snapshots. Their
-- entered line price is the incremental value, including IGV, not the new total price.
create or replace function public.register_document(
  p_tenant_id uuid, p_company_id uuid, p_series_id uuid, p_request_id uuid, p_document jsonb
)
returns public.electronic_documents
language plpgsql security definer set search_path = '' as $$
declare
  v_series public.document_series%rowtype;
  v_document public.electronic_documents%rowtype;
  v_reference public.electronic_documents%rowtype;
  v_product public.tenant_products%rowtype;
  v_line jsonb;
  v_original_line jsonb;
  v_item record;
  v_lines jsonb := '[]';
  v_date date := (p_document->>'issue_date')::date;
  v_customer text := btrim(p_document->>'customer_name');
  v_identity text := nullif(btrim(p_document->>'customer_document'), '');
  v_reason text := nullif(btrim(p_document->>'note_reason'), '');
  v_reason_code text := nullif(p_document->>'note_reason_code', '');
  v_igv numeric;
  v_discount numeric := coalesce((p_document->>'discount_rate')::numeric, 0);
  v_quantity numeric;
  v_price numeric;
  v_original_quantity numeric;
  v_credited_quantity numeric;
  v_already_quantity numeric;
  v_subtotal numeric := 0;
  v_total numeric;
  v_base numeric;
  v_request jsonb := jsonb_build_object('company', p_company_id, 'series', p_series_id, 'data', p_document);
begin
  perform 1 from public.tenants where id = p_tenant_id for update;
  if not public.has_tenant_role(p_tenant_id, array['owner','admin','seller']::public.member_role[]) then
    raise exception 'El negocio o el usuario no tiene acceso de registro' using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'Falta el identificador de la solicitud'; end if;

  select * into v_document from public.electronic_documents
  where tenant_id = p_tenant_id and idempotency_key = p_request_id::text;
  if found then
    if v_document.registration_request is distinct from v_request then
      raise exception 'La solicitud ya se usó para otro comprobante' using errcode = '22023';
    end if;
    return v_document;
  end if;

  select s.* into v_series from public.document_series s
  left join public.tenant_branches b on b.id = s.branch_id and b.tenant_id = s.tenant_id and b.company_id = s.company_id
  where s.id = p_series_id and s.tenant_id = p_tenant_id and s.company_id = p_company_id and s.is_active
    and (s.branch_id is null or b.is_active)
  for update of s;
  if not found then raise exception 'Selecciona una serie activa de la empresa'; end if;

  if v_date is null or coalesce(v_customer, '') = '' or length(v_customer) > 250
    or coalesce(btrim(p_document->>'payment_method'), '') = ''
    or v_discount not between 0 and 100 or v_discount <> round(v_discount, 2) then
    raise exception 'Completa la fecha, cliente, forma de pago y descuento del comprobante';
  end if;
  if v_series.document_type = '01' and (v_identity is null or v_identity !~ '^[0-9]{11}$') then
    raise exception 'La factura requiere un RUC de 11 dígitos';
  end if;
  if v_series.document_type = '03' and v_identity is not null and v_identity !~ '^([0-9]{8}|[0-9]{11})$' then
    raise exception 'Ingresa un DNI o RUC válido para la boleta';
  end if;
  if v_series.document_type in ('07', '08') then
    select * into v_reference from public.electronic_documents
    where id = (p_document->>'related_document_id')::uuid
      and tenant_id = p_tenant_id and company_id = p_company_id
      and document_type in ('01', '03') and status in ('registered', 'sent', 'accepted');
    if not found or v_reason is null or length(v_reason) > 250 or v_reference.issue_date > v_date then
      raise exception 'La nota requiere un motivo y una factura o boleta anterior de la misma empresa';
    end if;
    if left(v_series.series, 1) <> (case v_reference.document_type when '01' then 'F' else 'B' end) then
      raise exception 'La serie de la nota debe corresponder al tipo del comprobante original';
    end if;
    v_customer := v_reference.customer_name;
    v_identity := v_reference.customer_document;
    if v_series.document_type = '08' and coalesce(v_reason_code, '') not in ('01', '02', '03') then
      raise exception 'Selecciona un código válido del Catálogo 10 para la nota de débito';
    end if;
  elsif p_document->>'related_document_id' is not null or v_reason is not null then
    raise exception 'Solo las notas admiten un comprobante de referencia y motivo';
  end if;

  if jsonb_typeof(p_document->'lines') is distinct from 'array' then
    raise exception 'El detalle debe contener una lista de productos';
  end if;
  if jsonb_array_length(p_document->'lines') not between 1 and 200 then
    raise exception 'Incluye entre 1 y 200 líneas';
  end if;
  for v_line in select value from jsonb_array_elements(p_document->'lines') loop
    v_quantity := (v_line->>'quantity')::numeric;
    v_price := (v_line->>'unit_price')::numeric;
    if v_quantity is null or v_quantity not between 0.001 and 999999999 or v_quantity <> round(v_quantity, 3)
      or v_price is null or v_price not between 0 and 999999999 or v_price <> round(v_price, 2) then
      raise exception 'La cantidad o el precio de una línea no es válido';
    end if;

    if v_series.document_type = '07' or (v_series.document_type = '08' and v_reason_code = '02') then
      select item into v_original_line
      from jsonb_array_elements(v_reference.lines) as original_line(item)
      where item->>'product_sku' is not distinct from nullif(v_line->>'product_sku', '')
        and (item->>'unit_price')::numeric = case when v_series.document_type = '07' then v_price else (v_line->>'reference_unit_price')::numeric end
      limit 1;
      if v_original_line is null then
        raise exception 'El ítem no pertenece al comprobante relacionado';
      end if;

      select coalesce(sum((item->>'quantity')::numeric), 0) into v_original_quantity
      from jsonb_array_elements(v_reference.lines) as original_line(item)
      where item->>'product_sku' is not distinct from v_original_line->>'product_sku'
        and (item->>'unit_price')::numeric = case when v_series.document_type = '07' then v_price else (v_line->>'reference_unit_price')::numeric end;

      select coalesce(sum((line->>'quantity')::numeric), 0) into v_credited_quantity
      from public.electronic_documents credit
      cross join lateral jsonb_array_elements(credit.lines) as credit_line(line)
      where credit.tenant_id = p_tenant_id and credit.company_id = p_company_id
        and credit.related_document_id = v_reference.id and credit.document_type = '07'
        and credit.status not in ('draft', 'voided', 'rejected')
        and credit_line.line->>'product_sku' is not distinct from v_original_line->>'product_sku'
        and (credit_line.line->>'unit_price')::numeric = case when v_series.document_type = '07' then v_price else (v_line->>'reference_unit_price')::numeric end;

      select coalesce(sum((line->>'quantity')::numeric), 0) into v_already_quantity
      from jsonb_array_elements(v_lines) as current_line(line)
      where current_line.line->>'product_sku' is not distinct from v_original_line->>'product_sku'
        and (v_series.document_type <> '07' or (current_line.line->>'unit_price')::numeric = v_price)
        and (v_series.document_type = '07' or (current_line.line->>'reference_unit_price')::numeric = (v_line->>'reference_unit_price')::numeric);

      if v_quantity > v_original_quantity - v_credited_quantity - v_already_quantity then
        raise exception 'La cantidad supera lo disponible en el comprobante original';
      end if;
      if v_series.document_type = '08' and (v_price <= 0 or coalesce((v_line->>'reference_unit_price')::numeric, 0) <= 0) then
        raise exception 'El aumento requiere un incremento y un precio original mayores que cero';
      end if;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'product_id', v_original_line->'product_id', 'product_sku', v_original_line->'product_sku',
        'name', v_original_line->'name', 'unit_code', coalesce(v_original_line->>'unit_code', 'NIU'),
        'quantity', v_quantity, 'unit_price', case when v_series.document_type = '07' then (v_original_line->>'unit_price')::numeric else v_price end,
        'reference_unit_price', case when v_series.document_type = '08' then (v_line->>'reference_unit_price')::numeric else null end,
        'igv_affectation_code', '10',
        'track_stock', coalesce((v_original_line->>'track_stock')::boolean, false)
      ));
    elsif v_series.document_type = '08' and v_reason_code in ('01', '03') then
      if coalesce(btrim(v_line->>'name'), '') = '' or length(btrim(v_line->>'name')) > 250 or v_price <= 0 then
        raise exception 'Cada concepto requiere una descripción de hasta 250 caracteres y un importe mayor que cero';
      end if;
      if v_reason_code = '01' and coalesce(p_document->>'note_tax_affectation', '') <> '30' then
        raise exception 'Los intereses por mora se registran como inafectos al IGV';
      end if;
      if v_reason_code = '03' and coalesce(p_document->>'note_tax_affectation', '') not in ('10', '20', '30') then
        raise exception 'Selecciona la afectación al IGV del concepto de penalidad';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'product_id', null, 'product_sku', null, 'name', btrim(v_line->>'name'), 'unit_code', 'NIU',
        'quantity', v_quantity, 'unit_price', v_price,
        'igv_affectation_code', case when v_reason_code = '01' then '30' else p_document->>'note_tax_affectation' end,
        'track_stock', false
      ));
    else
      select * into v_product from public.tenant_products
      where sku = v_line->>'product_sku' and tenant_id = p_tenant_id and company_id = p_company_id and is_active
      for share;
      if not found then raise exception 'El producto no existe o está desactivado'; end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'product_id', v_product.id, 'product_sku', v_product.sku, 'name', v_product.name,
        'unit_code', v_product.unit_code, 'quantity', v_quantity, 'unit_price', v_price,
        'igv_affectation_code', '10',
        'track_stock', v_product.stock_control_enabled
      ));
    end if;
    v_subtotal := v_subtotal + v_quantity * v_price;
  end loop;

  select igv_rate into strict v_igv from public.platform_settings where singleton;
  v_igv := coalesce(v_reference.igv_rate, v_igv);
  if v_series.document_type = '08' and (v_reason_code = '01' or (v_reason_code = '03' and p_document->>'note_tax_affectation' in ('20', '30'))) then
    v_igv := 0;
  end if;
  v_total := round(v_subtotal * (1 - v_discount / 100), 2);
  if v_total <= 0 then raise exception 'El total debe ser mayor que cero'; end if;
  v_base := round(v_total / (1 + v_igv / 100), 2);
  insert into public.electronic_documents (
    tenant_id, company_id, branch_id, document_type, series, correlativo, customer_name, customer_document,
    issue_date, payment_method, related_document_id, note_reason, discount_rate, igv_rate, taxable_base,
    igv_amount, total, lines, registration_request, status, idempotency_key, created_by
  ) values (
    p_tenant_id, p_company_id, v_series.branch_id, v_series.document_type, v_series.series, v_series.next_correlativo,
    v_customer, v_identity, v_date, btrim(p_document->>'payment_method'), v_reference.id, v_reason, v_discount,
    v_igv, v_base, v_total - v_base, v_total, v_lines, v_request, 'registered', p_request_id::text, auth.uid()
  ) returning * into v_document;

  update public.document_series set next_correlativo = next_correlativo + 1 where id = v_series.id;
  if v_series.document_type in ('01', '03') then
    for v_item in
      select product_id, sum(quantity) as quantity
      from jsonb_to_recordset(v_lines) as l(product_id uuid, quantity numeric, track_stock boolean)
      where track_stock group by product_id order by product_id
    loop
      update public.tenant_inventory set stock = stock - v_item.quantity, updated_at = now()
      where tenant_id = p_tenant_id and company_id = p_company_id
        and branch_id = v_series.branch_id and product_id = v_item.product_id and stock >= v_item.quantity;
      if not found then raise exception 'Stock insuficiente en la sucursal para un producto con control activo'; end if;
      insert into public.inventory_movements (tenant_id, company_id, branch_id, product_id, document_id, quantity_delta, reason, created_by)
      values (p_tenant_id, p_company_id, v_series.branch_id, v_item.product_id, v_document.id, -v_item.quantity, 'Venta registrada', auth.uid());
    end loop;
  end if;

  insert into public.tenant_audit_log (tenant_id, actor_user_id, action, resource_type, resource_id)
  values (p_tenant_id, auth.uid(), 'document.registered', 'electronic_document', v_document.id::text);
  return v_document;
end;
$$;
