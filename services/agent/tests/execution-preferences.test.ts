import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readExecutionPreferences, saveExecutionPreferences, threadExecutionParams, turnExecutionParams } from '../src/execution-preferences.js'

let directory: string
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dispatch-execution-'))
  path = join(directory, 'codex-execution.json')
  vi.stubEnv('DISPATCH_CODEX_EXECUTION_PREFERENCES', path)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })

it('defaults to full access so runtime upgrades cannot change the selected policy', () => {
  expect(readExecutionPreferences()).toEqual({ version: 1, mode: 'full-access' })
  expect(threadExecutionParams()).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  expect(turnExecutionParams()).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
})

it('reads the saved full-access choice again across a restart and each turn', () => {
  writeFileSync(path, JSON.stringify({ version: 1, mode: 'full-access' }))
  expect(threadExecutionParams()).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  expect(readExecutionPreferences(path)).toEqual({ version: 1, mode: 'full-access' })
  expect(turnExecutionParams()).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
  writeFileSync(path, JSON.stringify({ version: 1, mode: 'workspace' }))
  expect(threadExecutionParams()).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  expect(turnExecutionParams()).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } })
})

it.each(['{', 'null', '{"version":2,"mode":"full-access"}', '{"version":1,"mode":"typo"}'])(
  'rejects broken preferences rather than silently changing permissions: %s', value => {
    writeFileSync(path, value)
    expect(() => threadExecutionParams()).toThrow()
    expect(() => turnExecutionParams()).toThrow()
  },
)

it('serializes rapid changes and makes the saved choice readable after restart', async () => {
  await Promise.all([
    saveExecutionPreferences({ version: 1, mode: 'workspace' }),
    saveExecutionPreferences({ version: 1, mode: 'full-access' }),
  ])
  expect(readExecutionPreferences(path)).toEqual({ version: 1, mode: 'full-access' })
})
