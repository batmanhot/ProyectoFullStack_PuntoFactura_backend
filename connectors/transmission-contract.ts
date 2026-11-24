export type CanonicalTransmission = {
  schema_version: 'puntofactura.transmission.v1'
  transmission_id: string
  document_id: string
  tenant_id: string
  company_id: string
  issuer: {
    ruc: string
    legal_name: string
    commercial_name: string | null
    fiscal_address: string | null
  }
  document: {
    type: '01' | '03' | '07' | '08'
    series: string
    number: number
    issue_date: string
    currency: string
    customer: { document_type: '6' | '1' | null; document_number: string | null; name: string }
    payment_method: string
    discount_percent: number
    taxable_base: number
    igv_rate: number
    igv_amount: number
    total: number
    lines: Array<{
      product_id: string
      sku: string
      description: string
      unit_code: string
      quantity: number
      unit_price: number
      line_total: number
    }>
    related_document: { type: string; series: string; number: number; issue_date: string } | null
    note_reason: string | null
  }
}

export type CanonicalTransmissionResponse = {
  schema_version: 'puntofactura.response.v1'
  transmission_id: string
  status: 'accepted' | 'observed' | 'rejected' | 'failed'
  external_reference: string | null
  authority_code: string | null
  message: string
  observations: unknown[]
  errors: unknown[]
  cdr?: { file_name: string; content_base64: string }
  raw?: unknown
}

export function parseCanonicalResponse(value: unknown, transmissionId: string): CanonicalTransmissionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La respuesta debe ser un objeto JSON.')
  const response = value as Record<string, unknown>
  if (response.schema_version !== 'puntofactura.response.v1') throw new Error('Versión de respuesta no compatible.')
  if (response.transmission_id !== transmissionId) throw new Error('El ID de intento de la respuesta no coincide.')
  if (!['accepted', 'observed', 'rejected', 'failed'].includes(String(response.status))) {
    throw new Error('El estado recibido no está reconocido.')
  }
  if (typeof response.message !== 'string' || response.message.length > 4000) throw new Error('El mensaje de respuesta no es válido.')
  if (typeof response.external_reference === 'string' && response.external_reference.length > 250) throw new Error('La referencia externa supera 250 caracteres.')
  if (typeof response.authority_code === 'string' && response.authority_code.length > 100) throw new Error('El código de autoridad supera 100 caracteres.')
  const collection = (input: unknown, label: string) => {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > 100) throw new Error(label + ' debe ser una lista de hasta 100 elementos.')
    return input
  }
  if (response.cdr !== undefined) {
    if (!response.cdr || typeof response.cdr !== 'object' || Array.isArray(response.cdr)) throw new Error('El CDR no es válido.')
    const cdr = response.cdr as Record<string, unknown>
    if (typeof cdr.file_name !== 'string' || cdr.file_name.length > 255 || typeof cdr.content_base64 !== 'string'
      || cdr.content_base64.length > 2_800_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cdr.content_base64)) {
      throw new Error('El nombre o contenido del CDR no es válido o supera el límite local de 2 MB.')
    }
  }
  return {
    schema_version: 'puntofactura.response.v1',
    transmission_id: transmissionId,
    status: response.status as CanonicalTransmissionResponse['status'],
    external_reference: typeof response.external_reference === 'string' ? response.external_reference : null,
    authority_code: typeof response.authority_code === 'string' ? response.authority_code : null,
    message: response.message,
    observations: collection(response.observations, 'Observations'),
    errors: collection(response.errors, 'Errors'),
    ...(response.cdr === undefined ? {} : { cdr: response.cdr as CanonicalTransmissionResponse['cdr'] }),
    ...(response.raw === undefined ? {} : { raw: response.raw }),
  }
}
