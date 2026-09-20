#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIGNATURE_PREFIX = 'untrusted comment:'
const ARCHIVE_SUFFIX = '.app.tar.gz'
const ARM_PLATFORM = 'darwin-aarch64'
const INTEL_PLATFORM = 'darwin-x86_64'

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

export function encodedMinisignSignature(value) {
  if (typeof value !== 'string') return false
  const encoded = value.trim()
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
  const decoded = Buffer.from(encoded, 'base64')
  return decoded.toString('base64') === encoded && decoded.toString('utf8').startsWith(SIGNATURE_PREFIX)
}

export function buildManifest({ version, notes = '', pubDate, url, signature, intelUrl, intelSignature }) {
  if (Boolean(intelUrl) !== Boolean(intelSignature)) {
    throw new Error('Intel updater URL and signature must be provided together')
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [ARM_PLATFORM]: { url, signature },
      ...(intelUrl ? { [INTEL_PLATFORM]: { url: intelUrl, signature: intelSignature } } : {}),
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
  if (!names.includes(ARM_PLATFORM)) throw new Error(`updater manifest is missing ${ARM_PLATFORM}`)
  if (names.some(name => name !== ARM_PLATFORM && name !== INTEL_PLATFORM)) {
    throw new Error(`updater manifest has extra platforms: ${names.join(', ')}`)
  }

  const verified = {}
  for (const name of names) {
    const platform = platforms[name]
    if (!platform?.url || !githubReleaseAssetUrl(platform.url)) {
      throw new Error(`${name} updater URL must be an HTTPS GitHub release asset`)
    }
    if (!platform.url.endsWith(ARCHIVE_SUFFIX)) {
      throw new Error(`${name} updater URL must end with ${ARCHIVE_SUFFIX}`)
    }
    if (!encodedMinisignSignature(platform.signature)) {
      throw new Error(`${name} updater signature must be base64-encoded minisign text, not a URL or path`)
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
    if (!archiveBytes || archiveBytes.length === 0) {
      throw new Error(`updater archive is missing: ${archiveName}`)
    }
    const localSignature = await readFileAt(signatureFile)
    if (localSignature !== platform.signature) {
      throw new Error(`${name} updater signature does not match the complete local .sig file`)
    }
    verified[name] = { archive, signatureFile, platform }
  }
  return verified
}

export async function writeManifest({ output, version, notes, url, signature, intelUrl, intelSignature, pubDate = new Date().toISOString() }) {
  const manifest = buildManifest({ version, notes, pubDate, url, signature, intelUrl, intelSignature })
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
    const intelUrl = option('--url-intel')
    const intelSigPath = option('--sig-intel')
    const notes = option('--notes') ?? ''
    if (!output || !url || !sigPath) {
      throw new Error('Use --write --output latest.json --url <https github asset> --sig <file>')
    }
    const signature = await readFile(resolve(sigPath), 'utf8')
    if (Boolean(intelUrl) !== Boolean(intelSigPath)) {
      throw new Error('Use --url-intel and --sig-intel together')
    }
    const intelSignature = intelSigPath ? await readFile(resolve(intelSigPath), 'utf8') : undefined
    await writeManifest({ output: resolve(output), version, notes, url, signature, intelUrl, intelSignature })
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
