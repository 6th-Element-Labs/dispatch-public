import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRuntimeManager, newerVersion, platformTarget } from '../src/codex-runtime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(version = '0.160.0') {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-codex-update-')); roots.push(root)
  const command = join(root, 'installed')
  await writeFile(command, '#!/bin/sh\necho "codex-cli 0.159.0"\n'); await chmod(command, 0o755)
  const bin = join(root, 'source/package/vendor/aarch64-apple-darwin/bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`); await chmod(join(bin, 'codex'), 0o755)
  const archive = join(root, 'fixture.tgz')
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', join(root, 'source'), 'package'])
  const bytes = await readFile(archive)
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  let badIntegrity = false
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/latest')) return Response.json({ version, optionalDependencies: { '@openai/codex-darwin-arm64': `npm:@openai/codex@${version}-darwin-arm64` } })
    if (String(url).endsWith('.tgz')) return new Response(bytes)
    return Response.json({ name: '@openai/codex', version: `${version}-darwin-arm64`, dist: {
      integrity: badIntegrity ? `sha512-${Buffer.alloc(64).toString('base64')}` : integrity,
      tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}-darwin-arm64.tgz`,
    } })
  }) as unknown as typeof fetch
  const manager = new CodexRuntimeManager(command, { root: join(root, 'managed'), fetch: fetcher, platform: 'darwin', arch: 'arm64' })
  return { root, command, manager, fetcher, corrupt: () => { badIntegrity = true } }
}

describe('managed Codex runtime', () => {
  it('verifies and stages the complete package, commits only after activation, and reuses it on restart', async () => {
    const { root, command, manager, fetcher } = await fixture()
    expect(await manager.initial()).toBe(command)
    const [release, same] = await Promise.all([manager.check(), manager.check()])
    expect(release).toEqual(same)
    expect(release?.version).toBe('0.160.0')
    expect(manager.status.state).toBe('waiting')
    await expect(readFile(join(root, 'managed/current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await manager.activated(release!)
    const rebooted = new CodexRuntimeManager(command, { root: join(root, 'managed'), fetch: fetcher, platform: 'darwin', arch: 'arm64' })
    expect(await rebooted.initial()).toBe(release!.command)
    expect(await rebooted.check()).toBeUndefined()
    expect(rebooted.status).toMatchObject({ version: '0.160.0', state: 'idle', error: null })
  })

  it('rejects corrupted downloads and keeps the installed runtime and active pointer intact', async () => {
    const { root, command, manager, corrupt } = await fixture()
    await manager.initial(); corrupt()
    expect(await manager.check()).toBeUndefined()
    expect(manager.status).toMatchObject({ command, version: '0.159.0', state: 'failed', error: 'Codex package integrity check failed' })
    expect(await readdir(join(root, 'managed'))).toEqual([])
  })

  it('keeps the current runtime on network failure and reports the update error', async () => {
    const { root, command } = await fixture()
    const manager = new CodexRuntimeManager(command, { root: join(root, 'managed'), fetch: vi.fn(async () => { throw new Error('offline') }), platform: 'darwin', arch: 'arm64' })
    await manager.initial()
    expect(await manager.check()).toBeUndefined()
    expect(manager.status).toMatchObject({ command, version: '0.159.0', error: 'offline' })
  })

  it('remembers rejected startup versions across restart without activating them again', async () => {
    const { root, command, manager, fetcher } = await fixture()
    await manager.initial()
    const release = await manager.check()
    await manager.reject(release!, new Error('protocol initialization failed'))
    const rebooted = new CodexRuntimeManager(command, { root: join(root, 'managed'), fetch: fetcher, platform: 'darwin', arch: 'arm64' })
    expect(await rebooted.initial()).toBe(command)
    expect(await rebooted.check()).toBeUndefined()
    expect(rebooted.status.error).toContain('failed startup')
  })

  it('does not downgrade a newer installed runtime to the registry version', async () => {
    const { manager } = await fixture('0.158.0')
    await manager.initial()
    expect(await manager.check()).toBeUndefined()
    expect(manager.status.state).toBe('idle')
  })

  it('compares numeric versions, excludes preview tags, and targets Apple Silicon and Intel', () => {
    expect(newerVersion('0.160.0', '0.99.0')).toBe(true)
    expect(() => newerVersion('0.161.0-alpha.1', '0.160.0')).toThrow('stable')
    expect(platformTarget('darwin', 'arm64').triple).toBe('aarch64-apple-darwin')
    expect(platformTarget('darwin', 'x64').triple).toBe('x86_64-apple-darwin')
  })
})
