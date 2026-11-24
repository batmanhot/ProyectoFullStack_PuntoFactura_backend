import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const appOrigin = Deno.env.get('APP_ORIGIN') ?? 'http://localhost:5173'

const corsHeaders = {
  'Access-Control-Allow-Origin': appOrigin,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function slugify(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: authData, error: authError } = await callerClient.auth.getUser(authorization.slice(7))
  if (authError || !authData.user) return json({ error: 'Invalid session' }, 401)

  const { data: platformRole, error: roleError } = await callerClient.rpc('is_superadmin')
  if (roleError || !platformRole) return json({ error: 'Platform administrator access required' }, 403)

  let body: Record<string, unknown>
  try {
    body = await request.json()
    if (!body || typeof body !== 'object') throw new Error()
  } catch { return json({ error: 'Invalid JSON body' }, 400) }

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  const legalName = typeof body.legalName === 'string' ? body.legalName.trim() : ''
  const ruc = typeof body.ruc === 'string' ? body.ruc.trim() : ''
  const adminEmail = typeof body.adminEmail === 'string' ? body.adminEmail.trim().toLowerCase() : ''
  const planCode = typeof body.planCode === 'string' ? body.planCode.trim() : ''
  const fiscalAddress = typeof body.fiscalAddress === 'string' ? body.fiscalAddress.trim() : null
  const temporaryPassword = typeof body.temporaryPassword === 'string' ? body.temporaryPassword : ''
  const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : ''
  if (!ownerName || temporaryPassword.length < 12 || new TextEncoder().encode(temporaryPassword).length > 72) {
    return json({ error: 'Ingresa el nombre y una contraseña temporal de 12 caracteres como mínimo (máximo 72 bytes).' }, 400)
  }

  if (!displayName || !legalName || !/^[0-9]{11}$/.test(ruc) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return json({ error: 'Business name, legal name, 11-digit RUC and valid admin email are required' }, 400)
  }

  const { data: plan, error: planError } = await serviceClient
    .from('service_plans').select('code').eq('code', planCode).eq('is_active', true).maybeSingle()
  if (planError || !plan) return json({ error: 'Selected service plan is unavailable' }, 400)

  const { data: existingCompany, error: rucLookupError } = await serviceClient
    .from('tenant_companies').select('id').eq('ruc', ruc).maybeSingle()
  if (rucLookupError) return json({ error: 'Could not verify RUC availability' }, 500)
  if (existingCompany) return json({ error: 'This RUC already belongs to a tenant' }, 409)

  const slug = `${slugify(displayName) || 'negocio'}-${crypto.randomUUID().slice(0, 8)}`
  const { data: invite, error: inviteError } = await serviceClient.auth.admin.createUser({
    email: adminEmail, password: temporaryPassword, email_confirm: true,
    user_metadata: { name: ownerName },
    app_metadata: { must_change_password: true },
  })
  if (inviteError || !invite.user) return json({ error: inviteError?.message ?? 'Unable to invite administrator' }, 400)

  const { data: tenantId, error: provisionError } = await serviceClient.rpc('provision_business', {
    p_slug: slug,
    p_display_name: displayName,
    p_plan_code: planCode,
    p_ruc: ruc,
    p_legal_name: legalName,
    p_admin_user_id: invite.user.id,
    p_actor_user_id: authData.user.id,
    p_admin_email: adminEmail,
    p_fiscal_address: fiscalAddress,
    p_expires_on: typeof body.expiresOn === 'string' && body.expiresOn ? body.expiresOn : null,
  })

  if (provisionError || !tenantId) {
    const { error: cleanupError } = await serviceClient.auth.admin.deleteUser(invite.user.id)
    if (cleanupError) return json({ error: 'El alta no se completó. Revisa la cuenta en Supabase Auth.' }, 500)
    return json({ error: provisionError?.message ?? 'No se pudo registrar el negocio.' }, 400)
  }

  return json({ tenantId, slug, status: 'trial' }, 201)
})
