#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIGNATURE_PREFIX = 'untrusted comment:'
const ARCHIVE_SUFFIX = '.app.tar.gz'
const PLATFORM = 'darwin-aarch64'

export function githubReleaseAssetUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

export function buildManifest({ version, notes = '', pubDate, url, signature }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [PLATFORM]: { url, signature },
    },
  }
}

export async function validateManifest(manifest, { version, assetsDir, read } = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('updater manifest must be an object')
  if (manifest.version !== version) {
    throw new Error(`updater manifest version ${manifest.version} does not match ${version}`)
  }
  const platforms = manifest.platforms
  if (!platforms || typeof platforms !== 'object') throw new Error('updater manifest is missing platforms')
  const names = Object.keys(platforms)
  if (!names.includes(PLATFORM)) throw new Error(`updater manifest is missing ${PLATFORM}`)
  if (names.length !== 1) throw new Error(`updater manifest has extra platforms: ${names.join(', ')}`)

  const platform = platforms[PLATFORM]
  if (!platform?.url || !githubReleaseAssetUrl(platform.url)) {
    throw new Error('updater platform URL must be an HTTPS GitHub release asset')
  }
  if (!platform.url.endsWith(ARCHIVE_SUFFIX)) {
    throw new Error(`updater platform URL must end with ${ARCHIVE_SUFFIX}`)
  }
  if (typeof platform.signature !== 'string' || !platform.signature.startsWith(SIGNATURE_PREFIX)) {
    throw new Error('updater signature must be minisign text, not a URL or path')
  }
  if (/^https?:\/\//.test(platform.signature) || platform.signature.includes('/') || platform.signature.includes('\\')) {
    throw new Error('updater signature must be minisign text, not a URL or path')
  }

  const archiveName = basename(new URL(platform.url).pathname)
  const archive = resolve(assetsDir, archiveName)
  const signatureFile = `${archive}.sig`
  const readFileAt = read ?? (path => readFile(path, 'utf8'))
  let archiveBytes
  try {
    archiveBytes = await (read ? read(archive) : readFile(archive))
  } catch {
    throw new Error(`updater archive is missing: ${archiveName}`)
  }
  if (!archiveBytes || (typeof archiveBytes === 'string' ? archiveBytes.length === 0 : archiveBytes.length === 0)) {
    throw new Error(`updater archive is missing: ${archiveName}`)
  }
  const localSignature = await readFileAt(signatureFile)
  if (localSignature !== platform.signature) {
    throw new Error('updater signature does not match the complete local .sig file')
  }
  return { archive, signatureFile, platform }
}

export async function writeManifest({ output, version, notes, url, signature, pubDate = new Date().toISOString() }) {
  const manifest = buildManifest({ version, notes, pubDate, url, signature })
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

async function main() {
  const version = option('--version')
  if (!version) throw new Error('Use --version with the exact release version')

  if (process.argv.includes('--write')) {
    const output = option('--output')
    const url = option('--url')
    const sigPath = option('--sig')
    const notes = option('--notes') ?? ''
    if (!output || !url || !sigPath) {
      throw new Error('Use --write --output latest.json --url <https github asset> --sig <file>')
    }
    const signature = await readFile(resolve(sigPath), 'utf8')
    await writeManifest({ output: resolve(output), version, notes, url, signature })
    process.stdout.write(`Wrote ${output}\n`)
    return
  }

  const manifestPath = option('--manifest')
  const assetsDir = option('--assets')
  if (!manifestPath || !assetsDir) {
    throw new Error('Use --manifest latest.json --assets <dir> --version <version>')
  }
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'))
  await validateManifest(manifest, { version, assetsDir: resolve(assetsDir) })
  process.stdout.write('Updater manifest, archive, and signature checks passed\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`validate-updater-manifest: ${error.message}\n`)
    process.exitCode = 1
  })
}
