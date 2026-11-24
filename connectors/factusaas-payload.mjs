import { BadRequestException } from '@nestjs/common'

const types = { '01': 'FACTURA', '03': 'BOLETA', '07': 'NOTA_CREDITO', '08': 'NOTA_DEBITO' }
const creditNoteCodes = new Set(['01','02','03','04','05','06','07','08','09','10','11','12','13'])
const debitNoteCodes = new Set(['01','02','03'])

export function buildFactuSaasPayload(document, emitterId, original = null) {
  const tipoComprobante = types[document.document_type]
  if (!tipoComprobante) throw new BadRequestException('Tipo de comprobante no compatible.')
  const noteReasonCode = document.registration_request?.data?.note_reason_code
  const isCreditNote = document.document_type === '07'
  const isDebitNote = document.document_type === '08'
  if (isCreditNote && !creditNoteCodes.has(noteReasonCode)) throw new BadRequestException('Selecciona un codigo valido del Catalogo 09 para la nota de credito.')
  if (isDebitNote && !debitNoteCodes.has(noteReasonCode)) throw new BadRequestException('Selecciona un codigo valido del Catalogo 10 para la nota de debito.')
  if ((isCreditNote || isDebitNote) && !original?.external_number) throw new BadRequestException('El comprobante original aun no tiene numero de FactuSaaS.')

  const discountMultiplier = 1 - Number(document.discount_rate || 0) / 100
  const igvMultiplier = 1 + Number(document.igv_rate) / 100
  return {
    emisor_id: emitterId,
    tipo_comprobante: tipoComprobante,
    serie: document.series,
    fecha_emision: document.issue_date,
    moneda: 'PEN',
    tipo_doc_receptor: document.customer_document?.length === 11 ? '6' : document.customer_document?.length === 8 ? '1' : undefined,
    num_doc_receptor: document.customer_document || undefined,
    razon_receptor: document.customer_name,
    direccion_receptor: undefined,
    email_receptor: undefined,
    ...((isCreditNote || isDebitNote) ? {
      doc_ref_numero: original.external_number,
      doc_ref_tipo: original.document_type,
      codigo_motivo: noteReasonCode,
      motivo: document.note_reason,
    } : {}),
    items: document.lines.map(line => {
      const affectation = line.igv_affectation_code || '10'
      const taxMultiplier = affectation === '10' ? igvMultiplier : 1
      return {
        codigo: line.product_sku || undefined,
        descripcion: line.name,
        unidad_medida: line.unit_code || 'NIU',
        cantidad: Number(line.quantity),
        valor_unitario: Number((Number(line.unit_price) * discountMultiplier / taxMultiplier).toFixed(6)),
        tipo_afectacion_igv: affectation,
      }
    }),
  }
}
