// Downloads the pinned Node runtime that Dispatch.app bundles as a Tauri sidecar.
// The tarball must match both node-sidecar.json and nodejs.org's SHASUMS256.txt.
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pin = JSON.parse(readFileSync(join(root, 'node-sidecar.json'), 'utf8'))
const platform = 'darwin-arm64'
const triple = 'aarch64-apple-darwin'
const version = pin.version
const expected = pin.sha256[platform]
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{64}$/.test(expected ?? '')) fail(`node-sidecar.json is missing a valid version or ${platform} sha256`)

const tarballName = `node-v${version}-${platform}.tar.gz`
const base = `https://nodejs.org/dist/v${version}/`
const target = join(root, 'src-tauri', 'binaries', `node-${triple}`)
const marker = `${target}.sha256`

if (existsSync(target) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === expected) {
  console.log(`fetch-node: ${target} already matches ${tarballName}`)
  process.exit(0)
}

const tarball = Buffer.from(await (await fetchOk(base + tarballName)).arrayBuffer())
const actual = createHash('sha256').update(tarball).digest('hex')
if (actual !== expected) fail(`${tarballName} sha256 ${actual} does not match pinned ${expected}`)

const shasums = await (await fetchOk(base + 'SHASUMS256.txt')).text()
const upstream = shasums.split('\n').find((line) => line.endsWith(`  ${tarballName}`))?.split(/\s+/)[0]
if (upstream !== expected) fail(`nodejs.org SHASUMS256.txt lists ${upstream ?? 'nothing'} for ${tarballName}, pinned ${expected}`)

const work = mkdtempSync(join(tmpdir(), 'dispatch-node-'))
try {
  const archive = join(work, tarballName)
  writeFileSync(archive, tarball)
  execFileSync('tar', ['-xzf', archive, '-C', work])
  const extracted = join(work, `node-v${version}-${platform}`, 'bin', 'node')
  if (!existsSync(extracted)) fail(`${tarballName} did not contain bin/node`)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(extracted, target)
  chmodSync(target, 0o755)
  writeFileSync(marker, `${expected}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`fetch-node: installed Node v${version} at ${target}`)

async function fetchOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) fail(`GET ${url} returned ${response.status}`)
  return response
}

function fail(message) {
  console.error(`fetch-node: ${message}`)
  process.exit(1)
}
