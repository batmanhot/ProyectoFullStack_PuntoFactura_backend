import { checkFactuSaas } from './factusaas-connection.mjs'

try {
  const result = await checkFactuSaas()
  console.log(JSON.stringify(result, null, 2))
  if (!result.simulatedDevelopment || result.apiKeyRead !== 'ok' || !result.webhookSecretConfigured || !result.emitterConfigured) process.exitCode = 1
} catch {
  console.error('Configuración inválida. Revisa FACTUSAAS_BASE_URL y FACTUSAAS_EMISOR_UUID.')
  process.exitCode = 1
}
