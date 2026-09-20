export function parseRecipientList(value: string): string[] {
  return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)
}

export function serializeRecipientList(addresses: readonly string[], leftover = ''): string {
  return [...addresses, leftover.trim()].filter(Boolean).join(', ')
}

export function commitRecipientToken(value: string): { committed: string[]; leftover: string } {
  if (!/[,;\n]/.test(value)) return { committed: [], leftover: value }
  const tokens = parseRecipientList(value)
  if (/[,;\n]\s*$/.test(value)) return { committed: tokens, leftover: '' }
  return { committed: tokens.slice(0, -1), leftover: tokens.at(-1) ?? '' }
}
