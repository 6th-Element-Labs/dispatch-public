import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mediaTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

export function createWebServer(distRoot: string) {
  const root = resolve(distRoot)
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, { service: 'dispatch-web', status: 'healthy' })
    }
    if (request.method === 'GET' && url.pathname === '/ready') {
      try {
        await access(join(root, 'index.html'))
        return json(response, 200, { service: 'dispatch-web', status: 'ready' })
      } catch {
        return json(response, 503, { service: 'dispatch-web', status: 'not_ready', reason: 'build_missing' })
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method_not_allowed' })

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    let candidate = resolve(root, relative)
    if (!candidate.startsWith(`${root}/`) && candidate !== root) return json(response, 400, { error: 'invalid_path' })
    try {
      await access(candidate)
    } catch {
      candidate = join(root, 'index.html')
    }
    response.writeHead(200, { 'content-type': mediaTypes[extname(candidate)] ?? 'application/octet-stream' })
    if (request.method === 'HEAD') return response.end()
    createReadStream(candidate).pipe(response)
  })
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  const moduleRoot = dirname(fileURLToPath(import.meta.url))
  const distRoot = resolve(moduleRoot, '../dist')
  const port = Number(process.env.DISPATCH_WEB_PORT ?? 8410)
  createWebServer(distRoot).listen(port, '127.0.0.1', () => {
    process.stdout.write(`dispatch-web ready on http://127.0.0.1:${port}\n`)
  })
}

