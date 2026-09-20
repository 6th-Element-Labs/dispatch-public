import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function renderChatMarkdown(value: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'markdown ai-response'
  const rendered = marked.parse(value, { async: false, breaks: false, gfm: true }) as string
  root.innerHTML = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } })

  root.querySelectorAll('table').forEach((table) => table.classList.add('table', 'table-sm', 'table-vcenter'))
  root.querySelectorAll('table').forEach((table) => {
    const wrapper = document.createElement('div')
    wrapper.className = 'table-responsive'
    table.before(wrapper)
    wrapper.append(table)
  })
  root.querySelectorAll('pre').forEach((pre) => pre.classList.add('bg-dark', 'text-white', 'p-3', 'rounded'))
  // Inline code stays real inline text (tool names, ids, addresses), never a
  // Tabler badge: badges uppercase and reflow it, and it no longer reads as code.
  root.querySelectorAll('code').forEach((code) => {
    if (!code.closest('pre')) code.classList.add('dispatch-inline-code')
  })
  root.querySelectorAll('blockquote').forEach((quote) => quote.classList.add('border-start', 'border-primary', 'border-3', 'ps-3', 'text-secondary'))
  root.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? ''
    if (!/^(https?:|mailto:)/i.test(href)) {
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''))
      return
    }
    anchor.classList.add('link-primary')
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
  })
  return root
}
