import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

process.env.DATABASE_URL ??= 'postgresql://localhost/puntofactura_test'
const { responseFor, signatureMatches } = await import('../connectors/factusaas-webhook.mjs')

test('validates the HMAC against the exact original JSON bytes', () => {
  const secret = 'local-webhook-secret'
  const body = Buffer.from('{"evento":"comprobante.aceptado","data":{"es_simulado":true}}', 'utf8')
  const digest = createHmac('sha256', secret).update(body).digest('hex')
  assert.equal(signatureMatches(body, 'sha256=' + digest, secret), true)
  assert.equal(signatureMatches(Buffer.from(body.toString() + ' '), 'sha256=' + digest, secret), false)
  assert.equal(signatureMatches(body, 'sha256=' + digest, 'wrong-secret'), false)
  assert.equal(signatureMatches(body, 'bad-signature', secret), false)
  assert.equal(signatureMatches('not-a-buffer', 'sha256=' + digest, secret), false)
})

test('normalizes FactuSaaS results and retains simulated status and observations', () => {
  const response = responseFor({ id: 'transmission-1' }, {
    evento: 'comprobante.observado',
    data: {
      comprobante_id: '9e09f0e1-647d-43b7-8e0f-26832b75f4d9',
      numero: 'B001-00000001', es_simulado: true,
      sunat_response_code: 'SIM-OBS', descripcion: 'Revisar el documento',
      observaciones: ['Observación de prueba', { codigo: 'X1' }],
    },
  })
  assert.equal(response.status, 'observed')
  assert.equal(response.source, 'factusaas')
  assert.equal(response.es_simulado, true)
  assert.equal(response.external_number, 'B001-00000001')
  assert.deepEqual(response.observations, ['Observación de prueba', '{"codigo":"X1"}'])
})

test('maps each supported notification into a Punto Factura state', () => {
  const attempt = { id: 'transmission-2' }
  const id = '9e09f0e1-647d-43b7-8e0f-26832b75f4d9'
  for (const [evento, expected] of [
    ['comprobante.aceptado', 'accepted'],
    ['comprobante.observado', 'observed'],
    ['comprobante.rechazado', 'rejected'],
  ]) {
    assert.equal(responseFor(attempt, { evento, data: { comprobante_id: id } }).status, expected)
  }
})
