import bcrypt from 'bcryptjs'
import { Client } from 'pg'

const email = process.env.PF_ADMIN_EMAIL?.trim().toLowerCase() ?? ''
const password = process.env.PF_ADMIN_PASSWORD
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 12 || Buffer.byteLength(password) > 72) {
  throw new Error('Configura PF_ADMIN_EMAIL y PF_ADMIN_PASSWORD (12 caracteres como mínimo y 72 bytes como máximo)')
}
const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
await client.connect()
try {
  await client.query('begin')
  const { rows: [user] } = await client.query('insert into auth.users(email,password_hash) values($1,$2) returning id',
    [email, await bcrypt.hash(password, 12)])
  await client.query("insert into public.platform_admins(user_id,role) values($1,'superadmin')", [user.id])
  await client.query('commit')
  console.log('Cuenta SuperAdmin creada')
} catch (error) {
  await client.query('rollback')
  if (error.code === '23505') throw new Error('Ya existe una cuenta con ese correo')
  throw error
} finally {
  await client.end()
}
