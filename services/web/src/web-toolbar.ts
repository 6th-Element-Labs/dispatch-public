import '@tabler/icons-webfont/dist/tabler-icons.min.css'
import './web-toolbar.css'

type BrowserState = { url: string; canGoBack: boolean; canGoForward: boolean }
const root = document.getElementById('web-toolbar')!
root.innerHTML = `<header aria-label="Web navigation"><button data-action="back" aria-label="Back" title="Back (⌘[)" disabled><i class="ti ti-arrow-left" aria-hidden="true"></i></button><button data-action="forward" aria-label="Forward" title="Forward (⌘])" disabled><i class="ti ti-arrow-right" aria-hidden="true"></i></button><button data-action="reload" aria-label="Reload page" title="Reload page"><i class="ti ti-refresh" aria-hidden="true"></i></button><span class="web-address" data-address>Opening web page…</span><button data-action="external" disabled><i class="ti ti-external-link" aria-hidden="true"></i>Open in Browser</button><button class="web-return" data-action="close"><i class="ti ti-x" aria-hidden="true"></i>Return to Mail</button></header><div class="web-status" data-status role="status">Your email stays open. Close this window or press ⌘W to return.</div>`
const core = (window as unknown as { __TAURI__?: { core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } } }).__TAURI__?.core
const status = root.querySelector<HTMLElement>('[data-status]')!
let checking = false
let actionError = ''
async function refresh(): Promise<void> {
  if (!core || checking) return
  checking = true
  try {
    const state = await core.invoke<BrowserState>('web_link_state')
    root.querySelector<HTMLButtonElement>('[data-action="back"]')!.disabled = !state.canGoBack
    root.querySelector<HTMLButtonElement>('[data-action="forward"]')!.disabled = !state.canGoForward
    const address = root.querySelector<HTMLElement>('[data-address]')!
    const url = new URL(state.url)
    address.textContent = url.hostname || 'Opening web page…'
    address.title = url.href
    root.querySelector<HTMLButtonElement>('[data-action="external"]')!.disabled = !['http:', 'https:'].includes(url.protocol)
    status.textContent = actionError || 'Your email stays open. Close this window or press ⌘W to return.'
  } catch (error) { status.textContent = `Page controls unavailable: ${String(error)}. Use Navigate → Return to Mail.` }
  finally { checking = false }
}
root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.addEventListener('click', () => {
  if (!core) { status.textContent = 'These controls require the Dispatch desktop app.'; return }
  actionError = ''
  void core.invoke('web_link_action', { action: button.dataset.action }).then(refresh).catch(error => { actionError = String(error); status.textContent = actionError })
}))
if (!core) status.textContent = 'These controls require the Dispatch desktop app.'
void refresh()
window.setInterval(() => void refresh(), 800)
