import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import pg from 'pg'

if (!process.env.DATABASE_URL) throw new Error('Configura DATABASE_URL')
pg.types.setTypeParser(1700, Number)
pg.types.setTypeParser(1082, value => value)
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

export async function transaction(work) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const value = await work(client)
    await client.query('commit')
    return value
  } catch (error) {
    await client.query('rollback')
    if (error.code === '42501') throw new ForbiddenException('Acceso denegado')
    if (error.code === 'P0002') throw new NotFoundException('Registro no encontrado')
    if (error.code === 'P0001') throw new BadRequestException(error.message)
    if (/^(22|23)/.test(error.code ?? '')) throw new BadRequestException('Revisa los datos o si existe un registro con los mismos valores')
    throw error
  } finally {
    client.release()
  }
}

export async function actor(client, user, role = 'authenticated') {
  await client.query("select set_config('pf.user_id',$1,true),set_config('pf.role',$2,true)", [user.id, role])
  await client.query(role === 'authenticated' ? 'set local role authenticated' : 'set local role service_role')
}

export async function requireAdmin(client, user) {
  await actor(client, user)
  const { rows: [row] } = await client.query('select public.is_superadmin() as allowed')
  if (!row.allowed) throw new ForbiddenException('Acceso reservado a SuperAdmin')
  await client.query('reset role')
}
