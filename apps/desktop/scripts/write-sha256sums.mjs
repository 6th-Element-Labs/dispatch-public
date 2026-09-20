#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function checksums(paths) {
  const names = paths.map(path => basename(path))
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) throw new Error(`duplicate artifact basename: ${duplicate}`)
  const records = []
  for (const path of paths) {
    records.push({ name: basename(path), sha256: await hashFile(path) })
  }
  return records.sort((left, right) => left.name.localeCompare(right.name))
}

export function formatChecksums(records) {
  return `${records.map(record => `${record.sha256}  ${record.name}`).join('\n')}\n`
}

async function main() {
  const index = process.argv.indexOf('--output')
  const outputArgument = index >= 0 ? process.argv[index + 1] : null
  const artifacts = process.argv.slice(index + 2)
  if (!outputArgument || !artifacts.length) {
    throw new Error('Use --output SHA256SUMS.txt followed by one or more artifacts')
  }
  const output = resolve(outputArgument)
  const content = formatChecksums(await checksums(artifacts.map(resolve)))
  try {
    const existing = await readFile(output, 'utf8')
    if (existing === content) {
      process.stdout.write(`${output} is current\n`)
      return
    }
    throw new Error(`${output} already exists with different content`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporary = `${output}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, output)
  process.stdout.write(`Wrote ${output}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`write-sha256sums: ${error.message}\n`)
    process.exitCode = 1
  })
}
