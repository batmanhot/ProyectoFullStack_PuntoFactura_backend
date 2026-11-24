import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { actor, pool, requireAdmin, transaction } from './database.mjs'

const hash = token => createHash('sha256').update(token).digest('hex')
const dummyPassword = bcrypt.hashSync(randomBytes(32).toString('hex'), 12)
const sessionToken = request => request.headers.cookie?.split(';').map(value => value.trim())
  .find(value => /^pf_session=[a-f0-9]{64}$/.test(value))?.slice(11)

export async function session(request) {
  const token = sessionToken(request)
  if (!token) return null
  const { rows: [user] } = await pool.query(
    'select u.id,u.raw_app_meta_data as app_metadata from auth.sessions s join auth.users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at>now()',
    [hash(token)])
  return user ?? null
}

export async function authenticated(request, allowTemporary = false) {
  const user = await session(request)
  if (!user) throw new UnauthorizedException('Inicia sesión')
  if (!allowTemporary && user.app_metadata.must_change_password) throw new ForbiddenException('Primero cambia tu contraseña temporal')
  return user
}

function cookie(reply, token, maxAge) {
  const sameSite = process.env.COOKIE_SAME_SITE || 'Strict'
  const secure = process.env.NODE_ENV === 'production' || sameSite.toLowerCase() === 'none'
  reply.header('Set-Cookie', 'pf_session=' + token + '; HttpOnly; SameSite=' + sameSite + '; Path=/api; Max-Age=' + maxAge +
    (secure ? '; Secure' : ''))
}

export async function login(body, reply) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (typeof body.password !== 'string' || Buffer.byteLength(body.password) > 72) throw new UnauthorizedException('Credenciales incorrectas')
  const user = await transaction(async client => {
    const { rows: [account] } = await client.query('select * from auth.users where email=$1 for update', [email])
    const valid = await bcrypt.compare(body.password, account?.password_hash ?? dummyPassword)
    if (!valid || !account) throw new UnauthorizedException('Credenciales incorrectas')
    const token = randomBytes(32).toString('hex')
    await client.query('insert into auth.sessions values ($1,$2,now()+interval \'8 hours\')', [hash(token), account.id])
    cookie(reply, token, 8 * 3600)
    return { id: account.id, app_metadata: account.raw_app_meta_data }
  })
  return { user }
}

export async function logout(request, reply) {
  const token = sessionToken(request)
  if (token) await pool.query('delete from auth.sessions where token_hash=$1', [hash(token)])
  cookie(reply, '', 0)
  return { success: true }
}

async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new BadRequestException('Usa una contraseña de al menos 12 caracteres y hasta 72 bytes')
  }
  return bcrypt.hash(password, 12)
}

const text = value => typeof value === 'string' ? value.trim() : ''
async function createAccount(client, email, name, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) throw new BadRequestException('Revisa el correo y el nombre')
  const { rows: [account] } = await client.query(
    'insert into auth.users(email,password_hash,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3,$4) returning id',
    [email, password, { name }, { must_change_password: true }])
  return account.id
}

export async function provision(user, body) {
  const name = text(body.displayName)
  const legalName = text(body.legalName)
  const email = text(body.adminEmail).toLowerCase()
  const ruc = text(body.ruc)
  if (!name || !legalName || !/^\d{11}$/.test(ruc)) throw new BadRequestException('Completa el negocio, la razón social y el RUC')
  return transaction(async client => {
    await requireAdmin(client, user)
    const id = await createAccount(client, email, text(body.ownerName), await passwordHash(body.temporaryPassword))
    await actor(client, user, 'service_role')
    const slug = 'negocio-' + randomUUID()
    const { rows: [row] } = await client.query('select public.provision_business($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id',
      [slug, name, text(body.planCode), ruc, legalName, id, user.id, email, text(body.fiscalAddress) || null, text(body.expiresOn) || null])
    return { tenantId: row.id }
  })
}

export async function manageAccount(user, body) {
  return transaction(async client => {
    if (body.action === 'change-password') {
      const { rows: [account] } = await client.query('select * from auth.users where id=$1 for update', [user.id])
      const current = body.currentPassword
      if (!account.raw_app_meta_data.must_change_password || typeof current !== 'string' ||
        Buffer.byteLength(current) > 72 || current === body.password || !await bcrypt.compare(current, account.password_hash)) {
        throw new BadRequestException('Revisa la contraseña temporal y usa una contraseña nueva')
      }
      await client.query("update auth.users set password_hash=$2,raw_app_meta_data='{}' where id=$1", [user.id, await passwordHash(body.password)])
      await client.query('delete from auth.sessions where user_id=$1', [user.id])
      return { success: true }
    }
    await requireAdmin(client, user)
    if (body.action === 'create') {
      if (!['admin','seller','accountant','viewer'].includes(body.role)) throw new BadRequestException('Rol inválido')
      const id = await createAccount(client, text(body.email).toLowerCase(), text(body.name), await passwordHash(body.password))
      await actor(client, user, 'service_role')
      await client.query('select public.add_tenant_member($1,$2,$3,$4)', [body.tenantId, id, user.id, body.role])
      return { id }
    }
    await actor(client, user)
    const { rows: [permission] } = await client.query(
      'select public.can_manage_account($1,$2) as allowed',
      [body.tenantId, body.userId])
    if (!permission.allowed) throw new ForbiddenException('Cuenta fuera del negocio')
    await client.query('reset role')
    if (body.action === 'edit' && text(body.name)) {
      await client.query('update auth.users set raw_user_meta_data=$2 where id=$1', [body.userId, { name: text(body.name) }])
    } else if (body.action === 'reset') {
      await client.query('update auth.users set password_hash=$2,raw_app_meta_data=$3 where id=$1',
        [body.userId, await passwordHash(body.password), { must_change_password: true }])
      await client.query('delete from auth.sessions where user_id=$1', [body.userId])
      await actor(client, user, 'service_role')
      await client.query('select public.audit_managed_password_reset($1,$2)', [body.tenantId,body.userId])
    } else throw new BadRequestException('Acción o datos inválidos')
    return { success: true }
  })
}
