grant select, insert, update on public.document_transmission_attempts to service_role;
grant select, update on public.electronic_documents to service_role;

create policy "API reads external transmission attempts" on public.document_transmission_attempts
  for select to service_role using (true);
create policy "API inserts external transmission attempts" on public.document_transmission_attempts
  for insert to service_role with check (true);
create policy "API updates external transmission attempts" on public.document_transmission_attempts
  for update to service_role using (true) with check (true);

create policy "API reads external emission documents" on public.electronic_documents
  for select to service_role using (true);
create policy "API updates external emission documents" on public.electronic_documents
  for update to service_role using (true) with check (true);
