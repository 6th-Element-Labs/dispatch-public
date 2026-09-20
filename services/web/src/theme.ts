/**
 * Appearance preference: System (follow macOS), Light, or Dark.
 *
 * Tabler switches its whole token set on `data-bs-theme`, so applying the
 * resolved theme to the root element is all the presentation layer needs.
 * The choice is a browser-local preference like density and sidebar style.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'dispatch.ui.theme'
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ThemeRoot {
  setAttribute(name: string, value: string): void
  style: { colorScheme: string }
}

export interface ThemeMedia {
  matches: boolean
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
}

export function readThemePreference(storage: ThemeStorage): ThemePreference {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export interface ThemeController {
  readonly preference: ThemePreference
  readonly resolved: ResolvedTheme
  set(preference: ThemePreference): void
  dispose(): void
}

export function createThemeController(options: {
  root: ThemeRoot
  storage: ThemeStorage
  media: ThemeMedia | null
  onChange?: (state: { preference: ThemePreference; resolved: ResolvedTheme }) => void
}): ThemeController {
  const { root, storage, media, onChange } = options
  let preference = readThemePreference(storage)
  let resolved: ResolvedTheme = resolveTheme(preference, media?.matches ?? false)

  const apply = (): void => {
    resolved = resolveTheme(preference, media?.matches ?? false)
    root.setAttribute('data-bs-theme', resolved)
    root.style.colorScheme = resolved
    onChange?.({ preference, resolved })
  }

  const onMediaChange = (): void => { if (preference === 'system') apply() }
  media?.addEventListener('change', onMediaChange)
  apply()

  return {
    get preference() { return preference },
    get resolved() { return resolved },
    set(next) {
      preference = next
      try {
        if (next === 'system') storage.removeItem(THEME_STORAGE_KEY)
        else storage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        // A blocked store still gets the in-session theme.
      }
      apply()
    },
    dispose() { media?.removeEventListener('change', onMediaChange) },
  }
}
