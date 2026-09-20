import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'

const markedOptions = { async: false as const, breaks: false, gfm: true }

export function renderDraftMarkdown(markdown: string): string {
  const rendered = marked.parse(markdown, markedOptions) as string
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeType !== 1) return
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (!/^(https?:|mailto:)/i.test(href)) {
        node.removeAttribute('href')
        node.replaceWith(node.textContent ?? '')
      }
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? ''
      if (!/^(https:|cid:)/i.test(src)) node.remove()
    }
  })
  try {
    const sanitized = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } })
    return sanitized.replace(/<p>\s*<\/p>/g, '').trim() ? sanitized : '<p></p>'
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}
