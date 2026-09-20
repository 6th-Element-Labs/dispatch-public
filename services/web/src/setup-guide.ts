export const SETUP_SEEN_KEY = 'dispatch.setup.seen'
export const SETUP_INSTALL_URL = 'https://developers.openai.com/codex/cli'
export const SETUP_GMAIL_URL = 'codex://plugins/gmail@openai-curated'

export interface SetupStep {
  readonly title: string
  readonly href?: string
  readonly action?: string
  readonly detail?: string
  readonly fallback?: string
}

export const SETUP_STEPS: readonly SetupStep[] = [
  { title: 'Install Codex', href: SETUP_INSTALL_URL, action: 'Open install guide' },
  { title: 'Sign in to ChatGPT', detail: 'Run `codex login`, or sign in in ChatGPT desktop.' },
  {
    title: 'Connect Gmail',
    href: SETUP_GMAIL_URL,
    action: 'Open Codex',
    fallback: 'Open ChatGPT desktop Plugins, or run `codex`, then /plugins, then connect Google.',
  },
]

export function setupSeen(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(SETUP_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function markSetupSeen(storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(SETUP_SEEN_KEY, '1')
  } catch {
    return
  }
}
