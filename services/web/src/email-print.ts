import type { MailAddress, MessageProjection } from './contracts.js'
import { applyMailAppearance, renderEmailContent } from './email-renderer.js'
import './email-print.css'

export const PRINT_EMAIL_EVENT = 'dispatch://print-email'

/** A separate snapshot leaves the reader, editor and Codex conversation intact. */
export function prepareEmailPrint(message: MessageProjection, options: { downloaded?: boolean; quoteStates?: readonly boolean[] } = {}): HTMLElement {
  const root = document.createElement('article')
  root.id = 'dispatch-email-print'
  root.setAttribute('aria-hidden', 'true')
  root.dataset.messageId = message.id
  const header = document.createElement('header')
  const subject = document.createElement('h1')
  subject.textContent = message.subject || '(No subject)'
  header.append(subject)
  const fields = document.createElement('dl')
  const addresses = (items: readonly MailAddress[]) => items.map(item => item.name && item.name !== item.address ? `${item.name} <${item.address}>` : item.address).join(', ')
  const field = (label: string, value: string) => {
    if (!value) return
    const term = document.createElement('dt'); term.textContent = label
    const detail = document.createElement('dd'); detail.textContent = value
    fields.append(term, detail)
  }
  field('From', addresses([message.sender]))
  field('To', addresses(message.to ?? []))
  field('Cc', addresses(message.cc ?? []))
  field('Bcc', addresses(message.bcc ?? []))
  field('Date', message.receivedFullLabel)
  header.append(fields)
  const body = renderEmailContent(message.body.kind, message.body.content, options.downloaded)
  applyMailAppearance(body, false)
  // Provider styles must not change the print page or other parts of the app.
  body.querySelectorAll('style, link').forEach(node => node.remove())
  body.querySelectorAll<HTMLDetailsElement>('details.dispatch-quoted-history').forEach((quote, index) => {
    if (options.quoteStates?.[index]) {
      quote.querySelector('summary')?.remove()
      quote.replaceWith(...quote.childNodes)
    } else quote.remove()
  })
  root.append(header, body)
  if (message.attachments.length) {
    const files = document.createElement('footer')
    const title = document.createElement('strong'); title.textContent = 'Attachments'
    const list = document.createElement('ul')
    for (const file of message.attachments) {
      const item = document.createElement('li')
      item.textContent = `${file.name}${file.sizeLabel ? ` (${file.sizeLabel})` : ''}`
      list.append(item)
    }
    files.append(title, list); root.append(files)
  }
  document.getElementById(root.id)?.remove()
  document.body.append(root)
  // WKWebView starts its print sheet asynchronously. Keep this immutable
  // snapshot until the next print request, rather than removing it on invoke.
  return root
}

export function isPrintShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p'
}
