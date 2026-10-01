import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const REGISTRY = 'https://registry.npmjs.org'
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
export const UPDATE_RETRY_MS = 15 * 60 * 1000
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024
interface PackageMetadata {
  name?: string
  version?: string
  optionalDependencies?: Record<string, string>
  dist?: { integrity?: string; tarball?: string }
}

export interface RuntimeRelease { version: string; command: string }
export interface RuntimeUpdateStatus {
  automatic: boolean
  version: string | null
  command: string
  checkedAt: string | null
  availableVersion: string | null
  state: 'idle' | 'checking' | 'downloading' | 'waiting' | 'updating' | 'failed'
  error: string | null
}

export interface RuntimeUpdater {
  status: RuntimeUpdateStatus
  initial(): Promise<string>
  check(): Promise<RuntimeRelease | undefined>
  activated(release: RuntimeRelease): Promise<void>
  reject(release: RuntimeRelease, error: unknown): Promise<void>
  fail(error: unknown): void
  close(): void
}

export function stableVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('Codex release must be a stable numeric version')
  return value
}

export function newerVersion(a: string, b: string): boolean {
  const left = stableVersion(a).split('.').map(Number), right = stableVersion(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!
  return false
}

export async function runtimeVersion(command: string): Promise<string> {
  const { stdout } = await exec(command, ['--version'], { timeout: 5000 })
  return stableVersion(/^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(stdout.trim())?.[1])
}

export function platformTarget(platform: string, arch: string): { suffix: string; triple: string } {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported Codex runtime platform: ${platform}/${arch}`)
  return { suffix: `${platform}-${arch}`, triple: `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}` }
}

/** Only the agent owns these artifacts. User configuration and Codex history stay in CODEX_HOME. */
export class CodexRuntimeManager {
  readonly status: RuntimeUpdateStatus
  readonly #root: string
  readonly #fetch: typeof fetch
  readonly #target: ReturnType<typeof platformTarget>
  readonly #abort = new AbortController()
  #checking: Promise<RuntimeRelease | undefined> | undefined
  #rejectedVersion: string | undefined

  constructor(command: string, options: { root?: string; fetch?: typeof fetch; platform?: string; arch?: string } = {}) {
    this.#root = options.root ?? join(homedir(), 'Library/Application Support/Dispatch/codex-runtime')
    this.#fetch = options.fetch ?? fetch
    this.#target = platformTarget(options.platform ?? process.platform, options.arch ?? process.arch)
    this.status = { automatic: true, command, version: null, checkedAt: null, availableVersion: null, state: 'idle', error: null }
  }

  async initial(): Promise<string> {
    try { this.#rejectedVersion = stableVersion(JSON.parse(await readFile(join(this.#root, 'rejected.json'), 'utf8')).version) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.fail(error) }
    try {
      const current = JSON.parse(await readFile(join(this.#root, 'current.json'), 'utf8')) as { version: string }
      const version = stableVersion(current.version)
      const command = await this.#command(version)
      // Never downgrade a newer desktop installation to an older managed release.
      const installed = await runtimeVersion(this.status.command).catch(() => undefined)
      if (!installed || !newerVersion(installed, version)) this.status.command = command
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.fail(error)
    }
    this.status.version = await runtimeVersion(this.status.command).catch(() => null)
    return this.status.command
  }

  check(): Promise<RuntimeRelease | undefined> {
    if (this.#checking) return this.#checking
    this.#checking = this.#check().finally(() => { this.#checking = undefined })
    return this.#checking
  }

  async #json(path: string): Promise<PackageMetadata> {
    const response = await this.#fetch(`${REGISTRY}/${path}`, { signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(20_000)]), redirect: 'error' })
    if (!response.ok) throw new Error(`Codex update metadata returned HTTP ${response.status}`)
    return await response.json() as PackageMetadata
  }

  async #command(version: string, root = this.#root): Promise<string> {
    // Both are published OpenAI package layouts; keep the complete resources beside the binary.
    for (const directory of ['bin', 'codex']) {
      const command = join(root, version, 'package/vendor', this.#target.triple, directory, 'codex')
      try { await access(command); if (await runtimeVersion(command) === version) return command } catch { /* Try the other supported layout. */ }
    }
    throw new Error(`Codex ${version} package has no working App Server executable`)
  }

  async #check(): Promise<RuntimeRelease | undefined> {
    this.status.state = 'checking'
    this.status.error = null
    try {
      const latest = await this.#json('@openai%2Fcodex/latest')
      const version = stableVersion(latest.version)
      this.status.checkedAt = new Date().toISOString()
      this.status.availableVersion = version
      if (version === this.#rejectedVersion) throw new Error(`Codex ${version} failed startup; keeping the previous runtime until a newer release`)
      if (this.status.version && newerVersion(this.status.version, version)) { this.status.state = 'idle'; return }
      const packageVersion = `${version}-${this.#target.suffix}`
      if (latest.optionalDependencies?.[`@openai/codex-${this.#target.suffix}`] !== `npm:@openai/codex@${packageVersion}`) throw new Error('Codex platform package is missing from the official release')
      let command: string
      try { command = await this.#command(version) }
      catch { command = await this.#download(version, packageVersion) }
      if (command === this.status.command) { this.status.state = 'idle'; return }
      this.status.state = 'waiting'
      return { version, command }
    } catch (error) { this.fail(error); return }
  }

  async #download(version: string, packageVersion: string): Promise<string> {
    const metadata = await this.#json(`@openai%2Fcodex/${packageVersion}`)
    const integrity = metadata.dist?.integrity
    const tarball = metadata.dist?.tarball
    if (metadata.name !== '@openai/codex' || metadata.version !== packageVersion
      || typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
      || tarball !== `${REGISTRY}/@openai/codex/-/codex-${packageVersion}.tgz`) throw new Error('Invalid official Codex package metadata')
    await mkdir(this.#root, { recursive: true })
    const staging = await mkdtemp(join(this.#root, '.download-'))
    try {
      this.status.state = 'downloading'
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(180_000)])
      const response = await this.#fetch(tarball, { signal, redirect: 'error' })
      if (!response.ok || !response.body) throw new Error(`Codex download returned HTTP ${response.status}`)
      const hash = createHash('sha512')
      let size = 0
      const archive = join(staging, 'runtime.tgz')
      await pipeline(Readable.fromWeb(response.body as any), new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length
        if (size > MAX_DOWNLOAD_BYTES) return done(new Error('Codex download exceeds the size limit'))
        hash.update(chunk); done(null, chunk)
      } }), createWriteStream(archive), { signal })
      if (`sha512-${hash.digest('base64')}` !== integrity) throw new Error('Codex package integrity check failed')
      const { stdout } = await exec('/usr/bin/tar', ['-tzf', archive], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
      if (stdout.trim().split('\n').some(name => !name.startsWith('package/') || name.split('/').includes('..'))) throw new Error('Codex archive contains an unsafe path')
      const extracted = join(staging, version)
      await mkdir(extracted)
      await exec('/usr/bin/tar', ['-xzf', archive, '-C', extracted], { timeout: 60_000 })
      await this.#command(version, staging)
      // A failed extraction never changes the active pointer or working installation.
      await rm(join(this.#root, version), { recursive: true, force: true })
      await rename(extracted, join(this.#root, version))
      return await this.#command(version)
    } finally { await rm(staging, { recursive: true, force: true }) }
  }

  async activated(release: RuntimeRelease): Promise<void> {
    const previousVersion = this.status.version
    await mkdir(this.#root, { recursive: true })
    const pointer = join(this.#root, 'current.json')
    await writeFile(`${pointer}.tmp`, JSON.stringify({ version: release.version }))
    await rename(`${pointer}.tmp`, pointer)
    this.status.command = release.command; this.status.version = release.version
    this.status.state = 'idle'; this.status.error = null
    // Retain the previous release for rollback without accumulating every downloaded version.
    try {
      for (const entry of await readdir(this.#root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name) && ![release.version, previousVersion].includes(entry.name)) {
          await rm(join(this.#root, entry.name), { recursive: true, force: true })
        }
      }
    } catch (error) { this.fail(error) }
  }

  async reject(release: RuntimeRelease, error: unknown): Promise<void> {
    this.#rejectedVersion = release.version
    this.fail(error)
    try {
      await mkdir(this.#root, { recursive: true })
      const pointer = join(this.#root, 'rejected.json')
      await writeFile(`${pointer}.tmp`, JSON.stringify({ version: release.version }))
      await rename(`${pointer}.tmp`, pointer)
    } catch (failure) { this.fail(failure) }
  }

  fail(error: unknown): void {
    this.status.state = 'failed'
    this.status.error = error instanceof Error ? error.message : String(error)
    console.error(`Codex runtime update: ${this.status.error}`)
  }

  close(): void { this.#abort.abort() }
}
