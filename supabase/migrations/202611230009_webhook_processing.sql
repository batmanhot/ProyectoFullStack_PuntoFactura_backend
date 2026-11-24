grant select on public.factusaas_webhook_inbox to service_role;
grant update (processed_at) on public.factusaas_webhook_inbox to service_role;
create policy "API marks signed FactuSaaS deliveries processed" on public.factusaas_webhook_inbox
  for update to service_role using (true) with check (true);
