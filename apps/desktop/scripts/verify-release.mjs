#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export function verificationCommands(app) {
  return [
    ['codesign', ['--verify', '--deep', '--strict', app]],
    ['spctl', ['--assess', '--type', 'execute', app]],
    ['xcrun', ['stapler', 'validate', app]],
  ]
}

async function runChecked(run, command, args) {
  try {
    return await run(command, args)
  } catch (error) {
    throw new Error(`${command} failed (${error.code ?? 'unknown'}): ${error.stderr?.trim() || error.message}`)
  }
}

async function verifyApp(app, run) {
  for (const [command, args] of verificationCommands(app)) {
    await runChecked(run, command, args)
  }
}

export async function verifyRelease({ app, dmg }, run = execute) {
  await verifyApp(resolve(app), run)
  if (!dmg) return
  const mount = await mkdtemp(join(tmpdir(), 'dispatch-release-mount-'))
  let attached = false
  try {
    await runChecked(run, 'hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      resolve(dmg),
    ])
    attached = true
    const mountedApp = join(mount, 'Dispatch.app')
    await access(mountedApp)
    await verifyApp(mountedApp, run)
  } finally {
    if (attached) await runChecked(run, 'hdiutil', ['detach', mount])
    await rm(mount, { recursive: true, force: true })
  }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

async function main() {
  const app = option('--app')
  const dmg = option('--dmg')
  if (!app) throw new Error('Use --app with the signed Dispatch.app path')
  await verifyRelease({ app, dmg })
  process.stdout.write('Release signature, Gatekeeper, and notarization checks passed\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`verify-release: ${error.message}\n`)
    process.exitCode = 1
  })
}
