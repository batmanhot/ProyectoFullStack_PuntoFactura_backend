import { createClient } from 'npm:@supabase/supabase-js@2'

const url = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const headers = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? 'http://localhost:5173',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
  Vary: 'Origin',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const validPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 12 && new TextEncoder().encode(value).length <= 72

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Inicia sesión' }, 401)
  const caller = createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } })
  const service = createClient(url, serviceKey, options)
  const { data: { user }, error: authError } = await caller.auth.getUser(authorization.slice(7))
  if (authError || !user) return json({ error: 'Sesión inválida' }, 401)
  let body: Record<string, unknown>
  try {
    body = await request.json()
    if (!body || typeof body !== 'object') throw new Error()
  } catch { return json({ error: 'Solicitud inválida' }, 400) }

  if (body.action === 'change-password') {
    if (!user.app_metadata.must_change_password || !user.email || typeof body.currentPassword !== 'string'
      || !validPassword(body.password) || body.password === body.currentPassword) {
      return json({ error: 'Ingresa la contraseña temporal y una contraseña nueva de 12 caracteres como mínimo (máximo 72 bytes).' }, 400)
    }
    const verifier = createClient(url, anonKey, options)
    const { data, error } = await verifier.auth.signInWithPassword({ email: user.email, password: body.currentPassword })
    if (error || data.user?.id !== user.id) return json({ error: 'La contraseña temporal es incorrecta' }, 400)
    const { error: updateError } = await service.auth.admin.updateUserById(user.id, {
      password: body.password, app_metadata: { must_change_password: false, login_after: Math.floor(Date.now() / 1000) + 1 },
    })
    if (updateError) return json({ error: updateError.message }, 400)
    return json({ success: true })
  }

  const { data: isAdmin, error: roleError } = await caller.rpc('is_superadmin')
  if (roleError || !isAdmin) return json({ error: 'Acceso reservado a SuperAdmin' }, 403)
  if (typeof body.tenantId !== 'string' || !uuid.test(body.tenantId)) return json({ error: 'Negocio inválido' }, 400)

  if (body.action === 'create') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || !validPassword(body.password)
      || typeof body.role !== 'string' || !['admin', 'seller', 'accountant', 'viewer'].includes(body.role)) {
      return json({ error: 'Revisa nombre, correo, rol y contraseña temporal.' }, 400)
    }
    const { data, error } = await service.auth.admin.createUser({
      email, password: body.password, email_confirm: true,
      user_metadata: { name }, app_metadata: { must_change_password: true },
    })
    if (error || !data.user) return json({ error: error?.message ?? 'No se pudo crear el usuario' }, 400)
    const { error: memberError } = await service.rpc('add_tenant_member', {
      p_tenant_id: body.tenantId, p_member_user_id: data.user.id, p_actor_user_id: user.id, p_role: body.role,
    })
    if (memberError) {
      const { error: cleanupError } = await service.auth.admin.deleteUser(data.user.id)
      if (cleanupError) return json({ error: 'El alta no se completó. Revisa la cuenta en Supabase Auth.' }, 500)
      return json({ error: memberError.message }, 400)
    }
    return json({ id: data.user.id }, 201)
  }

  if (body.action !== 'reset' && body.action !== 'edit') return json({ error: 'Acción inválida' }, 400)
  if (typeof body.userId !== 'string' || !uuid.test(body.userId)) return json({ error: 'Usuario inválido' }, 400)
  const { data: member, error: memberError } = await service.from('tenant_memberships').select('user_id')
    .eq('tenant_id', body.tenantId).eq('user_id', body.userId).maybeSingle()
  if (memberError || !member) return json({ error: 'Usuario fuera del negocio' }, 404)
  const { data: adminRecord, error: adminError } = await service.from('platform_admins')
    .select('user_id').eq('user_id', body.userId).maybeSingle()
  if (adminError || adminRecord) return json({ error: 'La cuenta no puede administrarse desde el negocio' }, 403)

  if (body.action === 'edit') {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: 'Ingresa el nombre del usuario' }, 400)
    const { error } = await service.auth.admin.updateUserById(body.userId, { user_metadata: { name } })
    return error ? json({ error: error.message }, 400) : json({ success: true })
  }
  if (!validPassword(body.password)) return json({ error: 'La contraseña temporal debe tener al menos 12 caracteres y como máximo 72 bytes' }, 400)
  const { error } = await service.auth.admin.updateUserById(body.userId, {
    password: body.password, app_metadata: { must_change_password: true },
  })
  if (error) return json({ error: error.message }, 400)
  const { error: auditError } = await service.from('tenant_audit_log').insert({
    tenant_id: body.tenantId, actor_user_id: user.id, action: 'tenant.member_password_reset',
    resource_type: 'membership', resource_id: body.userId,
  })
  return json({ success: true, auditRecorded: !auditError })
})
