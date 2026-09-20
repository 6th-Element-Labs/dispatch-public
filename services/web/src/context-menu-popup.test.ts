import { describe, expect, it, vi } from 'vitest'
import { createContextMenuPopup } from './context-menu-popup.js'
import { threadContextMenuItems } from './thread-context-menu.js'

const items = threadContextMenuItems({ mailbox: 'inbox', unread: true, hasAccountId: true })

describe('createContextMenuPopup', () => {
  it('invokes popup_context_menu in the native shell and returns the chosen id', async () => {
    const invoke = vi.fn().mockResolvedValue('reply')
    const popup = createContextMenuPopup({
      isTauri: true,
      __TAURI__: { core: { invoke } },
    })
    await expect(popup(items)).resolves.toBe('reply')
    expect(invoke).toHaveBeenCalledWith('popup_context_menu', { items })
  })

  it('returns null when the native shell dismisses the menu', async () => {
    const popup = createContextMenuPopup({
      isTauri: true,
      __TAURI__: { core: { invoke: vi.fn().mockResolvedValue(null) } },
    })
    await expect(popup(items)).resolves.toBeNull()
  })

  it('fails when the native shell has no invoke', async () => {
    const popup = createContextMenuPopup({ isTauri: true })
    await expect(popup(items)).rejects.toThrow(/native menu/)
  })

  it('fails when the native shell returns a non-string', async () => {
    const popup = createContextMenuPopup({
      isTauri: true,
      __TAURI__: { core: { invoke: vi.fn().mockResolvedValue(12) } },
    })
    await expect(popup(items)).rejects.toThrow(/invalid/)
  })
})
