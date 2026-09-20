import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer } from './static-server.js'

const servers: ReturnType<typeof createWebServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('dispatch-web service', () => {
  it('has independent health and readiness probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dispatch-web-'))
    await writeFile(join(root, 'index.html'), '<h1>Dispatch</h1>')
    const server = createWebServer(root)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await expect((await fetch(`${base}/health`)).json()).resolves.toMatchObject({ status: 'healthy' })
    await expect((await fetch(`${base}/ready`)).json()).resolves.toMatchObject({ status: 'ready' })
  })
})
