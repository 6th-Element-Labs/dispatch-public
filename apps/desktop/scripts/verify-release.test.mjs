import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dmgVerificationCommands, verificationCommands, verifyRelease } from './verify-release.mjs'

describe('macOS release verification', () => {
  it('checks signature, Gatekeeper, and notarization staple', () => {
    const app = '/tmp/Dispatch.app'
    assert.deepEqual(verificationCommands(app), [
      ['codesign', ['--verify', '--deep', '--strict', app]],
      ['spctl', ['--assess', '--type', 'execute', app]],
      ['xcrun', ['stapler', 'validate', app]],
    ])
  })

  it('checks the outer DMG ticket and Gatekeeper assessment', () => {
    const dmg = '/tmp/Dispatch.dmg'
    assert.deepEqual(dmgVerificationCommands(dmg), [
      ['xcrun', ['stapler', 'validate', dmg]],
      ['spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]],
    ])
  })

  it('runs every app verification command', async () => {
    const calls = []
    await verifyRelease({ app: '/tmp/Dispatch.app' }, async (command, args) => {
      calls.push([command, args])
      return { stdout: '', stderr: '' }
    })
    assert.deepEqual(calls, verificationCommands('/tmp/Dispatch.app'))
  })

  it('reports the failed command and status', async () => {
    await assert.rejects(
      verifyRelease({ app: '/tmp/Dispatch.app' }, async command => {
        const error = new Error('rejected')
        error.code = 1
        error.command = command
        throw error
      }),
      /codesign failed \(1\): rejected/,
    )
  })
})
