create table public.factusaas_webhook_inbox (
  delivery_id text primary key check (length(delivery_id) between 1 and 128),
  event text not null check (event in ('comprobante.aceptado','comprobante.observado','comprobante.rechazado')),
  external_document_id uuid not null,
  envelope jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.factusaas_webhook_inbox enable row level security;
create policy "API stores signed FactuSaaS deliveries" on public.factusaas_webhook_inbox
  for insert to service_role with check (true);
create policy "API verifies repeated FactuSaaS deliveries" on public.factusaas_webhook_inbox
  for select to service_role using (true);
grant insert (delivery_id,event,external_document_id,envelope) on public.factusaas_webhook_inbox to service_role;
grant select (delivery_id,event,external_document_id,envelope) on public.factusaas_webhook_inbox to service_role;
