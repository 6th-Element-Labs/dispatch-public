import type { SearchHit } from './contracts.js'

export function resultExcerpt(hit: SearchHit): HTMLElement {
  const excerpt = document.createElement('span')
  const mark = document.createElement('mark')
  mark.textContent = hit.excerpt.slice(hit.matchStart, hit.matchEnd)
  excerpt.append(hit.excerpt.slice(0, hit.matchStart), mark, hit.excerpt.slice(hit.matchEnd))
  return excerpt
}

/** Highlight literal source text across inline markup without altering links or HTML. */
export function highlightPassage(root: HTMLElement, quote: string): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const positions: { node: Text; offset: number }[] = []
  let text = ''
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    for (let offset = 0; offset < node.data.length; offset++) {
      const character = /\s/.test(node.data[offset]!) ? ' ' : node.data[offset]!
      if (character === ' ' && text.endsWith(' ')) continue
      text += character; positions.push({ node, offset })
    }
  }
  const phrase = quote.replace(/\s+/g, ' ').trim()
  const start = text.indexOf(phrase)
  if (!phrase || start < 0) return false
  const ranges = new Map<Text, { start: number; end: number }>()
  for (const position of positions.slice(start, start + phrase.length)) {
    const range = ranges.get(position.node) ?? { start: position.offset, end: position.offset + 1 }
    range.end = position.offset + 1; ranges.set(position.node, range)
  }
  for (const [node, offsets] of ranges) {
    const mark = document.createElement('mark')
    const range = document.createRange()
    range.setStart(node, offsets.start); range.setEnd(node, offsets.end)
    range.surroundContents(mark)
    for (let parent = mark.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  return true
}
