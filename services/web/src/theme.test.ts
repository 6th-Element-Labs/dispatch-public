import { describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, createThemeController, readThemePreference, resolveTheme, type ThemeMedia } from './theme.js'

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    store,
  }
}

function fakeRoot() {
  const attributes = new Map<string, string>()
  return { attributes, style: { colorScheme: '' }, setAttribute: (name: string, value: string) => { attributes.set(name, value) } }
}

function fakeMedia(matches: boolean): ThemeMedia & { flip(matches: boolean): void } {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const media = {
    matches,
    addEventListener: (_: 'change', listener: (event: { matches: boolean }) => void) => { listeners.add(listener) },
    removeEventListener: (_: 'change', listener: (event: { matches: boolean }) => void) => { listeners.delete(listener) },
    flip(next: boolean) { media.matches = next; for (const listener of listeners) listener({ matches: next }) },
  }
  return media
}

describe('theme preference', () => {
  it('defaults to system and ignores unknown stored values', () => {
    expect(readThemePreference(memoryStorage())).toBe('system')
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'sepia' }))).toBe('system')
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark')
  })

  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    expect(readThemePreference(broken)).toBe('system')
    const root = fakeRoot()
    const controller = createThemeController({ root, storage: broken, media: fakeMedia(true) })
    controller.set('light')
    expect(root.attributes.get('data-bs-theme')).toBe('light')
  })

  it('resolves system from the OS preference and explicit choices as themselves', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('theme controller', () => {
  it('applies the resolved theme to the root on creation', () => {
    const root = fakeRoot()
    createThemeController({ root, storage: memoryStorage(), media: fakeMedia(true) })
    expect(root.attributes.get('data-bs-theme')).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
  })

  it('follows OS changes only while the preference is system', () => {
    const root = fakeRoot()
    const media = fakeMedia(false)
    const onChange = vi.fn()
    const controller = createThemeController({ root, storage: memoryStorage(), media, onChange })
    expect(root.attributes.get('data-bs-theme')).toBe('light')
    media.flip(true)
    expect(root.attributes.get('data-bs-theme')).toBe('dark')
    controller.set('light')
    media.flip(false)
    media.flip(true)
    expect(root.attributes.get('data-bs-theme')).toBe('light')
    expect(onChange).toHaveBeenLastCalledWith({ preference: 'light', resolved: 'light' })
  })

  it('persists explicit choices and clears the key for system', () => {
    const storage = memoryStorage()
    const controller = createThemeController({ root: fakeRoot(), storage, media: fakeMedia(false) })
    controller.set('dark')
    expect(storage.store.get(THEME_STORAGE_KEY)).toBe('dark')
    expect(controller.resolved).toBe('dark')
    controller.set('system')
    expect(storage.store.has(THEME_STORAGE_KEY)).toBe(false)
    expect(controller.resolved).toBe('light')
  })

  it('works without a media query and stops listening on dispose', () => {
    const root = fakeRoot()
    const controller = createThemeController({ root, storage: memoryStorage(), media: null })
    expect(root.attributes.get('data-bs-theme')).toBe('light')
    const media = fakeMedia(false)
    const listening = createThemeController({ root, storage: memoryStorage(), media })
    listening.dispose()
    media.flip(true)
    expect(root.attributes.get('data-bs-theme')).toBe('light')
    controller.dispose()
  })
})
