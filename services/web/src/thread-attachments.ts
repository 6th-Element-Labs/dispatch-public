import type { MessageProjection } from './contracts'

/** File occurrences keep their parent identity, including repeated filenames. */
export function renderThreadAttachments(
  messages: readonly MessageProjection[],
  openFile: (message: MessageProjection, id: string, name: string) => void,
  goToMessage: (message: MessageProjection) => void,
): HTMLElement {
  const section = document.createElement('section')
  section.className = 'dispatch-thread-files'
  section.id = 'dispatch-thread-files'
  section.setAttribute('aria-label', 'All attachments in this thread')
  const heading = document.createElement('h3')
  heading.className = 'h4 mb-1'
  heading.textContent = 'All attachments'
  const context = document.createElement('p')
  context.className = 'text-secondary small mb-2'
  context.textContent = `Across ${messages.length} ${messages.length === 1 ? 'email' : 'emails'}`
  section.append(heading, context)
  for (const message of messages) {
    for (const attachment of message.attachments) {
      const row = document.createElement('div')
      row.className = 'dispatch-thread-file'
      const file = document.createElement('button')
      file.type = 'button'
      file.className = 'btn btn-ghost-secondary btn-sm dispatch-thread-file-open'
      const badge = document.createElement('span')
      badge.className = 'badge bg-blue-lt text-blue'
      badge.textContent = attachment.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'
      const name = document.createElement('span')
      name.textContent = attachment.name
      file.append(badge, name)
      file.addEventListener('click', () => openFile(message, attachment.id, attachment.name))
      const source = document.createElement('small')
      source.className = 'text-secondary'
      source.textContent = `${attachment.sizeLabel} · ${message.sender.name} · ${message.receivedFullLabel}`
      const jump = document.createElement('button')
      jump.type = 'button'
      jump.className = 'btn btn-sm btn-ghost-primary dispatch-thread-file-source'
      jump.textContent = 'Go to email'
      jump.setAttribute('aria-label', `Go to email from ${message.sender.name}, ${message.receivedFullLabel}, containing ${attachment.name}`)
      jump.addEventListener('click', () => goToMessage(message))
      row.append(file, source, jump)
      section.append(row)
    }
  }
  return section
}
