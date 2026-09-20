import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const contract = JSON.parse(await readFile(resolve(root, 'deploy/service-boundary-contract.json'), 'utf8'))

function fail(message) {
  process.stderr.write(`check-boundaries: ${message}\n`)
  process.exitCode = 1
}

if (contract.requirements?.independent_processes !== true) fail('independent_processes must stay true')
if (contract.requirements?.no_root_monolith !== true) fail('no_root_monolith must stay true')
if (contract.requirements?.codex_app_server_is_agent_harness !== true) fail('Codex App Server must remain the agent harness')

for (const service of contract.services ?? []) {
  const serviceRoot = resolve(root, 'services', service.name)
  try {
    const manifest = JSON.parse(await readFile(resolve(serviceRoot, 'package.json'), 'utf8'))
    if (!manifest.scripts?.start) fail(`services/${service.name} has no independent start command`)
    if (!manifest.scripts?.test) fail(`services/${service.name} has no test command`)
  } catch (error) {
    fail(`services/${service.name} is not independently packaged: ${error}`)
  }
}

for (const forbidden of ['app.py', 'app.ts', 'server.ts', 'mcp_server.py', 'package.json']) {
  try {
    await access(resolve(root, forbidden))
    fail(`root monolith surface is forbidden: ${forbidden}`)
  } catch {
    // Absence is the invariant.
  }
}

if (!process.exitCode) process.stdout.write('check-boundaries: service boundaries verified\n')

