# Pruebas locales de FactuSaaS

La integración de esta etapa envía cada comprobante una vez a FactuSaaS y muestra su recepción y el estado que notifique. FactuSaaS controla el proceso SUNAT. Las pruebas deben usar únicamente FactuSaaS local con simulación forzada; no validan envíos reales a SUNAT.

## Pruebas unitarias

Desde `backend/`:

```powershell
npm.cmd test
```

Cubren validación de URL y UUID del emisor, verificación del ambiente simulado, lectura autenticada, firma HMAC y normalización de estados.

## Preparar el recorrido de punta a punta

1. Inicia PostgreSQL y Punto Factura con `npm.cmd run dev`.
2. Inicia FactuSaaS local y confirma que `GET http://localhost:3002/health` devuelve `status=ok`, `env=development` y `simulacion_forzada=true`.
3. Ejecuta `npm.cmd run factusaas:check`. Debe indicar `health=ok`, `simulatedDevelopment=true`, `apiKeyRead=ok`, `webhookSecretConfigured=true` y `emitterConfigured=true`.
4. Registra en FactuSaaS el webhook `http://127.0.0.1:3001/api/webhooks/factusaas` para los eventos `comprobante.aceptado`, `comprobante.observado` y `comprobante.rechazado`. Confirma que FactuSaaS puede alcanzar el puerto 3001 y que el secreto coincide con `FACTUSAAS_WEBHOOK_SECRET` de `backend/.env.local`.
5. Usa un negocio local de pruebas con una cuenta de propietario o administrador, una serie activa de boleta y un producto con precio mayor que cero y control de stock desactivado. Cambia la contraseña temporal antes de ejecutar la prueba.
6. En Punto Factura, activa **Enviar automáticamente a FactuSaaS** para el negocio. Este interruptor también habilita el envío manual desde el detalle.

## Ejecutar una emisión simulada de punta a punta

El recorrido registra una boleta local, la envía al servicio simulado, espera el webhook y valida el estado, número y marca `SIMULADO`. Crea un comprobante de prueba persistente y una aceptación simulada puede incrementar el consumo del plan local. Usa un negocio de pruebas.

En PowerShell, desde `backend/`, define las variables de la sesión con las credenciales del usuario de pruebas y el UUID del negocio. No escribas API Keys ni secretos en estos valores:

```powershell
$env:PUNTOFACTURA_E2E_ALLOW_SEND = 'SIMULATED_ONLY'
$env:PUNTOFACTURA_E2E_TENANT_ID = '<UUID del negocio de pruebas>'
$env:PUNTOFACTURA_E2E_EMAIL = '<correo del usuario de pruebas>'
$env:PUNTOFACTURA_E2E_PASSWORD = '<contraseña vigente del usuario de pruebas>'
npm.cmd run test:e2e
```

El script se detiene si FactuSaaS no confirma simulación forzada, si el negocio no tiene el interruptor habilitado, si faltan datos de prueba o si no recibe el webhook final en 30 segundos. Informa el número local/externo, estado y mensaje, nunca las credenciales.

## Resultado esperado

- `result: "ok"` y `simulated: true`.
- El comprobante aparece en la bandeja del negocio con estado `Aceptado · SIMULADO` en el flujo normal de simulación forzada.
- `webhookReceived: true` y un número externo de FactuSaaS.
- No se descargan XML/CDR ni se prueba SUNAT real en este alcance.
