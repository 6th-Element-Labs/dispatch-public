import { describe, expect, it } from 'vitest'
import { markSetupSeen, SETUP_GMAIL_URL, SETUP_INSTALL_URL, SETUP_SEEN_KEY, SETUP_STEPS, setupSeen } from './setup-guide.js'

function memoryStorage(start: Record<string, string> = {}): Storage {
  const data = { ...start }
  return {
    get length() { return Object.keys(data).length },
    clear() { for (const key of Object.keys(data)) delete data[key] },
    getItem(key: string) { return Object.hasOwn(data, key) ? data[key]! : null },
    key(index: number) { return Object.keys(data)[index] ?? null },
    removeItem(key: string) { delete data[key] },
    setItem(key: string, value: string) { data[key] = value },
  }
}

describe('setup guide', () => {
  it('treats a missing flag as not seen', () => {
    expect(setupSeen(memoryStorage())).toBe(false)
  })

  it('writes dispatch.setup.seen=1 and then reports seen', () => {
    const storage = memoryStorage()
    markSetupSeen(storage)
    expect(storage.getItem(SETUP_SEEN_KEY)).toBe('1')
    expect(setupSeen(storage)).toBe(true)
  })

  it('treats blocked storage as not seen and does not throw', () => {
    const blocked = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    }
    expect(setupSeen(blocked)).toBe(false)
    expect(() => markSetupSeen(blocked)).not.toThrow()
  })

  it('pins the three static steps and official URLs', () => {
    expect(SETUP_STEPS.map((step) => step.title)).toEqual(['Install Codex', 'Sign in to ChatGPT', 'Connect Gmail'])
    expect(SETUP_INSTALL_URL).toBe('https://developers.openai.com/codex/cli')
    expect(SETUP_GMAIL_URL).toBe('codex://plugins/gmail@openai-curated')
    expect(SETUP_STEPS[0]?.href).toBe(SETUP_INSTALL_URL)
    expect(SETUP_STEPS[2]?.href).toBe(SETUP_GMAIL_URL)
    expect(SETUP_STEPS[1]?.detail).toContain('codex login')
    expect(SETUP_STEPS[2]?.fallback).toContain('/plugins')
  })

})
