import { describe, expect, it } from 'vitest'
import { renderDraftMarkdown } from '../src/draft-markdown.js'

describe('renderDraftMarkdown', () => {
  it('renders GFM bold, lists, links, and quotes', () => {
    const html = renderDraftMarkdown('**Hi**\n\n- one\n\n[docs](https://example.com)\n\n> quoted')
    expect(html).toContain('<strong>Hi</strong>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('<blockquote>')
  })

  it('strips javascript links and keeps https images', () => {
    const html = renderDraftMarkdown('[x](javascript:alert(1))\n\n![ok](https://example.com/x.png)')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<img')
    expect(html).toContain('https://example.com/x.png')
  })

  it('returns an empty paragraph for empty Markdown', () => {
    expect(renderDraftMarkdown('')).toBe('<p></p>')
  })
})
