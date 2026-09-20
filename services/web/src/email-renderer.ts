import DOMPurify from 'dompurify'
import { isLightBackground, rewriteStyleForDark } from './mail-colors.js'

const quoteSelector = [
  'blockquote',
  '.gmail_quote',
  '[id*="divRplyFwdMsg"]',
  '[class*="divRplyFwdMsg"]',
].join(',')

const allowedImageSrc = /^(?:https:|cid:|http:\/\/127\.0\.0\.1:8411\/)/i

function sanitizeEmailNode(node: Element): void {
  if (node.tagName !== 'IMG') return
  const src = node.getAttribute('src') ?? ''
  if (!allowedImageSrc.test(src)) node.removeAttribute('src')
}

function renderRoot(kind: 'sanitized-html' | 'plain-text', value: string, downloaded: boolean): HTMLElement {
  const root = document.createElement('div')
  root.className = 'dispatch-thread-body'
  root.dataset.kind = kind
  if (kind === 'plain-text') {
    const paragraph = document.createElement('p')
    paragraph.textContent = value
    root.append(paragraph)
    return root
  }

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    sanitizeEmailNode(node)
    if (downloaded && /url\s*\(|@import/i.test(node.getAttribute('style') ?? '')) node.removeAttribute('style')
    if (downloaded && node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? ''
      if (src.startsWith('http://127.0.0.1:8411/')) { const url = new URL(src); url.searchParams.set('offline', 'true'); node.setAttribute('src', url.toString()) }
      else { node.removeAttribute('src'); node.setAttribute('alt', node.getAttribute('alt') || 'Image not downloaded') }
    }
  })
  try {
    root.innerHTML = DOMPurify.sanitize(value, { USE_PROFILES: { html: true }, ...(downloaded ? { FORBID_TAGS: ['style', 'link'], FORBID_ATTR: ['srcset', 'background'] } : {}) })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
  if (kind === 'sanitized-html') prepareMailSurface(root)
  else root.dataset.surface = 'theme'
  return root
}

export type MailSurface = 'theme' | 'paper'

/**
 * Decide how provider HTML sits on the dark theme, the way Apple Mail does:
 * plain and signature-style mail follows the theme with its inline colours
 * rewritten; real layouts (coloured backgrounds, background images, image-heavy
 * mail) keep a light surface. Both style variants are stored on each element so
 * the choice can flip live without re-rendering.
 */
export function prepareMailSurface(root: HTMLElement): MailSurface {
  let layout = false
  for (const element of root.querySelectorAll<HTMLElement>('[color], [bgcolor]')) {
    const color = element.getAttribute('color')
    if (color) { element.style.color = element.style.color || color; element.removeAttribute('color') }
    const bg = element.getAttribute('bgcolor')
    if (bg) { element.style.backgroundColor = element.style.backgroundColor || bg; element.removeAttribute('bgcolor') }
  }
  if (root.querySelector('[background]')) layout = true
  if (root.querySelectorAll('img[src]').length >= 3) layout = true
  for (const element of root.querySelectorAll<HTMLElement>('[style]')) {
    const light = element.getAttribute('style') ?? ''
    if (!/color|background/i.test(light)) continue
    const dark = rewriteStyleForDark(light)
    if (dark.layoutBackground) layout = true
    if (dark.style !== light) {
      element.dataset.lightStyle = light
      element.dataset.darkStyle = dark.style
    }
  }
  const surface: MailSurface = layout ? 'paper' : 'theme'
  root.dataset.surface = surface
  return surface
}

/** Apply the current appearance to a rendered body. `override` is the per-message "Show in light / dark" choice. */
export function applyMailAppearance(root: HTMLElement, dark: boolean, override?: 'light' | 'dark'): void {
  const surface = (root.dataset.surface ?? 'theme') as MailSurface
  const paper = dark && (override === 'light' || (override !== 'dark' && surface === 'paper'))
  const useDark = dark && !paper
  root.dataset.paper = String(paper)
  for (const element of root.querySelectorAll<HTMLElement>('[data-dark-style]')) {
    element.setAttribute('style', (useDark ? element.dataset.darkStyle : element.dataset.lightStyle) ?? '')
  }
}

export { isLightBackground }

/** Extract source text without disclosure labels or remote-image requests. */
export function emailPlainText(kind: 'sanitized-html' | 'plain-text', value: string): string {
  const root = renderRoot(kind, value, true)
  for (const node of root.querySelectorAll('br')) node.replaceWith('\n')
  for (const node of root.querySelectorAll('p,div,li,tr,blockquote,h1,h2,h3,h4')) node.append('\n')
  return (root.textContent ?? '').replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function renderEmailContent(kind: 'sanitized-html' | 'plain-text', value: string, downloaded = false): HTMLElement {
  const root = renderRoot(kind, value, downloaded)
  for (const quote of root.querySelectorAll<HTMLElement>(quoteSelector)) {
    if (quote.closest('details.dispatch-quoted-history')) continue
    const details = document.createElement('details')
    details.className = 'dispatch-quoted-history'
    const summary = document.createElement('summary')
    summary.textContent = 'Quoted history'
    details.append(summary)
    quote.before(details)
    if (quote.matches('blockquote, .gmail_quote')) {
      // Wrap the quote itself, never an ancestor shared with the new message.
      details.append(quote)
    } else {
      // Outlook's reply header marks a boundary; its following siblings are history.
      let node: ChildNode | null = quote
      while (node) { const next: ChildNode | null = node.nextSibling; details.append(node); node = next }
    }
  }
  return root
}
