import type { MessageSummary } from './contracts.js'

export function gmailAppId(apps: readonly { readonly id: string; readonly name: string }[]): string | undefined {
  return apps.find((app) => /gmail/i.test(`${app.id} ${app.name}`))?.id
}

export function contextLabel(message: MessageSummary): string {
  return `${message.subject} · ${message.sender.name}`
}


/** True only when Tauri's init script has marked the page as running inside the native shell. */
export function isNativeShell(win: { isTauri?: unknown }): boolean {
  return win.isTauri === true
}
