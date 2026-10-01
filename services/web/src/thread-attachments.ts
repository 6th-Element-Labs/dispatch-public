import type { MessageProjection } from './contracts'

type Attachment = MessageProjection['attachments'][number]
type CacheState = 'checking' | 'available' | 'missing' | 'downloading' | 'failed' | 'unknown' | 'unavailable'
interface FileEntry {
  message: MessageProjection
  attachment: Attachment
  state: CacheState
  status: HTMLElement
  retry: HTMLButtonElement
}

/** File occurrences keep their parent identity, including repeated filenames. */
export function renderThreadAttachments(
  messages: readonly MessageProjection[],
  openFile: (message: MessageProjection, id: string, name: string) => void,
  goToMessage: (message: MessageProjection) => void,
  cache: {
    status: (message: MessageProjection, id: string, name: string) => Promise<boolean>
    download: (message: MessageProjection, id: string, name: string) => Promise<void>
    isCurrent: () => boolean
  },
): HTMLElement {
  const section = document.createElement('section')
  section.className = 'dispatch-thread-files'
  section.id = 'dispatch-thread-files'
  section.dataset.threadFiles = ''
  section.setAttribute('aria-label', 'All attachments in this thread')
  const heading = document.createElement('h3')
  heading.className = 'h4 mb-1'
  heading.textContent = 'All attachments'
  const context = document.createElement('p')
  context.className = 'text-secondary small mb-2'
  context.textContent = `Across ${messages.length} ${messages.length === 1 ? 'email' : 'emails'}`
  const downloadRow = document.createElement('div')
  downloadRow.className = 'dispatch-thread-download'
  const download = document.createElement('button')
  download.type = 'button'
  download.className = 'btn btn-sm btn-ghost-primary'
  download.textContent = 'Checking offline files…'
  download.disabled = true
  download.dataset.downloadThreadAttachments = ''
  const downloadStatus = document.createElement('span')
  downloadStatus.className = 'text-secondary small'
  downloadStatus.setAttribute('role', 'status')
  downloadRow.append(download, downloadStatus)
  section.append(heading, context, downloadRow)
  const entries: FileEntry[] = []
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
      const status = document.createElement('small')
      status.className = 'dispatch-thread-file-status text-secondary'
      status.dataset.attachmentCacheStatus = ''
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'btn btn-sm btn-ghost-secondary dispatch-thread-file-retry'
      retry.textContent = 'Retry download'
      retry.hidden = true
      row.append(file, source, jump, status, retry)
      section.append(row)
      entries.push({ message, attachment, state: message.source === 'gmail' && message.accountId ? 'checking' : 'unavailable', status, retry })
    }
  }

  const renderState = (entry: FileEntry, state: CacheState) => {
    entry.state = state
    entry.status.textContent = state === 'checking' ? 'Checking offline copy…'
      : state === 'available' ? 'Available offline'
        : state === 'missing' ? 'Not downloaded'
          : state === 'downloading' ? 'Downloading…'
            : state === 'failed' ? 'Download failed'
              : state === 'unknown' ? 'Offline status unavailable'
                : 'Unavailable for demo mail'
    entry.retry.hidden = state !== 'failed'
  }
  const renderSummary = () => {
    const available = entries.filter(entry => entry.state === 'available').length
    const checking = entries.some(entry => entry.state === 'checking')
    const downloading = entries.some(entry => entry.state === 'downloading')
    const failed = entries.filter(entry => entry.state === 'failed').length
    const total = entries.length
    download.disabled = checking || downloading || !entries.some(entry => ['missing', 'failed', 'unknown'].includes(entry.state))
    download.textContent = checking ? 'Checking offline files…' : downloading ? 'Downloading attachments…'
      : total > 0 && available === total ? 'All attachments available offline' : 'Download attachments'
    downloadStatus.textContent = `${available} of ${total} available offline${failed ? ` · ${failed} failed; retry those files` : ''}`
  }
  for (const entry of entries) renderState(entry, entry.state)

  const runBounded = async (selected: readonly FileEntry[], operation: (entry: FileEntry) => Promise<void>) => {
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (cursor < selected.length && cache.isCurrent()) {
        const entry = selected[cursor++]!
        await operation(entry)
        renderSummary()
      }
    })
    await Promise.all(workers)
  }
  const downloadFiles = async (selected: readonly FileEntry[]) => {
    const eligible = selected.filter(entry => entry.message.source === 'gmail' && entry.message.accountId && entry.state !== 'available' && entry.state !== 'unavailable')
    if (!eligible.length || !cache.isCurrent()) return
    for (const entry of eligible) renderState(entry, 'downloading')
    renderSummary()
    await runBounded(eligible, async entry => {
      try {
        await cache.download(entry.message, entry.attachment.id, entry.attachment.name)
        if (cache.isCurrent()) renderState(entry, 'available')
      } catch {
        if (cache.isCurrent()) renderState(entry, 'failed')
      }
    })
    renderSummary()
  }
  download.addEventListener('click', () => { void downloadFiles(entries) })
  for (const entry of entries) entry.retry.addEventListener('click', () => { void downloadFiles([entry]) })

  void runBounded(entries.filter(entry => entry.state === 'checking'), async entry => {
    try {
      const cached = await cache.status(entry.message, entry.attachment.id, entry.attachment.name)
      if (cache.isCurrent()) renderState(entry, cached ? 'available' : 'missing')
    } catch {
      if (cache.isCurrent()) renderState(entry, 'unknown')
    }
  }).then(renderSummary)
  renderSummary()
  return section
}
