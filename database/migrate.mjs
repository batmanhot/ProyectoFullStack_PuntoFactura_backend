import { readFile, readdir } from 'node:fs/promises'
import { Client } from 'pg'

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Configura MIGRATION_DATABASE_URL')
const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
await client.connect()
try {
  await client.query("select pg_advisory_lock(417621)")
  await client.query('create table if not exists public.pf_migrations (name text primary key)')
  const directory = new URL('../supabase/migrations/', import.meta.url)
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  const prerequisites = ['bootstrap.sql', 'factusaas-inbox.sql']
  const localFiles = [...prerequisites, 'account-management.sql', 'account-audit.sql', 'business-team.sql']
  for (const name of [...prerequisites, ...files, ...localFiles.slice(prerequisites.length)]) {
    const applied = await client.query('select 1 from public.pf_migrations where name=$1', [name])
    if (applied.rowCount) continue
    let sql = await readFile(new URL(name, localFiles.includes(name) ? import.meta.url : directory), 'utf8')
    if (name === files[0]) sql = sql.split('insert into storage.buckets')[0]
    sql = sql.replace(/^drop policy .* on storage\.objects;\r?$/gm, '')
    await client.query('begin')
    try {
      await client.query(sql)
      await client.query('insert into public.pf_migrations values ($1)', [name])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    }
    console.log('Aplicada:', name)
  }
  if (process.env.DATABASE_URL) {
    const runtime = new URL(process.env.DATABASE_URL)
    const login = decodeURIComponent(runtime.username)
    const password = decodeURIComponent(runtime.password)
    if (login !== 'pf_api' || !password) throw new Error('DATABASE_URL debe identificar al rol pf_api con contraseña')
    const exists = await client.query('select 1 from pg_roles where rolname=$1', [login])
    const role = await client.query("select format('ALTER ROLE pf_api WITH LOGIN NOINHERIT PASSWORD %L', $1::text) as sql", [password])
    if (!exists.rowCount) await client.query('create role pf_api nologin noinherit')
    await client.query(role.rows[0].sql)
    await client.query('grant authenticated, service_role to pf_api')
    await client.query('grant usage on schema auth to pf_api')
    await client.query('grant select, insert, update on auth.users to pf_api')
    await client.query('grant select, insert, delete on auth.sessions to pf_api')
    await client.query('revoke select on public.tenant_memberships, public.platform_admins from pf_api')
    await client.query('revoke insert on public.platform_admins from pf_api')
    await client.query('revoke insert on public.tenant_audit_log from pf_api')
    await client.query('revoke usage on sequence public.tenant_audit_log_id_seq from pf_api')
  }
} finally {
  await client.end()
}
