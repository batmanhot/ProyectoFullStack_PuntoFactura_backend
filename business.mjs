import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { actor, requireAdmin, transaction } from './database.mjs'
import { checkFactuSaas } from './connectors/factusaas-connection.mjs'

const operations = {
  'platform-access': ['is_superadmin', 'scalar', []],
  'business-access': ['business_access', 'list', []],
  'register-document': ['register_document', 'row', ['p_tenant_id','p_company_id','p_series_id','p_request_id','p_document']],
  'set-emission-enabled': ['set_external_emission_enabled', 'scalar', ['p_tenant_id','p_enabled']],
  'stock': ['set_product_stock', 'scalar', ['p_tenant_id','p_branch_id','p_product_id','p_stock','p_reason']],
  'update-business': ['update_business', 'scalar', ['p_tenant_id','p_company_id','p_name','p_legal_name','p_address','p_email','p_plan_id','p_status']],
  'renew-subscription': ['renew_subscription', 'row', ['p_tenant_id','p_request_id','p_amount','p_paid_on','p_reference']],
  'update-plan': ['update_service_plan', 'scalar', ['p_plan_id','p_name','p_price','p_limit','p_users','p_rucs','p_overage_allowed','p_overage_price']],
  'update-membership': ['update_managed_membership', 'scalar', ['p_tenant_id','p_user_id','p_role','p_active']],
  'update-igv': ['update_platform_igv', 'scalar', ['p_rate']],
}

export function operate(user, operation, body) {
  if (!Object.hasOwn(operations, operation)) throw new NotFoundException()
  const [fn, shape, args] = operations[operation]
  const parameters = args.map(name => body[name] ?? null)
  const call = 'public.' + fn + '(' + args.map((_, index) => '$' + (index + 1)).join(',') + ')'
  return transaction(async client => {
    await actor(client, user)
    const { rows } = await client.query(shape === 'scalar' ? 'select ' + call + ' as value' : 'select * from ' + call, parameters)
    return shape === 'list' ? rows : shape === 'row' ? rows[0] : rows[0]?.value
  })
}

const documentColumns = 'id,document_type,series,correlativo,customer_name,customer_document,issue_date,payment_method,total,igv_rate,igv_amount,taxable_base,related_document_id,note_reason,lines,status,transmission_state,transmission_attempts,transmission_requested_at,transmission_response'
const month = "date_trunc('month', now() at time zone 'America/Lima')::date"

export function businessData(user, tenant, company) {
  return transaction(async client => {
    await actor(client, user)
    const query = async (sql, values = []) => (await client.query(sql, values)).rows
    const [access] = await query('select public.is_tenant_member($1) as allowed', [tenant])
    if (!access.allowed) throw new ForbiddenException('El negocio no está disponible')
    const companies = await query('select id,legal_name,ruc,fiscal_address from public.tenant_companies where tenant_id=$1 order by id', [tenant])
    const selected = companies.find(item => item.id === company) ?? (!company ? companies[0] : undefined)
    if (!selected) throw new NotFoundException('Empresa no disponible')
    const ids = [tenant, selected.id]
    const where = ' where tenant_id=$1 and company_id=$2'
    const branches = await query('select id from public.tenant_branches' + where + ' and is_active order by code limit 1', ids)
    const series = await query('select id,series,document_type,branch_id from public.document_series' + where + ' and is_active order by series', ids)
    const customers = await query('select name,document_number,document_type,email,phone from public.tenant_customers' + where + ' order by name', ids)
    const products = await query('select id,sku,name,category,price,stock_control_enabled from public.tenant_products' + where + ' and is_active order by name', ids)
    const inventory = await query('select product_id,branch_id,stock from public.tenant_inventory' + where, ids)
    const documents = await query('select ' + documentColumns + ' from public.electronic_documents' + where + ' order by created_at desc limit 100', ids)
    const [settings] = await query('select igv_rate from public.platform_settings')
    const [assigned] = await query('select plan_id,external_emission_enabled from public.tenants where id=$1', [tenant])
    const plans = await query('select id,name,monthly_price_pen,monthly_document_limit,included_users,included_rucs,overage_allowed,overage_price_pen,is_active from public.service_plans where is_active or id=$1 order by monthly_document_limit', [assigned.plan_id])
    const team = await query('select * from public.business_team($1)', [tenant])
    const renewals = await query('select id,plan_id,previous_expiry,new_expiry,amount_pen,paid_on,payment_reference from public.subscription_renewals where tenant_id=$1 order by paid_on desc,created_at desc limit 100', [tenant])
    const usage = await query('select sent_count from public.monthly_emission_usage where tenant_id=$1 and period_start=' + month, [tenant])
    const today = "(now() at time zone 'America/Lima')::date"
    const stored = " and status not in ('draft','voided')"
    const daily = await query('select issue_date as date,sum(total)::numeric as total from public.electronic_documents' +
      where + stored + " and document_type in ('01','03') and issue_date between " + today + ' - 6 and ' + today + ' group by issue_date order by issue_date', ids)
    const summary = await query('select document_type,count(*)::int as count,sum(total)::numeric as total from public.electronic_documents' +
      where + stored + ' and issue_date between ' + month + ' and ' + today + ' group by document_type', ids)
    return { companies, company: selected.id, branches, series, customers, products, inventory, documents, settings,
      plans, assignedPlanId: assigned.plan_id, externalEmissionEnabled: assigned.external_emission_enabled, team, renewals, usage, daily, summary }
  })
}

export async function factuSaasConnectionStatus(user, tenant) {
  const allowed = await transaction(async client => {
    await actor(client, user)
    const { rows: [membership] } = await client.query('select public.is_tenant_member($1) as allowed', [tenant])
    return membership?.allowed === true
  })
  if (!allowed) throw new ForbiddenException('El negocio no está disponible')
  const status = await checkFactuSaas()
  return {
    connected: status.health === 'ok' && status.simulatedDevelopment && status.apiKeyRead === 'ok' &&
      status.webhookSecretConfigured && status.emitterConfigured,
    simulated: status.simulatedDevelopment,
  }
}

export function findDocument(user, tenant, company, series, number) {
  return transaction(async client => {
    await actor(client, user)
    const { rows } = await client.query(
      "select " + documentColumns + " from public.electronic_documents where tenant_id=$1 and company_id=$2 and series=$3 and correlativo=$4 and document_type in ('01','03') and status in ('registered','sent','accepted') limit 1",
      [tenant, company, series, number])
    return rows[0] ?? null
  })
}

export function saveCatalog(user, tenant, company, kind, body) {
  const fields = kind === 'customers' ? ['name','document_number','document_type','email','phone'] :
    kind === 'products' ? ['name','sku','price','category','stock_control_enabled'] : null
  if (!fields) throw new NotFoundException()
  if (!body.name?.trim?.() || (kind === 'customers' ? !/^([0-9]{8}|[0-9]{11})$/.test(body.document_number ?? '') :
    !body.sku?.trim?.() || !Number.isFinite(body.price) || body.price < 0)) throw new BadRequestException('Revisa nombre, código y precio')
  const table = kind === 'customers' ? 'public.tenant_customers' : 'public.tenant_products'
  const key = kind === 'customers' ? 'document_number' : 'id'
  const values = [tenant, company, ...fields.map(field => body[field] ?? null)]
  const placeholders = fields.map((_, index) => '$' + (index + 3))
  const update = body.previous != null
  const sql = update
    ? 'update ' + table + ' set ' + fields.map((field, index) => field + '=' + placeholders[index]).join(',') +
      ' where tenant_id=$1 and company_id=$2 and ' + key + '=$' + (values.length + 1) + ' returning id'
    : 'insert into ' + table + ' (tenant_id,company_id,' + fields.join(',') + ') values ($1,$2,' + placeholders.join(',') + ') returning id'
  if (update) values.push(body.previous)
  return transaction(async client => {
    await actor(client, user)
    const { rows } = await client.query(sql, values)
    if (!rows.length) throw new NotFoundException('Registro no disponible')
    return rows[0]
  })
}

export function platformData(user) {
  return transaction(async client => {
    await requireAdmin(client, user)
    await actor(client, user)
    const query = async sql => (await client.query(sql)).rows
    return {
      plans: await query('select * from public.service_plans order by monthly_document_limit'),
      businesses: await query('select id,display_name,plan_id,status from public.tenants order by display_name'),
      companies: await query('select id,tenant_id,legal_name,fiscal_address,email,ruc from public.tenant_companies order by id'),
      subscriptions: await query('select tenant_id,current_period_end from public.tenant_subscriptions order by created_at desc,id desc'),
      users: await query('select * from public.managed_account_list()'),
      renewals: await query('select id,tenant_id,paid_on,new_expiry,amount_pen,payment_reference from public.subscription_renewals order by created_at desc limit 100'),
      audit: await query('select id,tenant_id,action,created_at from public.tenant_audit_log order by created_at desc limit 100'),
      rate: (await query('select igv_rate from public.platform_settings'))[0]?.igv_rate,
      usage: await query('select tenant_id,sent_count from public.monthly_emission_usage where period_start=' + month),
    }
  })
}
