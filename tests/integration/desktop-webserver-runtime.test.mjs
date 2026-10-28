import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fixture } from '../helpers/fixture.mjs'
import * as plugin from '../../lib/index.js'

const runtime = new URL('../../artifacts/desktop-v03-runtime/node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url)

test('real Cordis attaches memory management when webServer arrives late and reattaches after its reload', { skip: !existsSync(runtime) }, async () => {
  const { Context } = await import(runtime)
  const f = fixture(), ctx = new Context(), routes = new Map()
  const server = createServer((req, res) => {
    const route = [...routes.values()].find(route => req.url.startsWith(route.path))
    if (route) route.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  let memory, provider
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const mountServer = () => ctx.plugin({ name: 'late-webserver', apply(child) {
    child.provide('webServer', { getOrigin: () => origin, register(route) {
      assert.equal(routes.has(route.path), false)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } })
  } })
  try {
    memory = ctx.plugin(plugin, { storage: { directory: f.directory, backupDaily: false }, proactive: { enabled: false } })
    await memory
    assert.equal(memory.state, 2)
    assert.equal((await fetch(`${origin}/companion-memory/manage`)).status, 404)
    provider = mountServer(); await provider; await new Promise(resolve => setImmediate(resolve))
    assert.equal(routes.size, 1)
    const page = await fetch(`${origin}/companion-memory/manage`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /导出并下载记忆/)
    assert.match(html, /感知电脑发生的事/)
    const token = JSON.parse(/const token=("[^"\n]+")/.exec(html)[1])
    const panel = await fetch(`${origin}/companion-memory/api/panel`, { headers: { 'x-companion-token': token } })
    assert.equal(panel.status, 200)
    assert.equal((await panel.json()).computer.settings.enabled, false)
    const rows = []; ctx.emit('webserver/index-inject', rows)
    assert.equal(rows.filter(row => row.html?.includes('companion-panel-entry')).length, 1)
    const response = await fetch(`${origin}/companion-memory`), diagnostic = await response.json()
    assert.equal(diagnostic.status.version, '0.3.0-dev.9')
    assert.equal(diagnostic.status.sync.manageUrl, `${origin}/companion-memory/manage`)
    await provider.dispose(); provider = undefined
    assert.equal(routes.size, 0)
    const afterStop = []; ctx.emit('webserver/index-inject', afterStop)
    assert.equal(afterStop.length, 0)
    provider = mountServer(); await provider; await new Promise(resolve => setImmediate(resolve))
    assert.equal(routes.size, 1)
    assert.equal((await fetch(`${origin}/companion-memory/manage`)).status, 200)
    const afterReload = []; ctx.emit('webserver/index-inject', afterReload)
    assert.equal(afterReload.filter(row => row.html?.includes('companion-panel-entry')).length, 1)
    await memory.dispose(); memory = undefined
    assert.equal(routes.size, 0)
  } finally {
    await memory?.dispose(); await provider?.dispose()
    server.closeAllConnections(); server.close(); f.close()
  }
})
