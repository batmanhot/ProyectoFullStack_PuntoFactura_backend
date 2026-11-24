import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const owner = randomBytes(24).toString('hex')
const runtime = randomBytes(24).toString('hex')
const settings = [
  'PF_POSTGRES_PASSWORD=' + owner,
  'MIGRATION_DATABASE_URL=postgresql://postgres:' + owner + '@127.0.0.1:55433/puntofactura',
  'DATABASE_URL=postgresql://pf_api:' + runtime + '@127.0.0.1:55433/puntofactura',
  'PORT=3001',
]
try {
  await writeFile(new URL('./.env.local', import.meta.url), settings.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  console.log('Configuración local creada')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.log('Configuración local existente conservada')
}
