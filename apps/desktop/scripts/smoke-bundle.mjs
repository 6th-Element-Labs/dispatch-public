// Starts the mail and agent services from a built Dispatch.app with its own
// bundled Node and requires both /health endpoints to answer. Catches a bundle
// whose staged services cannot start, which a successful `tauri build` does not.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const app = resolve(process.argv[2] ?? 'src-tauri/target/release/bundle/macos/Dispatch.app')
const node = join(app, 'Contents', 'MacOS', 'node')
const services = [
  { name: 'mail', script: join(app, 'Contents', 'Resources', 'services', 'mail', 'server.js'), port: 18411, env: 'DISPATCH_MAIL_PORT' },
  { name: 'agent', script: join(app, 'Contents', 'Resources', 'services', 'agent', 'server.js'), port: 18412, env: 'DISPATCH_AGENT_PORT' },
]
for (const path of [node, ...services.map((s) => s.script)]) {
  if (!existsSync(path)) fail(`${path} is missing from the bundle`)
}

const children = services.map((service) => {
  const child = spawn(node, [service.script], { env: { ...process.env, [service.env]: String(service.port) }, stdio: ['ignore', 'pipe', 'pipe'] })
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
