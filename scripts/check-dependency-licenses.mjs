#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const lockfiles = [
  'services/web/package-lock.json',
  'services/mail/package-lock.json',
  'services/agent/package-lock.json',
  'apps/desktop/package-lock.json',
]

export function normalizeLicense(value) {
  const normalized = value.trim()
    .replace(/\s*\/\s*/g, ' OR ')
    .replace(/\s+/g, ' ')
  if (/[()]/.test(normalized) || /\b(?:AND|WITH)\b/.test(normalized)) return normalized
  return normalized.split(/\s+OR\s+/).sort().join(' OR ')
}

export function isApproved(value, policy) {
  const approved = new Set(policy.approved.map(normalizeLicense))
  return approved.has(normalizeLicense(value))
}

export function validatePackages(packages, policy) {
  return packages.map(record => {
    const key = `${record.ecosystem}:${record.name}@${record.version}`
    const override = policy.overrides[key]
    const license = record.license ?? override?.license
    if (!license) throw new Error(`${key} is missing license metadata`)
    if (!isApproved(license, policy)) {
      throw new Error(`${key} uses unapproved license expression: ${license}`)
    }
    return {
      ...record,
      license: normalizeLicense(license),
      ...(override?.evidence ? { evidence: override.evidence } : {}),
      ...(override?.licenseFile ? { licenseFile: override.licenseFile } : {}),
    }
  })
}

export function validateRuntimePins(policy, nodePin) {
  const node = (policy.runtimes ?? []).find(runtime => runtime.name === 'Node.js')
  if (!node) throw new Error('Dependency license policy has no Node.js runtime notice')
  if (node.version !== nodePin.version) {
    throw new Error(`Node.js notice is ${node.version}, but the bundled runtime is ${nodePin.version}`)
  }
}

function npmName(path, value) {
  if (value.name) return value.name
  const marker = 'node_modules/'
  const index = path.lastIndexOf(marker)
  if (index < 0) return path
  return path.slice(index + marker.length)
}

async function npmPackages() {
  const records = []
  for (const lockfile of lockfiles) {
    const lock = JSON.parse(await readFile(resolve(root, lockfile), 'utf8'))
    const directWebDependencies = lockfile === 'services/web/package-lock.json'
      ? new Set(Object.keys(lock.packages?.['']?.dependencies ?? {}))
      : null
    for (const [path, value] of Object.entries(lock.packages ?? {})) {
      if (!path || !value.version || value.dev === true) continue
      const name = npmName(path, value)
      if (directWebDependencies && !directWebDependencies.has(name)) continue
      records.push({
        ecosystem: 'npm',
        name,
        version: value.version,
        license: value.license ?? null,
        source: value.resolved ?? 'npm registry',
        packageDirectory: resolve(root, dirname(lockfile), path),
      })
    }
  }
  return records
}

export function reachableCargoPackageIds(metadata) {
  const nodes = new Map((metadata.resolve?.nodes ?? []).map(node => [node.id, node]))
  const pending = [metadata.resolve?.root].filter(Boolean)
  const reachable = new Set()
  while (pending.length) {
    const id = pending.pop()
    const node = nodes.get(id)
    if (!node) continue
    for (const dependency of node.deps ?? []) {
      if (!(dependency.dep_kinds ?? []).some(kind => kind.kind === null)) continue
      if (reachable.has(dependency.pkg)) continue
      reachable.add(dependency.pkg)
      pending.push(dependency.pkg)
    }
  }
  return reachable
}

async function cargoPackages() {
  const { stdout } = await execute('cargo', [
    'metadata',
    '--format-version=1',
    '--filter-platform',
    'aarch64-apple-darwin',
    '--manifest-path',
    'apps/desktop/src-tauri/Cargo.toml',
  ], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  const metadata = JSON.parse(stdout)
  const shipped = reachableCargoPackageIds(metadata)
  return metadata.packages
    .filter(record => shipped.has(record.id))
    .map(record => ({
      ecosystem: 'cargo',
      name: record.name,
      version: record.version,
      license: record.license ?? null,
      source: record.repository ?? record.source ?? 'crates.io',
      packageDirectory: dirname(record.manifest_path),
      authors: record.authors ?? [],
    }))
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function authorText(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return [value.name, value.email && `<${value.email}>`].filter(Boolean).join(' ')
}

async function packageAuthors(record) {
  if (record.authors?.length) return record.authors
  if (!record.packageDirectory) return []
  try {
    const manifest = JSON.parse(await readFile(resolve(record.packageDirectory, 'package.json'), 'utf8'))
    return [manifest.author, ...(manifest.contributors ?? [])].map(authorText).filter(Boolean)
  } catch {
    return []
  }
}

async function packageLicenseText(record, policy) {
  const authors = await packageAuthors(record)
  if (authors.length) record.authors = authors
  if (record.licenseFile) return readFile(resolve(root, record.licenseFile), 'utf8')
  let entries
  try {
    entries = await readdir(record.packageDirectory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`${record.ecosystem}:${record.name}@${record.version} license directory is unavailable: ${error.message}`)
  }
  const candidates = entries
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name))
    .map(entry => entry.name)
    .sort()
  if (!candidates.length) {
    throw new Error(`${record.ecosystem}:${record.name}@${record.version} has no actual bundled or approved license text`)
  }
  const texts = []
  for (const candidate of candidates) {
    texts.push(`--- ${candidate} ---\n${(await readFile(resolve(record.packageDirectory, candidate), 'utf8')).trim()}`)
  }
  return `${texts.join('\n\n')}\n`
}

async function runtimePackages(policy) {
  const records = []
  for (const runtime of policy.runtimes ?? []) {
    const response = await fetch(runtime.licenseUrl, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`GET ${runtime.licenseUrl} returned ${response.status}`)
    const licenseText = await response.text()
    const actual = createHash('sha256').update(licenseText).digest('hex')
    if (actual !== runtime.licenseSha256) {
      throw new Error(`${runtime.name} ${runtime.version} license sha256 ${actual} does not match ${runtime.licenseSha256}`)
    }
    records.push({ ecosystem: 'runtime', ...runtime, licenseText })
  }
  return records
}

export function formatNotices(packages) {
  for (const record of packages) {
    if (!record.licenseText?.trim()) {
      throw new Error(`${record.ecosystem}:${record.name}@${record.version} is missing license text`)
    }
  }
  const sorted = [...packages].sort((left, right) => (
    left.ecosystem.localeCompare(right.ecosystem)
      || left.name.localeCompare(right.name)
      || left.version.localeCompare(right.version)
  ))
  const lines = [
    '# Third-Party Notices',
    '',
    'Dispatch includes the following third-party packages. Their licenses remain',
    'in effect. Source links identify the package origin used by the lockfiles.',
    '',
  ]
  for (const ecosystem of ['cargo', 'npm', 'runtime']) {
    const records = sorted.filter(record => record.ecosystem === ecosystem)
    lines.push(`## ${ecosystem}`, '', '| Package | Version | License | Authors | Source |', '|---|---:|---|---|---|')
    for (const record of records) {
      lines.push(`| ${escapeCell(record.name)} | ${escapeCell(record.version)} | ${escapeCell(record.license)} | ${escapeCell(record.authors?.join('; ') ?? '')} | ${escapeCell(record.source)} |`)
    }
    lines.push('')
  }
  const overrides = sorted.filter(record => record.evidence)
  if (overrides.length) {
    lines.push('## Metadata overrides', '')
    for (const record of overrides) {
      lines.push(`- \`${record.name}@${record.version}\`: ${record.evidence}`)
    }
    lines.push('')
  }
  const texts = new Map()
  for (const record of sorted) {
    const text = record.licenseText.trim()
    const hash = createHash('sha256').update(text).digest('hex')
    const group = texts.get(hash) ?? { text, packages: [] }
    group.packages.push(`${record.ecosystem}:${record.name}@${record.version}`)
    texts.set(hash, group)
  }
  lines.push('## License texts', '')
  for (const [hash, group] of [...texts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${hash.slice(0, 12)}`, '', `Applies to: ${group.packages.sort().map(name => `\`${name}\``).join(', ')}`, '')
    lines.push(...group.text.split('\n').map(line => {
      const clean = line.trimEnd().replaceAll('\t', '    ')
      return clean ? `    ${clean}` : ''
    }), '')
  }
  return `${lines.join('\n').trim()}\n`
}

export async function collectPackages(policy) {
  const records = validatePackages([
    ...await npmPackages(),
    ...await cargoPackages(),
  ], policy)
  const unique = [...new Map(records.map(record => [
    `${record.ecosystem}:${record.name}@${record.version}`,
    record,
  ])).values()]
  const missing = []
  for (const record of unique) {
    try {
      record.licenseText = await packageLicenseText(record, policy)
    } catch (error) {
      missing.push(error.message)
    }
  }
  if (missing.length) throw new Error(missing.join('\n'))
  return [...unique, ...await runtimePackages(policy)]
}

async function main() {
  const policy = JSON.parse(await readFile(resolve(root, 'deploy/public-license-policy.json'), 'utf8'))
  if (policy.schema !== 'dispatch.license_policy.v1') throw new Error('Unsupported dependency license policy')
  const nodePin = JSON.parse(await readFile(resolve(root, 'apps/desktop/node-sidecar.json'), 'utf8'))
  validateRuntimePins(policy, nodePin)
  const notices = formatNotices(await collectPackages(policy))
  const outputIndex = process.argv.indexOf('--output')
  const checkIndex = process.argv.indexOf('--check')
  if ((outputIndex < 0) === (checkIndex < 0)) {
    throw new Error('Use exactly one of --output THIRD_PARTY_NOTICES.md or --check THIRD_PARTY_NOTICES.md')
  }
  const path = resolve(root, process.argv[(outputIndex >= 0 ? outputIndex : checkIndex) + 1])
  if (checkIndex >= 0) {
    const existing = await readFile(path, 'utf8')
    if (existing !== notices) throw new Error(`${path} is stale; regenerate third-party notices`)
    process.stdout.write(`Dependency licenses and ${path} are current\n`)
    return
  }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, notices)
  await rename(temporary, path)
  process.stdout.write(`Wrote ${path}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`check-dependency-licenses: ${error.message}\n`)
    process.exitCode = 1
  })
}
