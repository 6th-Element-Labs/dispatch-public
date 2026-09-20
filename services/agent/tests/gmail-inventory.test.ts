import { describe, expect, it } from 'vitest'
import { readGmailInventory } from '../src/gmail-inventory.js'

describe('Gmail inventory', () => {
  it('extracts account and tool boundaries without retaining the full tool schema', () => {
    const metadata = {
      connector_name: 'Gmail', connector_id: 'connector-gmail', link_id: 'link-one',
      link_owner_profile: { nickname: 'Work', email: 'work@example.com' },
    }
    const inventory = readGmailInventory({ data: [{ name: 'codex_apps', tools: {
      'gmail.search_email_ids': { _meta: metadata },
      'gmail.read_email': { _meta: metadata },
      'github.search': { _meta: { connector_name: 'GitHub' } },
    } }] })
    expect(inventory).toEqual({
      available: true,
      server: 'codex_apps',
      accounts: [{ connectorId: 'connector-gmail', linkId: 'link-one', name: 'Work', email: 'work@example.com' }],
      tools: {
        search: 'gmail.search_email_ids', searchMessages: null, read: 'gmail.read_email', readThread: null,
        listDrafts: null, createDraft: null, updateDraft: null, deleteDraft: null, sendDraft: null, sendEmail: null, batchModify: null, archive: null, delete: null, readAttachment: null,
      },
    })
  })

  it('discovers every account declared by the connector link contract', () => {
    const accounts = [
      { link_id: 'link-one', link_name: 'Work', profile_name: 'Steve', profile_email: 'work@example.com' },
      { link_id: 'link-two', link_name: 'Personal', profile_name: 'Steve', profile_email: 'personal@example.com' },
    ]
    const inventory = readGmailInventory({ data: [{ name: 'codex_apps', tools: {
      'gmail.search_email_ids': {
        inputSchema: { properties: { link_id: { description: `Choose an account.\n${JSON.stringify(accounts)}` } } },
        _meta: { connector_name: 'Gmail', connector_id: 'connector-gmail', link_id: 'link-one', link_owner_profile: { nickname: 'Work', email: 'work@example.com' } },
      },
    } }] })
    expect(inventory.accounts).toEqual([
      { connectorId: 'connector-gmail', linkId: 'link-one', name: 'Work', email: 'work@example.com' },
      { connectorId: 'connector-gmail', linkId: 'link-two', name: 'Personal', email: 'personal@example.com' },
    ])
  })
})
