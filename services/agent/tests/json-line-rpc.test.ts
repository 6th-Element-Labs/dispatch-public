import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { JsonLineRpc } from '../src/json-line-rpc.js'

describe('JsonLineRpc', () => {
  it('correlates responses and emits notifications', async () => {
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk) => { written += String(chunk) })
    const rpc = new JsonLineRpc(output)
    const listener = vi.fn()
    rpc.subscribe(listener)
    const pending = rpc.request('account/read', { refreshToken: false })
    expect(written).toContain('"method":"account/read"')
    rpc.acceptLine('{"id":1,"result":{"account":{"type":"chatgpt"}}}')
    await expect(pending).resolves.toEqual({ account: { type: 'chatgpt' } })
    rpc.acceptLine('{"method":"turn/started","params":{"threadId":"thread-1"}}')
    expect(listener).toHaveBeenCalledWith({ method: 'turn/started', params: { threadId: 'thread-1' } })
  })

  it('makes malformed lines visible as protocol errors', () => {
    const rpc = new JsonLineRpc(new PassThrough())
    const listener = vi.fn()
    rpc.subscribe(listener)
    rpc.acceptLine('not json')
    expect(listener).toHaveBeenCalledWith({ method: 'dispatch/protocolError', params: { line: 'not json' } })
  })

  it('responds to a server-initiated request with the original id', () => {
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk) => { written += String(chunk) })
    const rpc = new JsonLineRpc(output)
    rpc.respond('request-1', { decision: 'accept' })
    expect(JSON.parse(written)).toEqual({ id: 'request-1', result: { decision: 'accept' } })
  })

  it('fails a stalled App Server request with its method and deadline', async () => {
    const rpc = new JsonLineRpc(new PassThrough())
    await expect(rpc.request('turn/start', {}, 5)).rejects.toThrow('timed out after 5 ms: turn/start')
  })
})
