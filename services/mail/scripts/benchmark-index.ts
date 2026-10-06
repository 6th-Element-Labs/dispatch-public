// Synthetic mail only. Never opens the installed app's database.
import { GmailIndex } from '../src/gmail-index.js'
import type { IndexedGmailMessage } from '../src/gmail-index.js'

const rows: IndexedGmailMessage[] = Array.from({ length: 20_000 }, (_, i) => ({
  id: `m${i}`, threadId: `t${Math.floor(i / 2)}`, accountId: 'one', accountLabel: 'Synthetic',
  sender: { name: 'Test', address: 'test@example.com', initials: 'T' }, subject: 'Performance fixture',
  receivedAt: new Date(1788486120000 + i * 1000).toISOString(), receivedLabel: '', receivedFullLabel: '',
  preview: 'Fixture', unread: i % 2 === 0, inInbox: i < 200, inSent: false,
  inDrafts: i >= 200 && i < 220, inSpam: i >= 220 && i < 240, inTrash: false, inArchive: i >= 240, hasAttachment: false,
}))
const index = new GmailIndex(':memory:')
try {
  index.replaceAccount('one', rows, 'fixture', true)
  const samples: number[] = []
  let truth
  for (let i = 0; i < 25; i++) {
    const start = performance.now()
    const list = index.mailboxConversations('inbox', 'all')
    const counts = index.mailboxCounts()
    const elapsed = performance.now() - start
    if (i >= 5) samples.push(elapsed)
    truth = { listCount: list.length, counts }
  }
  samples.sort((a, b) => a - b)
  console.log(JSON.stringify({ fixtureMessages: rows.length, operation: 'Inbox list plus folder badge counts', samples: samples.length,
    p50Ms: Number(samples[10]!.toFixed(2)), p95Ms: Number(samples[18]!.toFixed(2)), ...truth }, null, 2))
} finally { index.close() }
