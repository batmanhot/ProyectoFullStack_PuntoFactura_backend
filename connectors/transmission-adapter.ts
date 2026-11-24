import type { CanonicalTransmission, CanonicalTransmissionResponse } from './transmission-contract.ts'
import { parseCanonicalResponse } from './transmission-contract.ts'

export type HttpAdapterConfig = {
  endpoint: string
  bearerToken: string
  timeoutMs?: number
}

export async function sendToExternalApp(
  config: HttpAdapterConfig,
  transmission: CanonicalTransmission,
): Promise<CanonicalTransmissionResponse> {
  const destination = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('El conector requiere una URL HTTP o HTTPS.')
  if (destination.username || destination.password) throw new Error('No incluyas credenciales en la URL del conector.')
  if (!config.bearerToken) throw new Error('Falta el secreto del conector.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000)
  try {
    const response = await fetch(destination, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Authorization': 'Bearer ' + config.bearerToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Idempotency-Key': transmission.transmission_id,
      },
      body: JSON.stringify(transmission),
      signal: controller.signal,
    })
    const text = await response.text()
    if (text.length > 2_800_000) throw new Error('La respuesta del conector supera el límite de 2 MB.')
    let body: unknown
    try { body = JSON.parse(text) } catch { throw new Error('El conector debe responder JSON con el contrato acordado.') }
    if (!response.ok) throw new Error('El conector respondió HTTP ' + response.status + '.')
    return parseCanonicalResponse(body, transmission.transmission_id)
  } finally {
    clearTimeout(timeout)
  }
}
