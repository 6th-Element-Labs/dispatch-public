import { isNativeShell } from './model.js'
import type { ContextMenuItem } from './thread-context-menu.js'

export type PopupPoint = { readonly clientX: number; readonly clientY: number }

export type ContextMenuPopup = (
  items: readonly ContextMenuItem[],
  point?: PopupPoint,
) => Promise<string | null>

type TauriCore = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }

type PopupWindow = {
  readonly isTauri?: unknown
  readonly __TAURI__?: { readonly core?: TauriCore }
  readonly document?: Document
}

let htmlMenu: HTMLElement | undefined
let htmlResolve: ((id: string | null) => void) | undefined

export function createContextMenuPopup(win: PopupWindow): ContextMenuPopup {
  if (isNativeShell(win)) {
    return async (items) => {
      const invoke = win.__TAURI__?.core?.invoke
      if (typeof invoke !== 'function') throw new Error('Dispatch could not open the native menu')
      const chosen = await invoke('popup_context_menu', { items })
      if (chosen === null || chosen === undefined) return null
      if (typeof chosen !== 'string') throw new Error('Dispatch received an invalid menu result')
      return chosen
    }
  }
  return (items, point) => {
    const doc = win.document
    if (!doc) throw new Error('Dispatch could not open the thread menu')
    return popupHtmlContextMenu(items, point ?? { clientX: 0, clientY: 0 }, doc)
  }
}

export function popupHtmlContextMenu(
  items: readonly ContextMenuItem[],
  point: PopupPoint,
  doc: Document,
): Promise<string | null> {
  dismissHtmlMenu(null)
  const menu = doc.createElement('div')
  menu.className = 'dispatch-thread-context-menu'
  menu.dataset.threadContextMenu = ''
  menu.setAttribute('role', 'menu')
  for (const item of items) {
    if (item.kind === 'separator') {
      const rule = doc.createElement('div')
      rule.className = 'dropdown-divider'
      menu.append(rule)
      continue
    }
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'dropdown-item'
    button.setAttribute('role', 'menuitem')
    button.textContent = item.label
    button.disabled = !item.enabled
    button.addEventListener('click', () => dismissHtmlMenu(item.id))
    menu.append(button)
  }
  htmlMenu = menu
  doc.body.append(menu)
  const bounds = menu.getBoundingClientRect()
  const left = Math.max(8, Math.min(point.clientX || 8, winWidth(doc) - bounds.width - 8))
  const top = Math.max(8, Math.min(point.clientY || 8, winHeight(doc) - bounds.height - 8))
  menu.style.position = 'fixed'
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.right = 'auto'
  menu.style.bottom = 'auto'
  menu.style.transform = 'none'
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismissHtmlMenu(null)
  }
  const onPointer = (event: Event) => {
    if (htmlMenu && !htmlMenu.contains(event.target as Node)) dismissHtmlMenu(null)
  }
  doc.addEventListener('keydown', onKey)
  doc.defaultView?.requestAnimationFrame(() => {
    doc.addEventListener('mousedown', onPointer)
  })
  return new Promise((resolve) => {
    htmlResolve = (id) => {
      doc.removeEventListener('keydown', onKey)
      doc.removeEventListener('mousedown', onPointer)
      resolve(id)
    }
  })
}

function dismissHtmlMenu(id: string | null): void {
  htmlMenu?.remove()
  htmlMenu = undefined
  const resolve = htmlResolve
  htmlResolve = undefined
  resolve?.(id)
}

function winWidth(doc: Document): number {
  return doc.defaultView?.innerWidth ?? 0
}

function winHeight(doc: Document): number {
  return doc.defaultView?.innerHeight ?? 0
}
