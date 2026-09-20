import { isNativeShell } from './model.js'

type LinkWindow = { isTauri?: unknown; __TAURI__?: { core?: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> } } }
/** Capture navigation before provider HTML or restored chat links can unload mail. */
export function installWebLinks(root: HTMLElement, win: LinkWindow, onError: (error: unknown) => void): void {
  const open = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : undefined
    const anchor = target?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || !root.contains(anchor) || event.defaultPrevented || event.button > 1) return
    const href = anchor.getAttribute('href')?.trim() ?? ''
    if (!href || href.startsWith('#')) return
    let url: URL
    try { url = new URL(href, root.ownerDocument.baseURI) } catch { event.preventDefault(); onError(new Error('This link is not a valid URL.')); return }
    if (!['http:', 'https:', 'mailto:', 'codex:'].includes(url.protocol)) {
      event.preventDefault(); onError(new Error(`Dispatch cannot open this ${url.protocol} link.`)); return
    }
    if (isNativeShell(win)) {
      event.preventDefault()
      const invoke = win.__TAURI__?.core?.invoke
      if (!invoke) { onError(new Error('Web navigation is unavailable.')); return }
      void invoke('open_web_link', { url: url.href }).catch(onError)
    } else if (url.protocol !== 'mailto:') {
      // Browser development retains its own history too; web pages get a new tab.
      anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'
    }
  }
  root.addEventListener('click', open, true)
  root.addEventListener('auxclick', open, true)
}
