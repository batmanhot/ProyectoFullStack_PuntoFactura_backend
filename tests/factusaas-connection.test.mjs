import test from 'node:test'
import assert from 'node:assert/strict'
import { checkFactuSaas, factuSaasConfig } from '../connectors/factusaas-connection.mjs'

const emitter = '7ce9a89a-e3ae-41a7-9c21-001122334455'
const env = {
  FACTUSAAS_BASE_URL: 'http://localhost:3002',
  FACTUSAAS_EMISOR_UUID: emitter,
  FACTUSAAS_API_KEY: 'test-api-key',
  FACTUSAAS_WEBHOOK_SECRET: 'test-webhook-secret',
}

test('accepts a local FactuSaaS URL and a valid emitter UUID', () => {
  const config = factuSaasConfig(env)
  assert.equal(config.origin.origin, 'http://localhost:3002')
  assert.equal(config.emitterId, emitter)
})

test('rejects remote or credential-bearing FactuSaaS URLs', () => {
  assert.throws(() => factuSaasConfig({ ...env, FACTUSAAS_BASE_URL: 'https://api.example.com' }))
  assert.throws(() => factuSaasConfig({ ...env, FACTUSAAS_BASE_URL: 'http://user:pass@localhost:3002' }))
  assert.throws(() => factuSaasConfig({ ...env, FACTUSAAS_EMISOR_UUID: '20608473912' }))
})

test('checks forced simulation and authenticates a read without exposing credentials', async () => {
  const calls = []
  const result = await checkFactuSaas(env, async (url, options = {}) => {
    calls.push({ url: new URL(url), options })
    return calls.length === 1
      ? Response.json({ status: 'ok', env: 'development', simulacion_forzada: true })
      : Response.json({ data: [] })
  })
  assert.deepEqual(result, {
    health: 'ok', simulatedDevelopment: true, apiKeyRead: 'ok',
    webhookSecretConfigured: true, emitterConfigured: true,
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.headers['X-Api-Key'], 'test-api-key')
  assert.equal(calls[1].url.searchParams.get('emisor_id'), emitter)
  assert.equal(calls[0].options.headers, undefined)
})

test('does not read comprobantes unless forced simulation is confirmed', async () => {
  const calls = []
  const result = await checkFactuSaas(env, async (_url, options) => {
    calls.push(options)
    return Response.json({ status: 'ok', env: 'production', simulacion_forzada: false })
  })
  assert.equal(result.simulatedDevelopment, false)
  assert.equal(result.apiKeyRead, 'not_run')
  assert.equal(calls.length, 1)
})

test('reports a missing API key without making an authenticated request', async () => {
  let calls = 0
  const result = await checkFactuSaas({ ...env, FACTUSAAS_API_KEY: '' }, async () => {
    calls++
    return Response.json({ status: 'ok', env: 'development', simulacion_forzada: true })
  })
  assert.equal(result.apiKeyRead, 'missing_key')
  assert.equal(calls, 1)
})
