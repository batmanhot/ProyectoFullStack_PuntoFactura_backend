import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { actor, transaction } from '../database.mjs'
import { factuSaasConfig, isUuid } from './factusaas-connection.mjs'

const maxXmlBytes = 8 * 1024 * 1024

export function extractDocumentDigest(xml) {
  const signatures = [...xml.matchAll(/<(?:[\w.-]+:)?Signature\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Signature\s*>/gi)]
  const signedInfo = signatures.map(([, body]) => body.match(/<(?:[\w.-]+:)?SignedInfo\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?SignedInfo\s*>/i)?.[1]).find(Boolean)
  if (!signedInfo) throw new ServiceUnavailableException('El XML firmado no contiene la sección de firma esperada.')

  const references = [...signedInfo.matchAll(/<(?:[\w.-]+:)?Reference\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Reference\s*>/gi)]
  const documentReference = references.find(([, attributes]) => {
    const uri = attributes.match(/\bURI\s*=\s*(["'])(.*?)\1/i)
    return !uri || uri[2].trim() === ''
  })
  const digest = documentReference?.[2].match(/<(?:[\w.-]+:)?DigestValue\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?DigestValue\s*>/i)?.[1]
    ?.replace(/\s+/g, '')
  if (!digest || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(digest)) {
    throw new ServiceUnavailableException('No se encontró el valor resumen del comprobante en su XML firmado.')
  }
  return digest
}

export async function getFactuSaasDocumentDigest(user, tenantId, companyId, documentId) {
  const config = factuSaasConfig()
  if (!config.apiKey) throw new ServiceUnavailableException('FactuSaaS no está configurado para descargar el XML firmado.')

  const externalId = await transaction(async client => {
    await actor(client, user)
    const { rows: [membership] } = await client.query('select public.is_tenant_member($1) as allowed', [tenantId])
    if (!membership?.allowed) throw new ForbiddenException('El negocio no está disponible.')
    const { rows: [document] } = await client.query(
      `select transmission_response->>'external_reference' as external_id
       from public.electronic_documents where id=$1 and tenant_id=$2 and company_id=$3`,
      [documentId, tenantId, companyId])
    if (!document) throw new NotFoundException('Comprobante no disponible.')
    if (!isUuid(document.external_id)) throw new BadRequestException('FactuSaaS aún no tiene un XML firmado disponible para este comprobante.')
    return document.external_id
  })

  const url = new URL(`/api/v1/comprobantes/${externalId}/artefactos/xml-firmado`, config.origin)
  const response = await fetch(url, {
    headers: { 'X-Api-Key': config.apiKey, Accept: 'application/xml, text/xml, application/octet-stream' },
    redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  if (!response?.ok) throw new ServiceUnavailableException('No se pudo descargar el XML firmado desde FactuSaaS.')
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxXmlBytes) throw new ServiceUnavailableException('El XML firmado supera el tamaño permitido.')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > maxXmlBytes) throw new ServiceUnavailableException('El XML firmado está vacío o supera el tamaño permitido.')
  const contentType = response.headers.get('content-type') ?? ''
  if (!/xml|octet-stream/i.test(contentType)) throw new ServiceUnavailableException('FactuSaaS no devolvió un archivo XML firmado.')
  let xml
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') }
  catch { throw new ServiceUnavailableException('No se pudo leer el XML firmado en UTF-8.') }
  return { digestValue: extractDocumentDigest(xml) }
}
