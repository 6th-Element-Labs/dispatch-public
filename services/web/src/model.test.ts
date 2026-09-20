import { describe, expect, it } from 'vitest'
import { contextLabel, gmailAppId, isNativeShell } from './model.js'

describe('web presentation model', () => {
  it('finds Gmail without inventing another connector', () => {
    expect(gmailAppId([{ id: 'google_drive', name: 'Drive' }, { id: 'gmail', name: 'Gmail' }])).toBe('gmail')
  })

  it('makes selected mail context explicit', () => {
    expect(contextLabel({
      id: 'm1', threadId: 't1', sender: { name: 'Ana', address: 'ana@example.com', initials: 'A' },
      subject: 'Berth', receivedAt: 'now', receivedLabel: 'Sep 4, 9:42 AM', receivedFullLabel: 'September 4, 2026 at 9:42 AM', preview: 'Preview', unread: true,
    })).toBe('Berth · Ana')
  })
  it('detects the Tauri shell only from the isTauri flag', () => {
    expect(isNativeShell({ isTauri: true })).toBe(true)
    expect(isNativeShell({})).toBe(false)
    expect(isNativeShell({ isTauri: 'yes' })).toBe(false)
  })
})
