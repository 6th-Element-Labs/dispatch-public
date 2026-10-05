// Starts mail, agent and work from a built Dispatch.app with its own bundled
// Node and requires all /health endpoints to answer. Catches a bundle
// whose staged services cannot start, which a successful `tauri build` does not.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const app = resolve(process.argv[2] ?? 'src-tauri/target/release/bundle/macos/Dispatch.app')
const node = join(app, 'Contents', 'MacOS', 'node')
const services = [
  { name: 'work', script: join(app, 'Contents', 'Resources', 'services', 'work', 'server.js'), port: 18413, env: 'DISPATCH_WORK_PORT' },
  { name: 'mail', script: join(app, 'Contents', 'Resources', 'services', 'mail', 'server.js'), port: 18411, env: 'DISPATCH_MAIL_PORT' },
  { name: 'agent', script: join(app, 'Contents', 'Resources', 'services', 'agent', 'server.js'), port: 18412, env: 'DISPATCH_AGENT_PORT' },
]
for (const path of [node, ...services.map((s) => s.script)]) {
  if (!existsSync(path)) fail(`${path} is missing from the bundle`)
}

const smokeDirectory = mkdtempSync(join(tmpdir(), 'dispatch-bundle-smoke-'))
const smokeEnvironment = {
  DISPATCH_WORK_DB: ':memory:',
  DISPATCH_MAIL_DB: ':memory:',
  DISPATCH_CODEX_BINDINGS: join(smokeDirectory, 'bindings.json'),
  DISPATCH_CODEX_COMMAND: '/usr/bin/false',
  DISPATCH_CODEX_AUTO_UPDATE: '0',
  DISPATCH_GMAIL_OAUTH_CLIENT_ID: '',
  DISPATCH_GMAIL_OAUTH_CONFIG: join(smokeDirectory, 'no-oauth.json'),
  DISPATCH_AGENT_URL: 'http://127.0.0.1:18412',
  DISPATCH_MAIL_URL: 'http://127.0.0.1:18411',
  DISPATCH_MAIL_BASE: 'http://127.0.0.1:18411',
  DISPATCH_AGENT_BASE: 'http://127.0.0.1:18412',
}
const children = services.map((service) => {
  const child = spawn(node, [service.script], { env: { ...process.env, ...smokeEnvironment, [service.env]: String(service.port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.output = ''
  child.stdout.on('data', (chunk) => { child.output += chunk })
  child.stderr.on('data', (chunk) => { child.output += chunk })
  return Object.assign(child, { service })
})

try {
  for (const child of children) {
    const healthy = await waitForHealth(child.service.port, 15_000)
    if (!healthy || child.exitCode !== null) fail(`${child.service.name} did not report healthy on port ${child.service.port}\n${child.output}`)
    console.log(`smoke-bundle: ${child.service.name} healthy on 127.0.0.1:${child.service.port}`)
  }
} finally {
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))))
  rmSync(smokeDirectory, { recursive: true, force: true })
}
console.log('smoke-bundle: ok')

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

function fail(message) {
  console.error(`smoke-bundle: ${message}`)
  for (const child of children ?? []) child.kill('SIGKILL')
  process.exit(1)
}
