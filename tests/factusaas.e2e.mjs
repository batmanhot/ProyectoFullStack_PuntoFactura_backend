import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

if (process.env.PUNTOFACTURA_E2E_ALLOW_SEND !== 'SIMULATED_ONLY') {
  throw new Error('Para crear un comprobante de prueba, define PUNTOFACTURA_E2E_ALLOW_SEND=SIMULATED_ONLY. El script requiere FactuSaaS en simulación forzada.')
}

const apiBase = new URL((process.env.PUNTOFACTURA_API_URL || 'http://127.0.0.1:3001/api').replace(/\/?$/, '/'))
const tenantId = process.env.PUNTOFACTURA_E2E_TENANT_ID
const email = process.env.PUNTOFACTURA_E2E_EMAIL
const password = process.env.PUNTOFACTURA_E2E_PASSWORD
if (!tenantId || !email || !password) {
  throw new Error('Configura PUNTOFACTURA_E2E_TENANT_ID, PUNTOFACTURA_E2E_EMAIL y PUNTOFACTURA_E2E_PASSWORD en el entorno local.')
}

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(new URL(path.replace(/^\/+/, ''), apiBase), {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path} respondió HTTP ${response.status}: ${data.message || 'sin detalle'}`)
  return { response, data }
}

const factusaas = new URL(process.env.FACTUSAAS_BASE_URL || 'http://localhost:3002')
const healthResponse = await fetch(new URL('/health', factusaas), { signal: AbortSignal.timeout(5000) })
const health = await healthResponse.json().catch(() => null)
if (!healthResponse.ok || health?.status !== 'ok' || health.env !== 'development' || health.simulacion_forzada !== true) {
  throw new Error('Se detuvo la prueba: FactuSaaS debe confirmar development y simulacion_forzada=true.')
}

const { response: loginResponse, data: loginData } = await request('/auth/login', {
  method: 'POST', body: { email, password },
})
const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0]
if (!cookie || loginData.user?.app_metadata?.must_change_password) {
  throw new Error('La cuenta de prueba no tiene sesión utilizable; completa el cambio de contraseña inicial y vuelve a ejecutar.')
}

const snapshotResult = await request(`/business/${encodeURIComponent(tenantId)}` , { cookie })
const snapshot = snapshotResult.data
if (!snapshot.externalEmissionEnabled) throw new Error('Activa el envío a FactuSaaS para este negocio antes de ejecutar la prueba.')
const company = snapshot.companies?.find(item => item.id === snapshot.company) ?? snapshot.companies?.[0]
const branchId = snapshot.branches?.[0]?.id
const series = snapshot.series?.find(item => item.document_type === '03' && item.branch_id === branchId)
const product = snapshot.products?.find(item => !item.stock_control_enabled && Number(item.price) > 0)
if (!company || !series || !product) {
  throw new Error('El negocio requiere empresa, serie activa de boleta y producto con precio mayor que cero y control de stock desactivado.')
}

const requestId = randomUUID()
const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Lima',
}).formatToParts(new Date()).map(part => [part.type, part.value]))
const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`
const registered = await request('/operations/register-document', {
  method: 'POST', cookie,
  body: {
    p_tenant_id: tenantId,
    p_company_id: company.id,
    p_series_id: series.id,
    p_request_id: requestId,
    p_document: {
      issue_date: date,
      customer_name: 'PRUEBA LOCAL PUNTO FACTURA',
      customer_document: '87654321',
      payment_method: 'Efectivo',
      related_document_id: null,
      note_reason: null,
      discount_rate: 0,
      lines: [{ product_sku: product.sku, quantity: 1, unit_price: Number(product.price) }],
    },
  },
})
const documentId = registered.data.id
const sent = await request(`/business/${tenantId}/companies/${company.id}/documents/${documentId}/transmit`, {
  method: 'POST', cookie, body: {},
})
if (sent.data.transmission_state === 'failed') {
  throw new Error(`FactuSaaS no recibió el comprobante: ${sent.data.transmission_response?.message || 'fallo de envío'}`)
}

let current
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  const refreshed = await request(`/business/${tenantId}?company=${encodeURIComponent(company.id)}`, { cookie })
  current = refreshed.data.documents?.find(item => item.id === documentId)
  if (current?.transmission_state && !['queued', 'processing'].includes(current.transmission_state)) break
  await delay(1000)
}
if (!current?.transmission_state || ['queued', 'processing'].includes(current.transmission_state)) {
  throw new Error(`FactuSaaS recibió ${sent.data.transmission_response?.external_number || 'el comprobante'}, pero no llegó un estado final por webhook en 30 segundos.`)
}
if (current.transmission_response?.es_simulado !== true) {
  throw new Error('La respuesta final no está marcada como simulada; revisa la configuración del webhook antes de continuar.')
}

console.log(JSON.stringify({
  result: 'ok', simulated: true, document: current.series + '-' + String(current.correlativo).padStart(8, '0'),
  externalNumber: current.transmission_response.external_number,
  state: current.transmission_state,
  message: current.transmission_response.message,
  webhookReceived: true,
}, null, 2))
