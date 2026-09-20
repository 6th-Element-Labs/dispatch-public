import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { assertOneVersion, parseCargoPackageVersion, readVersions } from './version-contract.mjs'

const root = resolve(import.meta.dirname, '..')

describe('release version contract', () => {
  it('reads one version from every shipped package', async () => {
    const records = await readVersions(root)
    assert.equal(records.length, 6)
    assert.deepEqual([...new Set(records.map(record => record.version))], ['0.1.5'])
    assert.doesNotThrow(() => assertOneVersion(records, '0.1.5'))
  })

  it('reports every mismatched package', () => {
    assert.throws(
      () => assertOneVersion([
        { path: 'a', version: '0.1.5' },
        { path: 'b', version: '0.1.0' },
      ], '0.1.5'),
      /b=0\.1\.0/,
    )
  })

  it('never reads a version from a later Cargo section', () => {
    assert.equal(
      parseCargoPackageVersion('[package]\nname = "dispatch"\nversion = "0.1.5"\n\n[dependencies]\nserde = { version = "1" }\n'),
      '0.1.5',
    )
    assert.throws(
      () => parseCargoPackageVersion('[package]\nname = "dispatch"\n\n[dependencies]\nserde = { version = "1" }\n'),
      /package version/,
    )
  })
})
