import { expect, it, vi } from 'vitest'
import { ConnectorAuthRecovery } from '../src/connector-auth.js'
const revoked = new Error('Transport send error: unexpected server response: HTTP 401: {"code":"token_revoked"}')
it('renews a revoked session and retries a rejected Gmail read once', async () => {
 const request=vi.fn().mockRejectedValueOnce(revoked).mockResolvedValueOnce({}).mockResolvedValueOnce({message_ids:['new']})
 const auth=new ConnectorAuthRecovery(request)
 await expect(auth.call('mcpServer/tool/call',{tool:'gmail.search_email_ids'})).resolves.toEqual({message_ids:['new']})
 expect(request.mock.calls.map(c=>c[0])).toEqual(['mcpServer/tool/call','account/read','mcpServer/tool/call'])
 expect(request.mock.calls[1]?.[1]).toEqual({refreshToken:true})
})
it('does not replay a send, draft write, or arbitrary failure', async () => {
 for(const tool of ['gmail.send_draft','gmail.create_draft','gmail.update_draft']) {
  const request=vi.fn().mockRejectedValueOnce(revoked).mockResolvedValueOnce({})
  await expect(new ConnectorAuthRecovery(request).call('mcpServer/tool/call',{tool})).rejects.toThrow('token_revoked')
  expect(request).toHaveBeenCalledTimes(2)
 }
 const request=vi.fn().mockRejectedValue(new Error('HTTP 401: Google grant invalid'))
 await expect(new ConnectorAuthRecovery(request).call('mcpServer/tool/call',{tool:'gmail.read_email'})).rejects.toThrow('Google grant invalid')
 expect(request).toHaveBeenCalledTimes(1)
})
it('coalesces concurrent refreshes, bounds repeated failures and allows a later attempt', async () => {
 let time=0;let finish!:()=>void
 const request=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}))
 const auth=new ConnectorAuthRecovery(request,()=>time)
 const first=auth.refresh(),second=auth.refresh();expect(request).toHaveBeenCalledTimes(1)
 finish();await Promise.all([first,second]);await auth.refresh();expect(request).toHaveBeenCalledTimes(1)
 time=30_001;const later=auth.refresh();finish();await later;expect(request).toHaveBeenCalledTimes(2)
})
it('surfaces a second rejection and a failed refresh without looping', async () => {
 const request=vi.fn().mockRejectedValueOnce(revoked).mockResolvedValueOnce({}).mockRejectedValueOnce(revoked)
 const auth=new ConnectorAuthRecovery(request)
 await expect(auth.call('mcpServer/tool/call',{tool:'gmail.list_drafts'})).rejects.toThrow('token_revoked')
 expect(request).toHaveBeenCalledTimes(3)
 await expect(auth.refresh()).rejects.toThrow('Reconnect')
 const failed=vi.fn().mockRejectedValueOnce(revoked).mockRejectedValueOnce(new Error('Refresh rejected'))
 await expect(new ConnectorAuthRecovery(failed).call('mcpServer/tool/call',{tool:'gmail.list_drafts'})).rejects.toThrow('Refresh rejected')
 expect(failed).toHaveBeenCalledTimes(2)
})
it('lets another in-flight rejected read use the renewed login without a second refresh', async () => {
 const request=vi.fn().mockRejectedValueOnce(revoked).mockResolvedValueOnce({}).mockResolvedValueOnce('first').mockRejectedValueOnce(revoked).mockResolvedValueOnce('second')
 const auth=new ConnectorAuthRecovery(request)
 expect(await auth.call('mcpServer/tool/call',{tool:'gmail.read_email'})).toBe('first')
 expect(await auth.call('mcpServer/tool/call',{tool:'gmail.search_email_ids'})).toBe('second')
 expect(request.mock.calls.filter(c=>c[0]==='account/read')).toHaveLength(1)
})
