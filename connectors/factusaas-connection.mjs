const localHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

export function factuSaasConfig(env = process.env) {
  const origin = new URL(env.FACTUSAAS_BASE_URL || 'http://localhost:3002')
  if (origin.protocol !== 'http:' || !localHosts.has(origin.hostname) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('FACTUSAAS_BASE_URL debe ser un origen HTTP local, sin ruta ni credenciales.')
  }
  const emitterId = (env.FACTUSAAS_EMISOR_UUID ?? env.FACTUSAAS_EMITTER_ID ?? '').trim()
  if (emitterId && !isUuid(emitterId)) throw new Error('FACTUSAAS_EMISOR_UUID debe contener el UUID del emisor registrado en FactuSaaS.')
  return { origin, emitterId, apiKey: env.FACTUSAAS_API_KEY?.trim() || '', webhookSecret: env.FACTUSAAS_WEBHOOK_SECRET || '' }
}

export function isUuid(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
}

export async function checkFactuSaas(env = process.env, fetchResource = fetch) {
  const { origin, emitterId, apiKey, webhookSecret } = factuSaasConfig(env)
  const result = { health: 'unavailable', simulatedDevelopment: false, apiKeyRead: 'not_run', webhookSecretConfigured: Boolean(webhookSecret), emitterConfigured: Boolean(emitterId) }
  const get = (path, headers) => fetchResource(new URL(path, origin), { headers, redirect: 'error', signal: AbortSignal.timeout(5000) })
  let health
  try {
    const response = await get('/health')
    if (!response.ok) return { ...result, health: 'http_' + response.status }
    health = await response.json()
  } catch { return result }
  result.health = health?.status === 'ok' ? 'ok' : 'unhealthy'
  result.simulatedDevelopment = result.health === 'ok' && health.env === 'development' && health.simulacion_forzada === true
  if (!result.simulatedDevelopment) return result
  if (!apiKey) return { ...result, apiKeyRead: 'missing_key' }

  const path = new URL('/api/v1/comprobantes?limite=1&es_simulado=true', origin)
  if (emitterId) path.searchParams.set('emisor_id', emitterId)
  try {
    const response = await get(path.pathname + path.search, { 'X-Api-Key': apiKey, Accept: 'application/json' })
    if (!response.ok) {
      await response.body?.cancel()
      return { ...result, apiKeyRead: 'http_' + response.status }
    }
    const list = await response.json().catch(() => null)
    return { ...result, apiKeyRead: Array.isArray(list?.data) ? 'ok' : 'unexpected_response' }
  } catch { return { ...result, apiKeyRead: 'unavailable' } }
}
