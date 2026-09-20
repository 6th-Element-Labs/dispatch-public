import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const localProxy = process.env.DISPATCH_LOCAL_PREVIEW === '1'

export default defineConfig({
  build: { rollupOptions: { input: { mail: fileURLToPath(new URL('./index.html', import.meta.url)), browser: fileURLToPath(new URL('./browser.html', import.meta.url)) } } },
  define: { __DISPATCH_LOCAL_PROXY__: JSON.stringify(localProxy) },
  plugins: [{
    name: 'dispatch-service-probes',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/health' && request.url !== '/ready') return next()
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ service: 'dispatch-web', status: request.url === '/health' ? 'healthy' : 'ready' }))
      })
    },
  }],
  server: { host: '127.0.0.1', port: 8410, strictPort: true, ...(localProxy ? { proxy: {
    '/mail': { target: 'http://127.0.0.1:8411', rewrite: path => path.replace(/^\/mail/, '') },
    '/agent': { target: 'http://127.0.0.1:8412', rewrite: path => path.replace(/^\/agent/, '') },
  } } : {}) },
  preview: { host: '127.0.0.1', port: 8410, strictPort: true },
})
