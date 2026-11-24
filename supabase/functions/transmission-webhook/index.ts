import { createClient } from 'npm:@supabase/supabase-js@2'
import { parseCanonicalResponse } from '../../../connectors/transmission-contract.ts'

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const webhookToken = Deno.env.get('TRANSMISSION_WEBHOOK_TOKEN') ?? ''
const maxBodyBytes = 2_800_000
const responseHeaders = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: responseHeaders })

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  if (!webhookToken || request.headers.get('Authorization') !== 'Bearer ' + webhookToken) {
    return json({ error: 'Webhook no autenticado' }, 401)
  }
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') return json({ error: 'Usa Content-Type application/json' }, 415)
  const body = await request.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > maxBodyBytes) return json({ error: 'Tamaño de solicitud no permitido' }, 413)

  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(body)) } catch { return json({ error: 'JSON inválido' }, 400) }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!record || typeof record.transmission_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.transmission_id)
    || typeof record.document_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.document_id)
    || typeof record.tenant_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.tenant_id)) {
    return json({ error: 'Faltan los identificadores UUID de intento, documento o negocio' }, 400)
  }
  let response
  try { response = parseCanonicalResponse(value, record.transmission_id) } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Respuesta inválida' }, 400)
  }
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.rpc('record_external_transmission_result', {
    p_tenant_id: record.tenant_id,
    p_document_id: record.document_id,
    p_request_id: record.transmission_id,
    p_response: response,
  })
  if (error) {
    const status = error.code === 'P0002' ? 404 : error.code === '23514' ? 409 : 400
    return json({ error: error.message }, status)
  }
  return json({ success: true, document_id: record.document_id, status: data?.transmission_state })
})
