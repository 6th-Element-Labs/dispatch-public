import DOMPurify from 'dompurify'
import { marked } from 'marked'
import TurndownService from 'turndown'

const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**' })
converter.keep(['u', 'table', 'sub', 'sup'])
converter.addRule('strike', { filter: node => ['S', 'STRIKE', 'DEL'].includes(node.nodeName), replacement: content => `~~${content}~~` })
converter.addRule('lineBreak', { filter: 'br', replacement: () => '\n' })
converter.addRule('emailImage', {
  filter: node => node.nodeName === 'SPAN' && node.hasAttribute('data-draft-image'),
  replacement: (_content, node) => {
    const image = node as HTMLElement
    const alt = (image.getAttribute('data-image-alt') ?? '').replace(/[\\[\]]/g, '\\$&')
    const src = (image.getAttribute('data-draft-image') ?? '').replace(/\(/g, '%28').replace(/\)/g, '%29')
    return `![${alt}](${src})`
  },
})

/** Only inert message formatting enters the editor, including pasted HTML. */
export function draftEditorHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'div', 'br', 'span', 'img', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'blockquote', 'ul', 'ol', 'li', 'a', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sub', 'sup', 'hr'],
    ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'start', 'src', 'alt', 'data-draft-image', 'data-image-alt'],
    ALLOW_DATA_ATTR: false,
  })
  const template = document.createElement('template')
  template.innerHTML = clean
  const root = template.content
  // Retain existing inline images through text edits without fetching remote image URLs.
  for (const image of root.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    if (!/^(https:|cid:)/i.test(src)) { image.remove(); continue }
    const placeholder = document.createElement('span')
    placeholder.setAttribute('data-draft-image', src)
    placeholder.setAttribute('data-image-alt', image.alt)
    placeholder.textContent = `[${image.alt || 'Image'}]`
    image.replaceWith(placeholder)
  }
  for (const placeholder of root.querySelectorAll<HTMLElement>('[data-draft-image]')) {
    if (!/^(https:|cid:)/i.test(placeholder.dataset.draftImage ?? '')) { placeholder.replaceWith(...placeholder.childNodes); continue }
    placeholder.contentEditable = 'false'
    placeholder.className = 'dispatch-draft-image'
  }
  for (const link of root.querySelectorAll('a')) {
    if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) link.replaceWith(...link.childNodes)
  }
  return template.innerHTML
}

export function draftEditorMarkdown(html: string): string {
  return converter.turndown(draftEditorHtml(html))
}

export interface RichDraftEditor extends HTMLDivElement { value: string; disabled: boolean }

/** Keep the exact provider source until the user edits; saves still use the mail-owned Markdown contract. */
export function installRichDraftEditor(root: HTMLElement): RichDraftEditor {
  const editor = root.querySelector<HTMLDivElement>('[data-draft-body]')! as RichDraftEditor
  let source = ''
  let rendered = ''
  let disabled = false
  Object.defineProperties(editor, {
    value: {
      get: () => {
        if (editor.innerHTML !== rendered) {
          source = draftEditorMarkdown(editor.innerHTML)
          rendered = editor.innerHTML
        }
        return source
      },
      set: (value: string) => {
        source = value
        editor.innerHTML = draftEditorHtml(marked.parse(value, { async: false, gfm: true, breaks: true }) as string)
        // Reply templates begin with space for the user's answer above the quoted message.
        // Markdown omits these empty paragraphs; the rich editor must retain that insertion point.
        if (/^\s*\n/.test(value)) {
          const paragraph = document.createElement('p'); paragraph.append(document.createElement('br')); editor.prepend(paragraph)
        }
        rendered = editor.innerHTML
      },
    },
    disabled: { get: () => disabled, set: (value: boolean) => {
      disabled = value
      editor.contentEditable = String(!value)
      editor.setAttribute('aria-disabled', String(value))
    } },
  })
  const command = (name: string, value?: string) => {
    if (disabled) return
    editor.focus()
    document.execCommand(name, false, value)
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // Toolbar clicks retain the selection, so formatting applies to the selected words.
  root.querySelectorAll<HTMLButtonElement>('[data-draft-format]').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', () => command(button.dataset.draftFormat!))
  })
  editor.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      command(({ b: 'bold', i: 'italic', u: 'underline' } as Record<string, string>)[event.key.toLowerCase()]!)
    }
  })
  editor.addEventListener('paste', event => {
    event.preventDefault()
    if (disabled) return
    const html = event.clipboardData?.getData('text/html')
    if (html) command('insertHTML', draftEditorHtml(html))
    else command('insertText', event.clipboardData?.getData('text/plain') ?? '')
  })
  // Email links stay in the editor while composing.
  editor.addEventListener('click', event => { if ((event.target as Element).closest('a')) event.preventDefault() })
  const linkForm = root.querySelector<HTMLElement>('[data-draft-link-form]')!
  const linkInput = root.querySelector<HTMLInputElement>('[data-draft-link-url]')!
  let linkSelection: Range | undefined
  root.querySelector('[data-draft-link]')!.addEventListener('mousedown', event => event.preventDefault())
  root.querySelector('[data-draft-link]')!.addEventListener('click', () => {
    const selection = window.getSelection()
    linkSelection = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : undefined
    linkForm.hidden = false
    linkInput.value = ''
    linkInput.focus()
  })
  const applyLink = () => {
    if (!/^(https?:\/\/|mailto:)\S+$/i.test(linkInput.value.trim())) { linkInput.setCustomValidity('Enter an https://, http://, or mailto: link.'); linkInput.reportValidity(); return }
    linkInput.setCustomValidity('')
    editor.focus()
    if (linkSelection) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(linkSelection) }
    if (window.getSelection()?.isCollapsed) {
      const link = document.createElement('a'); link.href = linkInput.value.trim(); link.textContent = linkInput.value.trim()
      command('insertHTML', link.outerHTML)
    }
    else command('createLink', linkInput.value.trim())
    linkForm.hidden = true
  }
  root.querySelector('[data-draft-link-apply]')!.addEventListener('click', applyLink)
  root.querySelector('[data-draft-link-cancel]')!.addEventListener('click', () => { linkForm.hidden = true; editor.focus() })
  linkInput.addEventListener('input', () => linkInput.setCustomValidity(''))
  linkInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyLink() } })
  return editor
}
