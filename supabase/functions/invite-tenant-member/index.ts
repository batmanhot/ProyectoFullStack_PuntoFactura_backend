import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const appOrigin = Deno.env.get('APP_ORIGIN') ?? 'http://localhost:5173'
const corsHeaders = {
  'Access-Control-Allow-Origin': appOrigin,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: authData, error: authError } = await userClient.auth.getUser()
  if (authError || !authData.user) return json({ error: 'Invalid session' }, 401)
  const { data: isAdmin, error: roleError } = await userClient.rpc('is_superadmin')
  if (roleError || !isAdmin) return json({ error: 'Platform administrator access required' }, 403)

  let body: Record<string, unknown>
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const role = typeof body.role === 'string' ? body.role : 'seller'
  const allowedRoles = ['admin', 'seller', 'accountant', 'viewer']
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !allowedRoles.includes(role)) {
    return json({ error: 'Valid tenant, email and non-owner role are required' }, 400)
  }

  const { data: tenant, error: tenantError } = await serviceClient
    .from('tenants').select('status,trial_ends_at,plan_id').eq('id', tenantId).maybeSingle()
  if (tenantError || !tenant || !['trial', 'active'].includes(tenant.status)
    || (tenant.status === 'trial' && tenant.trial_ends_at && new Date(tenant.trial_ends_at) <= new Date())) {
    return json({ error: 'Tenant subscription does not allow new members' }, 409)
  }
  const { data: plan, error: planError } = await serviceClient
    .from('service_plans').select('included_users').eq('id', tenant.plan_id).maybeSingle()
  const { count, error: countError } = await serviceClient
    .from('tenant_memberships').select('user_id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('is_active', true)
  if (planError || countError || !plan) return json({ error: 'Unable to check the tenant user allowance' }, 500)
  if ((count ?? 0) >= plan.included_users) return json({ error: 'Included user limit reached' }, 409)

  const { data: invite, error: inviteError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
    data: { invited_for_tenant: tenantId, invited_by: authData.user.id },
    redirectTo: `${appOrigin}/auth/accept-invite`,
  })
  if (inviteError || !invite.user) return json({ error: inviteError?.message ?? 'Unable to invite member' }, 400)

  const { error: membershipInsertError } = await serviceClient.rpc('add_tenant_member', {
    p_tenant_id: tenantId,
    p_member_user_id: invite.user.id,
    p_actor_user_id: authData.user.id,
    p_role: role,
  })
  if (membershipInsertError) {
    await serviceClient.auth.admin.deleteUser(invite.user.id)
    const status = membershipInsertError.message.includes('limit reached') ? 409 : 400
    return json({ error: membershipInsertError.message }, status)
  }
  return json({ invited: true, tenantId, email, role }, 201)
})
