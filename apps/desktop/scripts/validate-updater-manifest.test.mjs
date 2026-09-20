import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  buildManifest,
  githubReleaseAssetUrl,
  validateManifest,
} from './validate-updater-manifest.mjs'

const SIGNATURE = 'untrusted comment: minisign signature\nRWTestSignatureLine\n'
const ARCHIVE = 'Dispatch.app.tar.gz'
const URL = `https://github.com/6th-Element-Labs/dispatch-public/releases/download/v0.1.0/${ARCHIVE}`
const INTEL_ARCHIVE = 'Dispatch-Intel.app.tar.gz'
const INTEL_URL = `https://github.com/6th-Element-Labs/dispatch-public/releases/download/v0.1.0/${INTEL_ARCHIVE}`

function validManifest(overrides = {}) {
  return {
    ...buildManifest({
      version: '0.1.0',
      notes: 'First public release.',
      pubDate: '2026-09-20T00:00:00Z',
      url: URL,
      signature: SIGNATURE,
    }),
    ...overrides,
  }
}

describe('updater manifest validation', () => {
  it('accepts a signed darwin-aarch64 GitHub release', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dispatch-updater-'))
    try {
      await writeFile(resolve(directory, ARCHIVE), 'archive-bytes')
      await writeFile(resolve(directory, `${ARCHIVE}.sig`), SIGNATURE)
      const manifest = validManifest()
      assert.equal(manifest.version, '0.1.0')
      assert.ok(manifest.platforms['darwin-aarch64'])
      assert.match(manifest.platforms['darwin-aarch64'].signature, /^untrusted comment:/)
      assert.ok(manifest.platforms['darwin-aarch64'].url.endsWith('.app.tar.gz'))
      await validateManifest(manifest, { version: '0.1.0', assetsDir: directory })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires both local archives and signatures for a two-platform release', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dispatch-updater-dual-'))
    try {
      await writeFile(resolve(directory, ARCHIVE), 'arm archive')
      await writeFile(resolve(directory, `${ARCHIVE}.sig`), SIGNATURE)
      await writeFile(resolve(directory, INTEL_ARCHIVE), 'intel archive')
      const manifest = buildManifest({
        version: '0.1.0',
        url: URL,
        signature: SIGNATURE,
        intelUrl: INTEL_URL,
        intelSignature: SIGNATURE,
      })
      assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64'])
      await assert.rejects(
        validateManifest(manifest, { version: '0.1.0', assetsDir: directory }),
        /ENOENT|signature/,
      )
      await writeFile(resolve(directory, `${INTEL_ARCHIVE}.sig`), SIGNATURE)
      await validateManifest(manifest, { version: '0.1.0', assetsDir: directory })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a URL without a matching local archive', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dispatch-updater-missing-'))
    try {
      await writeFile(resolve(directory, `${ARCHIVE}.sig`), SIGNATURE)
      await assert.rejects(
        validateManifest(validManifest(), { version: '0.1.0', assetsDir: directory }),
        /updater archive is missing/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a signature that is a URL or path', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dispatch-updater-sig-'))
    try {
      await writeFile(resolve(directory, ARCHIVE), 'archive-bytes')
      await writeFile(resolve(directory, `${ARCHIVE}.sig`), SIGNATURE)
      await assert.rejects(
        validateManifest(validManifest({
          platforms: { 'darwin-aarch64': { url: URL, signature: 'https://example.com/Dispatch.app.tar.gz.sig' } },
        }), { version: '0.1.0', assetsDir: directory }),
        /minisign text/,
      )
      await assert.rejects(
        validateManifest(validManifest({
          platforms: { 'darwin-aarch64': { url: URL, signature: '/tmp/Dispatch.app.tar.gz.sig' } },
        }), { version: '0.1.0', assetsDir: directory }),
        /minisign text/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a missing .sig or a version mismatch', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dispatch-updater-mismatch-'))
    try {
      await writeFile(resolve(directory, ARCHIVE), 'archive-bytes')
      await assert.rejects(
        validateManifest(validManifest(), { version: '0.1.0', assetsDir: directory }),
        /ENOENT|signature/,
      )
      await writeFile(resolve(directory, `${ARCHIVE}.sig`), SIGNATURE)
      await assert.rejects(
        validateManifest(validManifest(), { version: '0.1.1', assetsDir: directory }),
        /does not match/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects extra platforms and non-GitHub URLs', () => {
    assert.equal(githubReleaseAssetUrl('http://github.com/6th-Element-Labs/dispatch-public/releases/download/v0.1.0/Dispatch.app.tar.gz'), false)
    assert.equal(githubReleaseAssetUrl(URL), true)
  })
})
