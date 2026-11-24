# Contrato de integración con el emisor externo

## FactuSaaS local

La API local está en `http://localhost:3002` y recibe emisiones en `POST /api/v1/comprobantes`. Su contrato se define en `back/factu-api/src/modules/comprobantes/comprobantes.schemas.js` y `comprobantes.routes.js` del repositorio FactuSaaS. El formato canónico de PuntoFactura que aparece más abajo es interno. El adaptador traducirá entre ambos formatos.

- La integración usa `X-Api-Key` del servidor e `Idempotency-Key` estable por operación. La emisión nueva normalmente regresa HTTP 202. Una repetición puede regresar HTTP 200 con el mismo `id` y `numero` y con el estado ya registrado.
- FactuSaaS exige el UUID `emisor_id`, identifica el tipo como `FACTURA`, `BOLETA`, `NOTA_CREDITO` o `NOTA_DEBITO` y genera su propio correlativo para la serie configurada. Guardar su identificador y número como referencias externas.
- Las notas usan `doc_ref_numero`, `doc_ref_tipo`, `codigo_motivo` y `motivo`. El número de referencia debe ser el de FactuSaaS. La solicitud acepta `valor_unitario` sin IGV, con afectación por ítem, y carece de un campo de descuento global. Antes de emitir, validar que el mapeo reproduce los importes locales. Si falta el código de motivo de una nota, solicitarlo en vez de asumirlo.
- El webhook contiene un sobre `{ evento, timestamp, data }`. En `webhook.dispatcher.js`, FactuSaaS calcula HMAC-SHA256 sobre el JSON completo en UTF-8 y envía `X-Factu-Signature: sha256=<digest hexadecimal>`. `X-Factu-Delivery` identifica la entrega. El receptor debe guardar las entregas válidas, incluso si todavía no recibió la respuesta del POST de emisión.
- PuntoFactura debe llamar al servicio desde su backend, persistir la solicitud antes de intentar enviarla y descargar los artefactos desde las rutas esperadas del comprobante. La API Key y el secreto del webhook deben configurarse en el entorno local del backend. Las respuestas con `es_simulado=true` se muestran como simuladas y quedan fuera del consumo real.

Para la primera integración hacen falta una API Key con permisos de emisión y lectura, el UUID y la serie del emisor local de prueba, y registrar el webhook de PuntoFactura con un secreto compartido. Antes de enviar, comprobar en `GET /health` que FactuSaaS responde `status=ok`, `env=development` y `simulacion_forzada=true`.

### Etapa 1 — Conexiones locales

La prueba de salida solo consulta `GET /health` y, cuando hay una API Key, lee como máximo un comprobante simulado mediante `GET /api/v1/comprobantes?limite=1&es_simulado=true`. Puede filtrar por el UUID del emisor. Esta consulta valida el permiso de lectura. El permiso de emisión se verifica al probar el POST en la siguiente etapa.

Configura estas variables en `.env.local`, usando [la plantilla del backend](../.env.example).

- `FACTUSAAS_BASE_URL` con `http://localhost:3002`.
- `FACTUSAAS_API_KEY` con una clave que tenga `comprobantes:leer` y `comprobantes:emitir`.
- `FACTUSAAS_EMISOR_UUID` con el UUID del emisor de pruebas registrado en FactuSaaS. Copia el valor de la ficha del emisor.
- `FACTUSAAS_WEBHOOK_SECRET` con el mismo secreto registrado en FactuSaaS.

En FactuSaaS, registra `http://127.0.0.1:3001/api/webhooks/factusaas` para los eventos `comprobante.aceptado`, `comprobante.observado` y `comprobante.rechazado`. La dirección debe ser accesible desde el proceso de FactuSaaS. El receptor valida la firma antes de interpretar el JSON y guarda la entrega en `factusaas_webhook_inbox`. Responde `202` a una entrega válida y `200` si ya existe. Si el webhook llega antes que la respuesta del POST, la entrega se conserva y se aplica cuando Punto Factura registra el identificador externo.

Aplica la migración con `npm.cmd run migrate`. Reinicia el backend de PuntoFactura para cargar el secreto y ejecuta `npm.cmd run factusaas:check`. La salida indica el estado de la API, el modo de simulación, la lectura autenticada y si el emisor y el secreto se configuraron. La comprobación no imprime las credenciales ni el comprobante que se consultó.

## Alcance

PuntoFactura registra el comprobante y su numeración. Un adaptador de servidor entregará el documento a la aplicación externa y normalizará su respuesta. El navegador nunca llama directamente a la aplicación externa ni guarda sus secretos.

La simulaci?n del proceso ya no est? disponible como acci?n en Punto Factura. Las pruebas unitarias validan las reglas del adaptador; la prueba de punta a punta usa FactuSaaS con simulaci?n forzada y se documenta en [pruebas locales](pruebas-locales-factusaas.md).

## Solicitud canónica, versión 1

El adaptador transmite JSON UTF-8 con `Content-Type: application/json` e `Idempotency-Key: <UUID del intento>`. Cada solicitud tiene un identificador nuevo. Repetir una solicitud con el mismo identificador debe devolver el resultado del mismo intento, nunca generar un segundo comprobante fiscal.

```json
{
  "schema_version": "puntofactura.transmission.v1",
  "transmission_id": "UUID del intento",
  "document_id": "UUID interno inmutable",
  "tenant_id": "UUID del negocio",
  "company_id": "UUID de la empresa",
  "issuer": {
    "ruc": "RUC emisor",
    "legal_name": "Razón social",
    "commercial_name": "Nombre comercial",
    "fiscal_address": "Dirección fiscal"
  },
  "document": {
    "type": "01 | 03 | 07 | 08",
    "series": "F001",
    "number": 1,
    "issue_date": "YYYY-MM-DD",
    "currency": "PEN",
    "customer": {
      "document_type": "6 | 1 | null",
      "document_number": "Documento o null",
      "name": "Nombre o razón social"
    },
    "payment_method": "Efectivo",
    "discount_percent": 0,
    "taxable_base": 10,
    "igv_rate": 18,
    "igv_amount": 1.8,
    "total": 11.8,
    "lines": [
      {
        "product_id": "UUID o null",
        "sku": "SKU",
        "description": "Detalle",
        "unit_code": "NIU",
        "quantity": 1,
        "unit_price": 11.8,
        "line_total": 11.8
      }
    ],
    "related_document": null,
    "note_reason": null
  }
}
```

Las notas 07 y 08 deben incluir tipo, serie, correlativo y fecha del original, además del motivo. El precio unitario y el total de línea usan IGV incluido. Los UUID identifican datos, pero no sustituyen el RUC ni la numeración fiscal.

## Respuesta canónica

El conector conserva la respuesta original en almacenamiento privado y normaliza el resultado a este contrato. `accepted` significa aceptación confirmada por la autoridad, no solo recepción HTTP por el proveedor.

```json
{
  "schema_version": "puntofactura.response.v1",
  "transmission_id": "UUID recibido",
  "status": "accepted | observed | rejected | failed",
  "external_reference": "Identificador del proveedor o envío",
  "authority_code": "Código devuelto, si existe",
  "message": "Mensaje legible",
  "observations": [],
  "errors": [],
  "cdr": { "file_name": "respuesta.zip", "content_base64": "..." },
  "raw": {}
}
```

`cdr` y `raw` pueden omitirse. El servidor validará tamaño y tipo del archivo antes de guardarlo. Credenciales, certificados y contraseñas nunca se incluyen en el contrato ni en la respuesta persistida como JSON público.

## Estados e idempotencia

El resultado normalizado se almacena por intento y conserva referencia externa, código, mensaje, observaciones y errores. Una aceptación incrementa el consumo una sola vez. Observado, rechazado o fallido permite un nuevo intento con otro `transmission_id`. Un documento aceptado no se vuelve a enviar desde el flujo común.

La autenticación entre PuntoFactura y el conector, sus cabeceras, rutas, límites, tiempos de espera, formato de XML/PDF/CDR y semántica exacta de estados quedan por definir con la documentación de la app externa.

## Datos que necesitamos para implementar el conector

- URL base y rutas por ambiente local, pruebas y producción.
- Ejemplo real anonimizado de solicitud y respuesta del API de tu app.
- Método de autenticación, rotación de secretos, IP permitidas y certificado requerido.
- Si el envío responde de forma inmediata o con un identificador que se consulta después.
- Definición de aceptación, observación, rechazo, reintento, anulación y comunicación de baja.
- Formato, codificación, tamaño y retención de XML, PDF, CDR y errores.
- Series/correlativos que la app externa espera recibir y quién conserva la autoridad final sobre numeración.
- Cómo correlacionar una respuesta asíncrona con el UUID de PuntoFactura y cómo autenticar webhooks.
