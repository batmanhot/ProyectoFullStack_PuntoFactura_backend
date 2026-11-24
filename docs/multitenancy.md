# Backend de PuntoFactura

## Autenticación y acceso

La API NestJS administra las identidades y las sesiones de PostgreSQL. `platform_admins` habilita el portal de SuperAdmin y `tenant_memberships` identifica el negocio y el rol del usuario. RLS verifica identidad, membresía activa y vigencia de la suscripción. La fecha de vencimiento es el primer día sin acceso, según la hora de Lima. La interfaz avisa desde cinco días antes.

`POST /api/platform/businesses` crea el propietario con contraseña temporal y provisiona negocio, RUC, sucursal, series y suscripción. `POST /api/accounts` crea usuarios adicionales, restablece claves y verifica el cambio de contraseña. La marca de cambio obligatorio vive en los metadatos administrados por el servidor y bloquea las operaciones del negocio hasta que se actualiza la clave. El cupo se comprueba en la base al agregar o reactivar miembros.

## Registro y stock

`register_document` recibe tenant, empresa, serie, UUID de solicitud y datos del comprobante. El detalle usa SKU, cantidad y precio unitario con IGV incluido. La función toma el IGV de la plataforma o del comprobante de referencia, calcula los importes y guarda una copia del detalle. Las notas requieren motivo y referencia a una factura o boleta de la misma empresa.

Un reintento con el mismo UUID y datos devuelve el documento registrado. La numeración, el saldo de los productos controlados y la auditoría se guardan junto al comprobante. Si el saldo es insuficiente, la transacción se revierte. El stock es por sucursal y producto. `set_product_stock` registra el nuevo saldo, la diferencia y el motivo. Las notas no implican por sí mismas un movimiento físico.

## Suscripciones

SuperAdmin asigna planes, modifica sus reglas y registra renovaciones manuales. La vigencia se extiende desde la fecha mayor entre hoy y el último vencimiento. Los planes mensuales extienden un mes y los anuales, un año. La renovación lleva importe, fecha, referencia y usuario responsable.

## Entrega futura a la app externa

El estado `registered` indica registro en PuntoFactura. Las columnas de referencia externa, respuesta y archivos están reservadas para la fase de conexión. Los cambios de estado de envío y los incrementos de consumo deben provenir de un proceso autorizado. El contrato con la aplicación externa y la interpretación de sus resultados se acuerdan una vez que se disponga del contrato real y del entorno de pruebas de la app externa.
