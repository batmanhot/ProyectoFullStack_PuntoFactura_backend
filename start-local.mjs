import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const projectDir = dirname(fileURLToPath(import.meta.url))
const envFile = resolve(projectDir, '.env.local')
const watch = process.argv.includes('--watch')

function run(command, args, label) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command, args, { cwd: projectDir, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

try {
  if (!existsSync(envFile)) {
    run(process.execPath, ['setup-local.mjs'], 'Crear configuración local')
  }

  run('docker', ['volume', 'create', 'puntofactura_puntofactura_node_data'], 'Preparar volumen local de PostgreSQL')
  run('docker', ['compose', '--env-file', '.env.local', 'up', '-d', '--wait'], 'Iniciar PostgreSQL local')
  run(process.execPath, ['--env-file=.env.local', 'database/migrate.mjs'], 'Aplicar migraciones pendientes')

  console.log(`\n▶ Iniciar API${watch ? ' en modo watch' : ''} en http://127.0.0.1:3001`)
  const args = [...(watch ? ['--watch'] : []), '--env-file=.env.local', 'main.mjs']
  const api = spawn(process.execPath, args, { cwd: projectDir, stdio: 'inherit' })
  api.on('error', (error) => {
    console.error('No se pudo iniciar la API:', error.message)
    process.exitCode = 1
  })
  api.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => api.kill(signal))
  }
} catch (error) {
  console.error('\nNo se pudo iniciar el backend local.')
  console.error(error.message)
  process.exit(1)
}
