import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

async function readPublicFile(templatePath, exportedPath) {
  try {
    return await readFile(resolve(root, templatePath), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return readFile(resolve(root, exportedPath), 'utf8')
  }
}

describe('public release workflow', () => {
  it('gates a signed Apple Silicon and Intel draft release', async () => {
    const workflow = await readPublicFile(
      'deploy/public/.github/workflows/release.yml',
      '.github/workflows/release.yml',
    )
    for (const required of [
      "tags: ['v*']",
      'environment: release',
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'macos-15-intel',
      'MACOSX_DEPLOYMENT_TARGET: "14.0"',
      'APPLE_CERTIFICATE',
      'APPLE_API_ISSUER',
      'node scripts/version-contract.mjs --expect "$VERSION"',
      'needs: [verify, macos-build]',
      'test -s "release/Dispatch_${VERSION}_${ARCH}.dmg"',
      'gh release create "$GITHUB_REF_NAME"',
      '--draft',
      'release:verify',
      'release:verify-updater',
      'write-sha256sums.mjs',
      'TAURI_SIGNING_PRIVATE_KEY',
      'notarytool submit "$DMG"',
      'xcrun stapler staple "$DMG"',
      '--url-intel',
      '--sig-intel',
      'latest.json',
    ]) {
      assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    const privateNames = [
      ['dispatch', 'ci'].join('-'),
      ['ci', 'sandbox'].join('-'),
    ].join('|')
    assert.doesNotMatch(workflow, new RegExp(`pull_request_target|workflow_dispatch|tauri-action@|${privateNames}`))
  })

  it('documents every signing and native acceptance gate', async () => {
    const runbook = await readPublicFile(
      'deploy/public/docs/RELEASING.md',
      'docs/RELEASING.md',
    )
    for (const required of [
      'Developer ID Application',
      'APPLE_CERTIFICATE',
      'APPLE_API_KEY_P8',
      'TAURI_SIGNING_PRIVATE_KEY',
      'codesign --verify --deep --strict',
      'spctl --assess --type execute',
      'xcrun stapler validate',
    ]) {
      assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })

  it('recovers only successful signed jobs under the original tag', async () => {
    const recovery = await readPublicFile(
      'deploy/public/.github/workflows/recover-release.yml',
      '.github/workflows/recover-release.yml',
    )
    for (const required of [
      'workflow_dispatch:',
      'environment: release-recovery',
      'SOURCE_RUN_ID',
      '.head_sha',
      'signed arm64',
      'signed x86_64',
      'actions/download-artifact@v4',
      'release:verify-updater',
      '--verify-tag',
      '--draft',
    ]) {
      assert.ok(recovery.includes(required), `missing recovery gate: ${required}`)
    }
  })
})
