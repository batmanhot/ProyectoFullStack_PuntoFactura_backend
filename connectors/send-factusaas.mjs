import { createHash, randomUUID } from 'node:crypto'
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { actor, transaction } from '../database.mjs'
import { factuSaasConfig, isUuid } from './factusaas-connection.mjs'
import { buildFactuSaasPayload } from './factusaas-payload.mjs'


export async function sendFactuSaasDocument(user, tenantId, companyId, documentId) {
  const config = factuSaasConfig()
  if (!config.apiKey || !config.emitterId || !config.webhookSecret) {
    throw new ServiceUnavailableException('Completa API Key, UUID del emisor y secreto webhook en el backend.')
  }
  const responseHealth = await fetch(new URL('/health', config.origin), { signal: AbortSignal.timeout(5000) }).catch(() => null)
  const health = responseHealth?.ok ? await responseHealth.json().catch(() => null) : null
  if (health?.status !== 'ok' || health.env !== 'development' || health.simulacion_forzada !== true) {
    throw new ServiceUnavailableException('FactuSaaS no confirma el ambiente de desarrollo con simulación forzada.')
  }

  const prepared = await transaction(async client => {
    await actor(client, user)
    const { rows: [tenant] } = await client.query('select external_emission_enabled from public.tenants where id=$1 and public.is_tenant_member($1)', [tenantId])
    if (!tenant) throw new NotFoundException('Negocio no disponible')
    if (!tenant.external_emission_enabled) throw new ForbiddenException('Activa el envío a FactuSaaS en Configuración.')
    if (!await client.query("select public.has_tenant_role($1,array['owner','admin','seller']::public.member_role[]) as allowed", [tenantId]).then(result => result.rows[0].allowed)) {
      throw new ForbiddenException('No tienes permiso para enviar comprobantes.')
    }
    // PostgreSQL requires UPDATE permission to lock a row with SELECT FOR UPDATE.
    await actor(client, user, 'service_role')
    const { rows: [document] } = await client.query(
      'select * from public.electronic_documents where tenant_id=$1 and company_id=$2 and id=$3 for update',
      [tenantId, companyId, documentId])
    if (!document) throw new NotFoundException('Comprobante no disponible')
    if (document.status === 'draft' || document.status === 'voided') {
      throw new BadRequestException('El comprobante debe estar registrado y vigente para enviarse.')
    }
    const { rows: [prior] } = await client.query('select 1 from public.document_transmission_attempts where document_id=$1 and external_document_id is not null limit 1', [documentId])
    const currentState = {
      transmission_state: document.transmission_state,
      transmission_response: document.transmission_response,
      transmission_attempts: document.transmission_attempts,
      transmission_requested_at: document.transmission_requested_at,
    }
    if (prior || ['accepted', 'queued'].includes(document.transmission_state)) return { currentState }
    const { rows: [interrupted] } = document.transmission_state === 'processing'
      ? await client.query(
        `select id,attempt_number,request_hash,started_at <= now() - interval '1 minute' as expired
         from public.document_transmission_attempts
         where document_id=$1 and transport='http' and state='processing' and external_document_id is null
         order by attempt_number desc limit 1`, [documentId])
      : { rows: [] }
    if (document.transmission_state === 'processing' && !interrupted?.expired) return { currentState }
    let original = null
    if (document.related_document_id) {
      const { rows: [result] } = await client.query(
        `select d.document_type,a.external_number
         from public.electronic_documents d
         join public.document_transmission_attempts a on a.document_id=d.id and a.external_number is not null
         where d.id=$1 and d.tenant_id=$2 and d.company_id=$3 order by a.attempt_number desc limit 1`,
        [document.related_document_id, tenantId, companyId])
      original = result ?? null
    }
    const body = buildFactuSaasPayload(document, config.emitterId, original)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    if (interrupted) {
      if (interrupted.request_hash !== requestHash) {
        throw new BadRequestException('La configuración del envío cambió. Restáurala para recuperar la respuesta de FactuSaaS.')
      }
      await client.query('update public.document_transmission_attempts set started_at=now() where id=$1', [interrupted.id])
      await client.query('update public.electronic_documents set transmission_requested_at=now() where id=$1', [documentId])
      return { body, requestId: interrupted.id, attempt_number: interrupted.attempt_number }
    }
    const requestId = randomUUID()
    const { rows: [{ attempt_number }] } = await client.query('select coalesce(max(attempt_number),0)+1 as attempt_number from public.document_transmission_attempts where document_id=$1', [documentId])
    await client.query('insert into public.document_transmission_attempts(id,tenant_id,company_id,document_id,attempt_number,transport,state,endpoint,request_hash,created_by) values($1,$2,$3,$4,$5,\'http\',\'processing\',$6,$7,$8)',
      [requestId, tenantId, companyId, documentId, attempt_number, new URL('/api/v1/comprobantes', config.origin).toString(), requestHash, user.id])
    await client.query("update public.electronic_documents set transmission_state='processing',transmission_attempts=$2,transmission_requested_at=now() where id=$1", [documentId, attempt_number])
    return { body, requestId, attempt_number }
  })

  if (prepared.currentState) {
    return refreshReceiptStatus(config, user, tenantId, documentId, prepared.currentState)
  }
  const { requestId } = prepared
  let reply
  let responseCode
  try {
    const result = await fetch(new URL('/api/v1/comprobantes', config.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'X-Api-Key': config.apiKey, 'Idempotency-Key': documentId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(prepared.body),
    })
    reply = await result.json().catch(() => ({}))
    if (!result.ok || !isUuid(reply?.id) || !reply.numero) {
      const validationFailed = result.status === 422 && reply?.error === 'VALIDATION_ERROR'
      if (validationFailed) responseCode = reply.error
      throw new Error(validationFailed && typeof reply.message === 'string'
        ? reply.message
        : 'FactuSaaS no confirmó la recepción del comprobante' + (!result.ok ? ` (HTTP ${result.status}).` : '.'))
    }
  } catch (error) {
    const failure = { source: 'factusaas', message: error.name === 'TimeoutError' ? 'Tiempo de espera agotado. Verifica en FactuSaaS antes de reintentar.' : error.message, response_code: responseCode, es_simulado: true }
    await transaction(async client => {
      await actor(client, user, 'service_role')
      await client.query("update public.document_transmission_attempts set state='failed',response=$2,completed_at=now() where id=$1", [requestId, failure])
      await client.query("update public.electronic_documents set transmission_state='failed',transmission_response=$2 where id=$1 and tenant_id=$3", [documentId, failure, tenantId])
    })
    return { transmission_state: 'failed', transmission_response: failure, transmission_attempts: prepared.attempt_number }
  }

  const accepted = { source: 'factusaas', message: reply.message || 'FactuSaaS recibió el comprobante y lo puso en cola.', external_reference: reply.id, external_number: reply.numero, es_simulado: true }
  await transaction(async client => {
    await actor(client, user, 'service_role')
    await client.query('update public.document_transmission_attempts set external_document_id=$2,external_number=$3,external_reference=$4,response=$5 where id=$1', [requestId, reply.id, reply.numero, reply.id, accepted])
    await client.query("update public.electronic_documents set transmission_state='queued',transmission_response=$2 where id=$1 and tenant_id=$3", [documentId, accepted, tenantId])
  })
  // FactuSaaS may deliver its webhook before its POST response is received.
  const { processPendingFactuSaasDeliveries } = await import('./factusaas-webhook.mjs')
  const webhookResult = await processPendingFactuSaasDeliveries(reply.id)
  return webhookResult ?? { transmission_state: 'queued', transmission_response: accepted, transmission_attempts: prepared.attempt_number }
}

async function refreshReceiptStatus(config, user, tenantId, documentId, current) {
  const externalId = current.transmission_response?.external_reference
  if (current.transmission_state !== 'queued' || !isUuid(externalId)) return current

  const url = new URL('/api/v1/comprobantes/' + externalId, config.origin)
  const result = await fetch(url, {
    headers: { 'X-Api-Key': config.apiKey }, redirect: 'error', signal: AbortSignal.timeout(5000),
  }).catch(() => null)
  if (!result?.ok) throw new ServiceUnavailableException('No se pudo consultar el estado en FactuSaaS.')
  const body = await result.json().catch(() => null)
  const external = body?.data ?? body
  if (external?.id !== externalId) throw new ServiceUnavailableException('FactuSaaS devolvió una referencia inesperada.')

  const requiresReview = external.estado_envio === 'ERROR'
  const receipt = {
    ...current.transmission_response,
    estado_envio: external.estado_envio,
    response_code: requiresReview ? external.ultimo_error_codigo : undefined,
    message: requiresReview
      ? 'FactuSaaS recibió el comprobante, pero informó un error. Revisa el envío en FactuSaaS.'
      : 'FactuSaaS recibió el comprobante. Punto Factura está a la espera del resultado.',
  }
  return transaction(async client => {
    await actor(client, user, 'service_role')
    const columns = 'transmission_state,transmission_response,transmission_attempts,transmission_requested_at'
    const { rows: [updated] } = await client.query(
      `update public.electronic_documents set transmission_response=$3
       where id=$1 and tenant_id=$2 and transmission_state='queued'
       and transmission_response->>'external_reference'=$4 returning ${columns}`,
      [documentId, tenantId, receipt, externalId])
    if (updated) return updated
    const { rows: [latest] } = await client.query(
      `select ${columns} from public.electronic_documents where id=$1 and tenant_id=$2`, [documentId, tenantId])
    return latest ?? current
  })
}
