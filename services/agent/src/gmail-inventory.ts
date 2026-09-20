export interface GmailAccount {
  readonly connectorId: string
  readonly linkId: string
  readonly name: string
  readonly email: string
}

export interface GmailInventory {
  readonly available: boolean
  readonly server: string | null
  readonly accounts: readonly GmailAccount[]
  readonly tools: {
    readonly search: string | null
    readonly searchMessages: string | null
    readonly read: string | null
    readonly readThread: string | null
    readonly listDrafts: string | null
    readonly createDraft: string | null
    readonly updateDraft: string | null
    readonly deleteDraft: string | null
    readonly sendDraft: string | null
    readonly sendEmail: string | null
    readonly batchModify: string | null
    readonly archive: string | null
    readonly delete: string | null
    readonly readAttachment: string | null
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function accountsFromDescription(tool: Record<string, unknown>): readonly GmailAccount[] {
  const inputSchema = record(tool.inputSchema)
  const properties = record(inputSchema?.properties)
  const linkProperty = record(properties?.link_id)
  const description = text(linkProperty?.description)
  const start = description.indexOf('[')
  const end = description.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const values = JSON.parse(description.slice(start, end + 1)) as unknown
    if (!Array.isArray(values)) return []
    return values.flatMap((value) => {
      const account = record(value)
      const linkId = text(account?.link_id)
      if (!linkId) return []
      return [{
        connectorId: '',
        linkId,
        name: text(account?.link_name) || text(account?.profile_name) || 'Gmail',
        email: text(account?.profile_email),
      }]
    })
  } catch {
    return []
  }
}

export function readGmailInventory(value: unknown): GmailInventory {
  const root = record(value)
  const data = Array.isArray(root?.data) ? root.data : []
  const accounts = new Map<string, GmailAccount>()
  const toolNames = new Set<string>()
  let serverName: string | null = null

  for (const serverValue of data) {
    const server = record(serverValue)
    const tools = record(server?.tools)
    if (!server || !tools) continue
    for (const [wireName, toolValue] of Object.entries(tools)) {
      const tool = record(toolValue)
      if (!tool) continue
      const meta = record(tool?._meta)
      if (text(meta?.connector_name) !== 'Gmail') continue
      serverName ??= text(server.name) || null
      toolNames.add(wireName)
      const profile = record(meta?.link_owner_profile)
      const linkId = text(meta?.link_id)
      const connectorId = text(meta?.connector_id)
      if (linkId) {
        accounts.set(linkId, {
          connectorId,
          linkId,
          name: text(profile?.nickname) || text(meta?.link_name) || 'Gmail',
          email: text(profile?.email),
        })
      }
      for (const account of accountsFromDescription(tool)) {
        accounts.set(account.linkId, { ...account, connectorId })
      }
    }
  }

  const find = (suffix: string) => [...toolNames].find((name) => name === `gmail.${suffix}`) ?? null
  return {
    available: accounts.size > 0,
    server: serverName,
    accounts: [...accounts.values()],
    tools: {
      search: find('search_email_ids'),
      searchMessages: find('search_emails'),
      read: find('read_email'),
      readThread: find('read_email_thread'),
      listDrafts: find('list_drafts'),
      createDraft: find('create_draft'),
      updateDraft: find('update_draft'),
      deleteDraft: find('delete_draft'),
      sendDraft: find('send_draft'),
      sendEmail: find('send_email'),
      batchModify: find('batch_modify_email'),
      archive: find('archive_emails'),
      delete: find('delete_emails'),
      readAttachment: find('read_attachment'),
    },
  }
}
