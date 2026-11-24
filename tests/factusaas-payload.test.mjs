import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFactuSaasPayload } from '../connectors/factusaas-payload.mjs'

const emitter = '7ce9a89a-e3ae-41a7-9c21-001122334455'
const document = overrides => ({
  document_type: '03', series: 'B001', issue_date: '2026-11-23',
  customer_document: '87654321', customer_name: 'Cliente de prueba',
  igv_rate: 18, discount_rate: 0, lines: [{ product_sku: 'SKU-01', name: 'Producto', unit_code: 'NIU', quantity: 2, unit_price: 118 }],
  registration_request: { data: {} }, ...overrides,
})

test('maps a boleta and sends prices without IGV', () => {
  const payload = buildFactuSaasPayload(document({}), emitter)
  assert.equal(payload.emisor_id, emitter)
  assert.equal(payload.tipo_comprobante, 'BOLETA')
  assert.equal(payload.tipo_doc_receptor, '1')
  assert.equal(payload.items[0].valor_unitario, 100)
  assert.equal(payload.items[0].cantidad, 2)
})

test('distributes the document discount proportionally into FactuSaaS item prices', () => {
  const payload = buildFactuSaasPayload(document({ discount_rate: 10 }), emitter)
  assert.equal(payload.items[0].valor_unitario, 90)
})

test('requires and maps a SUNAT credit note code and the original FactuSaaS number', () => {
  const creditNote = document({
    document_type: '07', registration_request: { data: { note_reason_code: '02' } }, note_reason: 'RUC incorrecto',
  })
  assert.throws(() => buildFactuSaasPayload(creditNote, emitter), /original aun no tiene numero/)
  const payload = buildFactuSaasPayload(creditNote, emitter, { document_type: '03', external_number: 'B001-00000017' })
  assert.equal(payload.tipo_comprobante, 'NOTA_CREDITO')
  assert.equal(payload.doc_ref_tipo, '03')
  assert.equal(payload.doc_ref_numero, 'B001-00000017')
  assert.equal(payload.codigo_motivo, '02')
})

test('validates debit note codes and preserves the linked invoice reference', () => {
  const debitNote = document({ document_type: '08', registration_request: { data: { note_reason_code: '03' } }, note_reason: 'Penalidad',
    related_document_id: 'original' })
  assert.equal(buildFactuSaasPayload(debitNote, emitter, { document_type: '01', external_number: 'F001-00000011' }).codigo_motivo, '03')
  assert.throws(() => buildFactuSaasPayload({ ...debitNote, registration_request: { data: { note_reason_code: '13' } } }, emitter,
    { document_type: '01', external_number: 'F001-00000011' }), /Catalogo 10/)
})
