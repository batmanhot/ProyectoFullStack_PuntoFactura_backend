alter table public.tenant_products add column stock_control_enabled boolean not null default false;
alter table public.tenant_customers add column address text;
alter table public.service_plans add column overage_allowed boolean not null default false;
alter table public.electronic_documents
  add column issue_date date,
  add column payment_method text,
  add column related_document_id uuid,
  add column note_reason text,
  add column discount_rate numeric(5,2) not null default 0,
  add column igv_rate numeric(5,2),
  add column taxable_base numeric(14,2),
  add column igv_amount numeric(14,2),
  add column lines jsonb not null default '[]',
  add column registration_request jsonb,
  add unique (tenant_id, company_id, id),
  add foreign key (tenant_id, company_id, related_document_id)
    references public.electronic_documents(tenant_id, company_id, id);

create table public.platform_settings (
  singleton boolean primary key default true check (singleton),
  igv_rate numeric(5,2) not null default 18 check (igv_rate between 0 and 100)
);
insert into public.platform_settings default values;
alter table public.platform_settings enable row level security;
create policy "authenticated users read tax rate" on public.platform_settings for select to authenticated using (true);

create table public.inventory_movements (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  company_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  document_id uuid,
  quantity_delta numeric(14,3) not null check (quantity_delta <> 0),
  reason text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, branch_id, company_id) references public.tenant_branches(tenant_id, id, company_id),
  foreign key (tenant_id, product_id, company_id) references public.tenant_products(tenant_id, id, company_id),
  foreign key (tenant_id, company_id, document_id) references public.electronic_documents(tenant_id, company_id, id),
  unique (document_id, product_id)
);
alter table public.inventory_movements enable row level security;
create index inventory_movements_tenant_date_idx on public.inventory_movements(tenant_id, created_at desc);

create function public.is_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid() and role = 'superadmin');
$$;

-- The expiration day is the first day without access, using Peru time.
create function public.tenant_has_access(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenants t
    join lateral (
      select status, current_period_start, current_period_end
      from public.tenant_subscriptions where tenant_id = t.id
      order by created_at desc, id desc limit 1
    ) s on true
    where t.id = p_tenant_id and t.status in ('active', 'trial')
      and s.status in ('active', 'trialing')
      and (now() at time zone 'America/Lima')::date >= s.current_period_start
      and (now() at time zone 'America/Lima')::date < s.current_period_end
  );
$$;
create index tenant_subscriptions_latest_idx on public.tenant_subscriptions(tenant_id, created_at desc, id desc);

create or replace function public.is_tenant_member(target_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.tenant_has_access(target_tenant) and exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = target_tenant and m.user_id = auth.uid() and m.is_active
  );
$$;

create or replace function public.has_tenant_role(target_tenant uuid, allowed_roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select public.tenant_has_access(target_tenant) and exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = target_tenant and m.user_id = auth.uid() and m.is_active and m.role = any(allowed_roles)
  );
$$;

create policy "members read inventory movements" on public.inventory_movements
  for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "members read subscription dates" on public.tenant_subscriptions
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy "authorized members create drafts" on public.electronic_documents;
drop policy "authorized members update drafts" on public.electronic_documents;
drop policy "tenant admins manage series" on public.document_series;
drop policy "sales roles manage inventory" on public.tenant_inventory;
drop policy "tenant admins delete companies" on public.tenant_companies;
drop policy "authorized members upload tenant electronic files" on storage.objects;
revoke insert, update, delete, truncate on public.electronic_documents, public.document_series,
  public.tenant_inventory, public.inventory_movements, public.platform_settings from anon, authenticated;
grant select on public.platform_settings, public.inventory_movements to authenticated;

-- A single entry point writes the document, numbering, inventory and audit together.
create function public.register_document(
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
  v_item record;
  v_lines jsonb := '[]';
  v_date date := (p_document->>'issue_date')::date;
  v_customer text := btrim(p_document->>'customer_name');
  v_identity text := nullif(btrim(p_document->>'customer_document'), '');
  v_reason text := nullif(btrim(p_document->>'note_reason'), '');
  v_igv numeric;
  v_discount numeric := coalesce((p_document->>'discount_rate')::numeric, 0);
  v_quantity numeric;
  v_price numeric;
  v_subtotal numeric := 0;
  v_total numeric;
  v_base numeric;
  v_request jsonb := jsonb_build_object('company', p_company_id, 'series', p_series_id, 'data', p_document);
begin
  -- Lock the same tenant row used by subscription and membership changes.
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
    if not found or v_reason is null or length(v_reason) > 500 or v_reference.issue_date > v_date then
      raise exception 'La nota requiere un motivo y una factura o boleta anterior de la misma empresa';
    end if;
    if left(v_series.series, 1) <> (case v_reference.document_type when '01' then 'F' else 'B' end) then
      raise exception 'La serie de la nota debe corresponder al tipo del comprobante original';
    end if;
    v_customer := v_reference.customer_name;
    v_identity := v_reference.customer_document;
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
    select * into v_product from public.tenant_products
    where sku = v_line->>'product_sku' and tenant_id = p_tenant_id and company_id = p_company_id and is_active
    for share;
    if not found then raise exception 'El producto no existe o está desactivado'; end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'product_sku', v_product.sku, 'name', v_product.name,
      'unit_code', v_product.unit_code, 'quantity', v_quantity, 'unit_price', v_price,
      'track_stock', v_product.stock_control_enabled
    ));
    v_subtotal := v_subtotal + v_quantity * v_price;
  end loop;

  select igv_rate into strict v_igv from public.platform_settings where singleton;
  v_igv := coalesce(v_reference.igv_rate, v_igv);
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
  -- Notes can change prices without returning goods. Physical returns use an explicit adjustment.
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

create function public.set_product_stock(p_tenant_id uuid, p_branch_id uuid, p_product_id uuid, p_stock numeric, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_previous numeric;
begin
  perform 1 from public.tenants where id = p_tenant_id for update;
  if not public.has_tenant_role(p_tenant_id, array['owner','admin','seller']::public.member_role[]) then
    raise exception 'El usuario no puede ajustar inventario' using errcode = '42501';
  end if;
  if p_stock is null or p_stock not between 0 and 99999999999.999 or p_stock <> round(p_stock, 3)
    or coalesce(length(btrim(p_reason)), 0) not between 1 and 250 then
    raise exception 'Ingresa un stock válido y el motivo';
  end if;
  select p.company_id into v_company from public.tenant_products p
  join public.tenant_branches b on b.tenant_id = p.tenant_id and b.company_id = p.company_id
  where p.id = p_product_id and p.tenant_id = p_tenant_id and p.stock_control_enabled and p.is_active
    and b.id = p_branch_id and b.is_active
  for share of p;
  if not found then raise exception 'Producto sin control de stock o sucursal no disponible'; end if;
  select stock into v_previous from public.tenant_inventory
  where branch_id = p_branch_id and product_id = p_product_id for update;
  insert into public.tenant_inventory (tenant_id, company_id, branch_id, product_id, stock)
  values (p_tenant_id, v_company, p_branch_id, p_product_id, p_stock)
  on conflict (branch_id, product_id) do update set stock = excluded.stock, updated_at = now();
  v_previous := coalesce(v_previous, 0);
  if p_stock <> v_previous then
    insert into public.inventory_movements (tenant_id, company_id, branch_id, product_id, quantity_delta, reason, created_by)
    values (p_tenant_id, v_company, p_branch_id, p_product_id, p_stock - v_previous, btrim(p_reason), auth.uid());
  end if;
end;
$$;

-- Add adjustment series to existing and newly provisioned branches.
create function public.add_note_series()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.document_series (tenant_id, company_id, branch_id, document_type, series)
  values (new.tenant_id, new.company_id, new.id, '07', 'FC01'),
         (new.tenant_id, new.company_id, new.id, '08', 'FD01'),
         (new.tenant_id, new.company_id, new.id, '07', 'BC01'),
         (new.tenant_id, new.company_id, new.id, '08', 'BD01')
  on conflict (company_id, document_type, series) do nothing;
  return new;
end;
$$;
create trigger seed_principal_note_series after insert on public.tenant_branches
  for each row when (new.code = '000') execute function public.add_note_series();

insert into public.document_series (tenant_id, company_id, branch_id, document_type, series)
select b.tenant_id, b.company_id, b.id, s.document_type, s.series
from public.tenant_branches b cross join (values ('07','FC01'), ('08','FD01'), ('07','BC01'), ('08','BD01')) s(document_type, series)
where b.code = '000'
on conflict (company_id, document_type, series) do nothing;

-- Sending and consumption remain inactive during registration-only operation.
revoke execute on function public.mark_document_sent(uuid, text, jsonb) from service_role;
revoke execute on function public.reserve_document_number(uuid, uuid, uuid, text) from service_role;
revoke all on function public.tenant_has_access(uuid), public.is_superadmin(), public.add_note_series(),
  public.register_document(uuid, uuid, uuid, uuid, jsonb),
  public.set_product_stock(uuid, uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.is_superadmin(), public.register_document(uuid, uuid, uuid, uuid, jsonb),
  public.set_product_stock(uuid, uuid, uuid, numeric, text) to authenticated;
