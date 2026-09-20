import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatNotices,
  isApproved,
  normalizeLicense,
  reachableCargoPackageIds,
  validateRuntimePins,
  validatePackages,
} from './check-dependency-licenses.mjs'

const policy = {
  approved: ['Apache-2.0', 'Apache-2.0 OR MIT', 'MIT'],
  overrides: {
    'npm:@tabler/icons-webfont@3.46.0': {
      license: 'MIT',
      evidence: 'Package description and upstream repository license',
    },
  },
}

describe('dependency license policy', () => {
  it('normalizes equivalent simple OR expressions', () => {
    assert.equal(normalizeLicense('MIT OR Apache-2.0'), 'Apache-2.0 OR MIT')
    assert.equal(normalizeLicense('MIT/Apache-2.0'), 'Apache-2.0 OR MIT')
  })

  it('accepts approved licenses and rejects unapproved licenses', () => {
    assert.equal(isApproved('Apache-2.0', policy), true)
    assert.equal(isApproved('GPL-3.0-only', policy), false)
  })

  it('requires evidence-backed overrides for missing metadata', () => {
    assert.throws(
      () => validatePackages([{ ecosystem: 'npm', name: 'unknown', version: '1.0.0', license: null }], policy),
      /missing license/,
    )
    assert.deepEqual(
      validatePackages([
        { ecosystem: 'npm', name: '@tabler/icons-webfont', version: '3.46.0', license: null },
      ], policy),
      [{
        ecosystem: 'npm',
        name: '@tabler/icons-webfont',
        version: '3.46.0',
        license: 'MIT',
        evidence: 'Package description and upstream repository license',
      }],
    )
  })

  it('requires and includes full license text for shipped packages', () => {
    assert.throws(
      () => formatNotices([{ ecosystem: 'npm', name: 'pkg', version: '1.0.0', license: 'MIT' }]),
      /license text/,
    )
    const notices = formatNotices([{
      ecosystem: 'runtime',
      name: 'Node.js',
      version: '22.23.2',
      license: 'Node.js',
      source: 'https://nodejs.org/',
      licenseText: 'Node.js license text',
    }])
    assert.match(notices, /Node\.js@22\.23\.2/)
    assert.match(notices, /Node\.js license text/)
  })

  it('keeps only normal dependencies in the shipped Cargo graph', () => {
    const ids = reachableCargoPackageIds({
      resolve: {
        root: 'root',
        nodes: [
          {
            id: 'root',
            deps: [
              { pkg: 'normal', dep_kinds: [{ kind: null }] },
              { pkg: 'build', dep_kinds: [{ kind: 'build' }] },
              { pkg: 'dev', dep_kinds: [{ kind: 'dev' }] },
            ],
          },
          { id: 'normal', deps: [{ pkg: 'nested', dep_kinds: [{ kind: null }] }] },
          { id: 'nested', deps: [] },
          { id: 'build', deps: [] },
          { id: 'dev', deps: [] },
        ],
      },
    })
    assert.deepEqual([...ids].sort(), ['nested', 'normal'])
  })

  it('keeps the Node notice aligned with the bundled runtime pin', () => {
    const policy = { runtimes: [{ name: 'Node.js', version: '22.23.2' }] }
    assert.doesNotThrow(() => validateRuntimePins(policy, { version: '22.23.2' }))
    assert.throws(
      () => validateRuntimePins(policy, { version: '22.24.0' }),
      /Node\.js notice is 22\.23\.2.*runtime is 22\.24\.0/,
    )
  })
})
