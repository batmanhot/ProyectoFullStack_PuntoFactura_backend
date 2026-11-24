import { createHmac, timingSafeEqual } from 'node:crypto'
import { transaction } from '../database.mjs'
import { isUuid } from './factusaas-connection.mjs'

const events = new Set(['comprobante.aceptado', 'comprobante.observado', 'comprobante.rechazado'])
const maxBodySize = 64 * 1024

export function responseFor(attempt, envelope) {
  const status = { 'comprobante.aceptado': 'accepted', 'comprobante.observado': 'observed', 'comprobante.rechazado': 'rejected' }[envelope.evento]
  const data = envelope.data
  return {
    schema_version: 'puntofactura.response.v1', transmission_id: attempt.id, status,
    external_reference: data.comprobante_id, authority_code: data.sunat_response_code ?? null,
    message: data.descripcion ?? 'FactuSaaS actualizó el estado del comprobante.',
    observations: Array.isArray(data.observaciones) ? data.observaciones.map(item => typeof item === 'string' ? item : JSON.stringify(item)) : [],
    errors: [], source: 'factusaas', es_simulado: data.es_simulado === true,
    numero: data.numero ?? null, external_number: data.numero ?? null,
    estado_envio: data.estado_envio ?? null, estado_sunat: data.estado_sunat ?? null,
  }
}

export async function processPendingFactuSaasDeliveries(externalDocumentId) {
  return transaction(async client => {
    await client.query('set local role service_role')
    const { rows: [attempt] } = await client.query(
      "select id,tenant_id,document_id,state from public.document_transmission_attempts where external_document_id=$1 for update", [externalDocumentId])
    if (!attempt || attempt.state !== 'processing') return null
    const { rows: pending } = await client.query(
      'select delivery_id,envelope from public.factusaas_webhook_inbox where external_document_id=$1 and processed_at is null order by received_at limit 1 for update', [externalDocumentId])
    if (!pending.length) return null
    await client.query('select public.record_external_transmission_result($1,$2,$3,$4)',
      [attempt.tenant_id, attempt.document_id, attempt.id, responseFor(attempt, pending[0].envelope)])
    await client.query('update public.factusaas_webhook_inbox set processed_at=now() where delivery_id=$1', [pending[0].delivery_id])
    const { rows: [document] } = await client.query('select transmission_state,transmission_response,transmission_attempts from public.electronic_documents where id=$1', [attempt.document_id])
    return document
  })
}

export function signatureMatches(body, signature, secret) {
  if (!Buffer.isBuffer(body) || typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
}

async function saveDelivery(deliveryId, envelope) {
  return transaction(async client => {
    await client.query('set local role service_role')
    const values = [deliveryId, envelope.evento, envelope.data.comprobante_id, envelope]
    const { rows: [existing] } = await client.query('select event,external_document_id,envelope from public.factusaas_webhook_inbox where delivery_id=$1 for update', [deliveryId])
    if (existing) {
      const { rows: [match] } = await client.query(
        "select event=$2 and external_document_id=$3 and envelope->'data'=$4::jsonb->'data' as matches from public.factusaas_webhook_inbox where delivery_id=$1",
        values)
      return match?.matches ? 'duplicate' : 'conflict'
    }

    const { rows: [attempt] } = await client.query(
      'select id,tenant_id,document_id,state from public.document_transmission_attempts where external_document_id=$1 for update', [envelope.data.comprobante_id])
    let processed = false
    if (attempt && attempt.state === 'processing') {
      await client.query('select public.record_external_transmission_result($1,$2,$3,$4)',
        [attempt.tenant_id, attempt.document_id, attempt.id, responseFor(attempt, envelope)])
      processed = true
    }
    await client.query('insert into public.factusaas_webhook_inbox(delivery_id,event,external_document_id,envelope,processed_at) values($1,$2,$3,$4,case when $5 then now() else null end)',
      [...values, processed])
    return 'recorded'
  })
}

export async function registerFactuSaasWebhook(fastify) {
  // Encapsulation keeps the other API routes on their usual JSON parser.
  fastify.removeContentTypeParser('application/json')
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: maxBodySize }, (_request, bytes, done) => done(null, bytes))

  fastify.post('/api/webhooks/factusaas', { bodyLimit: maxBodySize }, async (request, reply) => {
    const secret = process.env.FACTUSAAS_WEBHOOK_SECRET
    if (!secret) return reply.code(503).send({ message: 'Webhook FactuSaaS sin configurar' })
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      return reply.code(415).send({ message: 'Se requiere application/json' })
    }
    if (!signatureMatches(request.body, request.headers['x-factu-signature'], secret)) {
      return reply.code(401).send({ message: 'Firma de webhook inválida' })
    }

    let envelope
    try { envelope = JSON.parse(request.body.toString('utf8')) }
    catch { return reply.code(400).send({ message: 'JSON inválido' }) }

    const deliveryId = request.headers['x-factu-delivery']
    if (typeof deliveryId !== 'string' || !/^[\w.:-]{1,128}$/.test(deliveryId) ||
        !events.has(envelope?.evento) || !isUuid(envelope?.data?.comprobante_id) ||
        typeof envelope.timestamp !== 'string' || !Number.isFinite(Date.parse(envelope.timestamp))) {
      return reply.code(400).send({ message: 'Entrega de FactuSaaS inválida' })
    }
    const saved = await saveDelivery(deliveryId, envelope)
    if (saved === 'conflict') return reply.code(409).send({ message: 'La entrega ya está asociada a otro contenido' })
    return reply.code(saved === 'duplicate' ? 200 : 202).send({ received: true, duplicate: saved === 'duplicate' })
  })
}
