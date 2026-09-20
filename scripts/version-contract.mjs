#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packagePaths = [
  ['apps/desktop/package.json', 'json'],
  ['apps/desktop/src-tauri/tauri.conf.json', 'json'],
  ['apps/desktop/src-tauri/Cargo.toml', 'cargo'],
  ['services/web/package.json', 'json'],
  ['services/mail/package.json', 'json'],
  ['services/agent/package.json', 'json'],
]

export function parseCargoPackageVersion(content) {
  const packageHeader = content.search(/^\[package\]\s*$/m)
  if (packageHeader < 0) throw new Error('Cargo manifest has no [package] section')
  const afterHeader = content.indexOf('\n', packageHeader)
  const remaining = content.slice(afterHeader + 1)
  const nextSection = remaining.search(/^\[/m)
  const packageSection = nextSection >= 0 ? remaining.slice(0, nextSection) : remaining
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (!version) throw new Error('Cargo [package] section has no package version')
  return version
}

export async function readVersions(root) {
  const records = []
  for (const [path, kind] of packagePaths) {
    const content = await readFile(resolve(root, path), 'utf8')
    let version
    if (kind === 'json') version = JSON.parse(content).version
    else version = parseCargoPackageVersion(content)
    if (typeof version !== 'string' || !version) throw new Error(`${path} has no release version`)
    records.push({ path, version })
  }
  return records
}

export function assertOneVersion(records, expected) {
  const mismatches = records.filter(record => record.version !== expected)
  if (mismatches.length) {
    throw new Error(`Release version mismatch: ${mismatches.map(record => `${record.path}=${record.version}`).join(', ')}`)
  }
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const index = process.argv.indexOf('--expect')
  const expected = index >= 0 ? process.argv[index + 1] : null
  if (!expected || !/^\d+\.\d+\.\d+$/.test(expected)) {
    throw new Error('Use --expect with a stable semantic version such as 0.1.0')
  }
  const records = await readVersions(root)
  assertOneVersion(records, expected)
  for (const record of records) process.stdout.write(`${record.path}: ${record.version}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`version-contract: ${error.message}\n`)
    process.exitCode = 1
  })
}
