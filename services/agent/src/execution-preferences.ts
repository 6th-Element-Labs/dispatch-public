import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultCodexWorkspace } from './codex-bindings.js'

export interface ExecutionPreferences {
  readonly version: 1
  readonly mode: 'workspace' | 'full-access'
}

export function parseExecutionPreferences(value: unknown): ExecutionPreferences {
  const record = value as Partial<ExecutionPreferences> | null
  if (!record || record.version !== 1 || !['workspace', 'full-access'].includes(String(record.mode))
    || Object.keys(record).some(key => !['version', 'mode'].includes(key))) {
    throw new Error('Expected version 1 and mode full-access or workspace')
  }
  return { version: 1, mode: record.mode! }
}

/** Agent-owned, per-installation choice; never changes the global Codex config. */
export function executionPreferencesPath(): string {
  return process.env.DISPATCH_CODEX_EXECUTION_PREFERENCES
    ?? join(homedir(), 'Library', 'Application Support', 'Dispatch', 'codex-execution.json')
}

export function readExecutionPreferences(path = executionPreferencesPath()): ExecutionPreferences {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, mode: 'full-access' }
    throw new Error(`Dispatch Codex execution preference could not be read: ${String(error)}`)
  }
  return parseExecutionPreferences(value)
}

let pendingSave: Promise<unknown> = Promise.resolve()
export function saveExecutionPreferences(value: unknown, path = executionPreferencesPath()): Promise<ExecutionPreferences> {
  const preferences = parseExecutionPreferences(value)
  const save = pendingSave.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(preferences)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    return preferences
  })
  pendingSave = save
  return save
}

/** Reapply a selected mode on resume so runtime defaults cannot downgrade it. */
export function threadExecutionParams() {
  return readExecutionPreferences().mode === 'full-access'
    ? { approvalPolicy: 'never' as const, sandbox: 'danger-full-access' as const }
    : { approvalPolicy: 'on-request' as const, sandbox: 'workspace-write' as const }
}

/** Covers threads already loaded before the preference changed. */
export function turnExecutionParams() {
  return readExecutionPreferences().mode === 'full-access'
    ? { approvalPolicy: 'never' as const, sandboxPolicy: { type: 'dangerFullAccess' as const } }
    : { approvalPolicy: 'on-request' as const, sandboxPolicy: {
      type: 'workspaceWrite' as const, writableRoots: [defaultCodexWorkspace()], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    } }
}
