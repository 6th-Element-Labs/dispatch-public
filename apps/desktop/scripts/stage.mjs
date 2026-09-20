// Builds the Dispatch services and copies their compiled output into the Tauri
// resources directory. Fails loudly if any build or expected file is missing.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(desktop, '..', '..')
const servicesOnly = process.argv.includes('--services-only')
const resourceRoot = join(desktop, 'src-tauri', 'resources')
const resources = join(resourceRoot, 'services')
const legal = join(resourceRoot, 'legal')

const builds = servicesOnly ? ['mail', 'agent'] : ['web', 'mail', 'agent']
for (const service of builds) {
  console.log(`stage: building services/${service}`)
  execSync(`npm --prefix "${join(repo, 'services', service)}" run build`, { stdio: 'inherit' })
}

rmSync(resources, { recursive: true, force: true })
rmSync(legal, { recursive: true, force: true })
mkdirSync(legal, { recursive: true })
for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  const source = join(repo, file)
  if (!existsSync(source)) {
    console.error(`stage: ${source} is missing`)
    process.exit(1)
  }
  copyFileSync(source, join(legal, file))
}
for (const service of ['mail', 'agent']) {
  const source = join(repo, 'services', service, 'dist', 'src')
  const destination = join(resources, service)
  cpSync(source, destination, { recursive: true })
  const entry = join(destination, 'server.js')
  if (!existsSync(entry)) {
    console.error(`stage: ${entry} is missing after building services/${service}`)
    process.exit(1)
  }
  installRuntimeDependencies(service, destination)
}
if (!servicesOnly && !existsSync(join(repo, 'services', 'web', 'dist', 'index.html'))) {
  console.error('stage: services/web/dist/index.html is missing after the web build')
  process.exit(1)
}
console.log(`stage: services staged under ${resources}`)
const hash = createHash('sha256').update(readFileSync(join(desktop, 'node-sidecar.json')))
function hashRuntime(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'runtime-id') continue
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) hashRuntime(join(directory, entry.name), `${name}/`)
    else hash.update(name).update(readFileSync(join(directory, entry.name)))
  }
}
hashRuntime(resources)
writeFileSync(join(resources, 'runtime-id'), hash.digest('hex'))

// A service's runtime npm dependencies must travel with its compiled code.
// The lockfile is copied so the bundle installs exactly what CI tested.
function installRuntimeDependencies(service, destination) {
  const serviceRoot = join(repo, 'services', service)
  const manifest = JSON.parse(readFileSync(join(serviceRoot, 'package.json'), 'utf8'))
  const dependencies = Object.keys(manifest.dependencies ?? {})
  if (dependencies.length === 0) return
  for (const file of ['package.json', 'package-lock.json']) {
    const source = join(serviceRoot, file)
    if (!existsSync(source)) {
      console.error(`stage: services/${service} has runtime dependencies but no ${file}`)
      process.exit(1)
    }
    copyFileSync(source, join(destination, file))
  }
  console.log(`stage: installing ${dependencies.length} runtime dependencies for services/${service}`)
  execSync(`npm --prefix "${destination}" ci --omit=dev --ignore-scripts --no-audit --no-fund`, { stdio: 'inherit' })
  for (const dependency of dependencies) {
    if (!existsSync(join(destination, 'node_modules', dependency))) {
      console.error(`stage: ${dependency} is missing from ${destination}/node_modules after install`)
      process.exit(1)
    }
  }
}
