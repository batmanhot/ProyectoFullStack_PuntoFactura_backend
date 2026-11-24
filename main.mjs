import 'reflect-metadata'
import { BadRequestException, Body, Controller, Get, Module, Param, Post, Query, Req, Res } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { authenticated, login, logout, manageAccount, provision, session } from './accounts.mjs'
import { businessData, factuSaasConnectionStatus, findDocument, operate, platformData, saveCatalog } from './business.mjs'
import { pool } from './database.mjs'
import { registerFactuSaasWebhook } from './connectors/factusaas-webhook.mjs'
import { sendFactuSaasDocument } from './connectors/send-factusaas.mjs'
import { getFactuSaasDocumentDigest } from './connectors/factusaas-qr.mjs'

try {
  await pool.query('select 1')
} catch {
  console.error('PostgreSQL no está disponible. En local, inicia Docker Desktop y ejecuta "npm.cmd run local" desde la carpeta backend.')
  await pool.end()
  process.exit(1)
}

function json(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Se esperaba un objeto JSON')
  return body
}

class AuthController {
  async health() { await pool.query('select 1'); return { status: 'ok' } }
  async current(request) { return { user: await session(request) } }
  async login(request, reply, body) { return login(json(body), reply) }
  async logout(request, reply) { return logout(request, reply) }
}
class WorkspaceController {
  async platform(request) { return platformData(await authenticated(request)) }
  async business(request, tenant, company) { return businessData(await authenticated(request), tenant, company) }
  async factusaasStatus(request, tenant) { return factuSaasConnectionStatus(await authenticated(request), tenant) }
  async original(request, tenant, company, series, number) {
    return findDocument(await authenticated(request), tenant, company, series, number)
  }
  async catalog(request, tenant, company, kind, body) {
    return saveCatalog(await authenticated(request), tenant, company, kind, json(body))
  }
  async operation(request, name, body) { return operate(await authenticated(request), name, json(body)) }
  async provision(request, body) { return provision(await authenticated(request), json(body)) }
  async accounts(request, body) { return manageAccount(await authenticated(request, true), json(body)) }
  async sendDocument(request, tenant, company, document) {
    return sendFactuSaasDocument(await authenticated(request), tenant, company, document)
  }
  async documentQrData(request, tenant, company, document) {
    return getFactuSaasDocumentDigest(await authenticated(request), tenant, company, document)
  }
}

// Apply Nest metadata directly to keep the Node server independent of frontend compiler settings.
function route(controller, method, decorator, parameters = []) {
  const prototype = controller.prototype
  decorator(prototype, method, Object.getOwnPropertyDescriptor(prototype, method))
  parameters.forEach((parameter, index) => parameter(prototype, method, index))
}
Controller()(AuthController)
route(AuthController, 'health', Get('health'))
route(AuthController, 'current', Get('auth/session'), [Req()])
route(AuthController, 'login', Post('auth/login'), [Req(), Res({ passthrough: true }), Body()])
route(AuthController, 'logout', Post('auth/logout'), [Req(), Res({ passthrough: true })])
Controller()(WorkspaceController)
route(WorkspaceController, 'platform', Get('platform'), [Req()])
route(WorkspaceController, 'business', Get('business/:tenant'), [Req(), Param('tenant'), Query('company')])
route(WorkspaceController, 'factusaasStatus', Get('business/:tenant/factusaas-status'), [Req(), Param('tenant')])
route(WorkspaceController, 'original', Get('business/:tenant/companies/:company/original'), [Req(), Param('tenant'), Param('company'), Query('series'), Query('number')])
route(WorkspaceController, 'catalog', Post('business/:tenant/companies/:company/catalog/:kind'), [Req(), Param('tenant'), Param('company'), Param('kind'), Body()])
route(WorkspaceController, 'operation', Post('operations/:name'), [Req(), Param('name'), Body()])
route(WorkspaceController, 'provision', Post('platform/businesses'), [Req(), Body()])
route(WorkspaceController, 'accounts', Post('accounts'), [Req(), Body()])
route(WorkspaceController, 'sendDocument', Post('business/:tenant/companies/:company/documents/:document/transmit'), [Req(), Param('tenant'), Param('company'), Param('document')])
route(WorkspaceController, 'documentQrData', Get('business/:tenant/companies/:company/documents/:document/qr-data'), [Req(), Param('tenant'), Param('company'), Param('document')])
class AppModule {}
Module({ controllers: [AuthController, WorkspaceController] })(AppModule)
const adapter = new FastifyAdapter({ bodyLimit: 256_000 })
const frontendOrigins = new Set((process.env.FRONTEND_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174')
  .split(',').map(origin => origin.trim()).filter(Boolean))
adapter.getInstance().addHook('onRequest', async (request, reply) => {
  reply.header('Cache-Control', 'no-store')
  const origin = request.headers.origin
  if (origin && !frontendOrigins.has(origin)) {
    return reply.code(403).send({ message: 'Origen no autorizado' })
  }
  if (origin) {
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Access-Control-Allow-Credentials', 'true')
    reply.header('Vary', 'Origin')
  }
  if (request.method === 'OPTIONS') {
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type')
    return reply.code(204).send()
  }
  if (request.headers['sec-fetch-site'] === 'cross-site' && !origin) {
    return reply.code(403).send({ message: 'Origen inválido' })
  }
})
const app = await NestFactory.create(AppModule, adapter)
adapter.getInstance().register(registerFactuSaasWebhook)
app.setGlobalPrefix('api')
app.enableShutdownHooks()
await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1')
