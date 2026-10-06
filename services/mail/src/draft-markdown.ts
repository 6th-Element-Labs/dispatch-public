import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import TurndownService from 'turndown'

const markedOptions = { async: false as const, breaks: false, gfm: true }
const normalizedMarkdown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
normalizedMarkdown.keep(['table', 'sub', 'sup'])

export function normalizedDraftBody(value: string): string {
  return normalizedMarkdown.turndown(renderDraftMarkdown(value)).replaceAll('\r\n', '\n').trim()
}

export function renderDraftMarkdown(markdown: string): string {
  // Earlier rich-editor saves escaped underscores in bare URLs. They denote
  // the original URL, rather than a URL containing literal backslashes.
  const source = markdown.replace(/https?:\/\/[^\s<>]+/g, url => url.replace(/\\+_/g, '_'))
  const rendered = marked.parse(source, markedOptions) as string
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
