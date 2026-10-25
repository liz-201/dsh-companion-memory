#!/usr/bin/env node
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { resolveConfig, dshHome } from '../lib/config.js'
import { openDatabase } from '../lib/storage/database.js'
import { migrate } from '../lib/storage/migrations.js'
import { Repositories } from '../lib/storage/repositories.js'
import { OwnerIdentity } from '../lib/domain/owner-identity.js'
import { MemoryTransfer } from '../lib/cloud/memory-transfer.js'
import { createTransferHandler } from '../lib/cloud/transfer-ui.js'
import { doctorConfig } from './doctor-config.mjs'

const args = process.argv.slice(2)
const command = args[0] ?? 'serve'
if (!['serve', 'export', 'import', 'sync', 'status'].includes(command)) {
  process.stderr.write('Usage: node scripts/memory-transfer.mjs serve|export|import|sync|status [--config file] [--file file]\n')
  process.exit(2)
}
let database, transfer, server
async function close() { server?.closeAllConnections(); server?.close(); await transfer?.stop(); database?.close() }
try {
  const config = resolveConfig(doctorConfig(args, dshHome()).raw)
  database = openDatabase(config.storage, false, config.companion.id)
  migrate(database, { now: Date.now(), fts5: database.capabilities().fts5 })
  const repos = new Repositories(database)
  const owner = new OwnerIdentity(repos, config)
  transfer = new MemoryTransfer(database, config, owner.deviceId)
  transfer.start()
  if (command === 'serve') {
    const handler = createTransferHandler(transfer)
    server = createServer((req, res) => { void handler(req, res) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    process.stdout.write(JSON.stringify({ managementUrl: `http://127.0.0.1:${server.address().port}/companion-memory/manage`, companion: config.companion.name }) + '\n')
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close() })
  } else {
    await transfer.ready
    let result
    if (command === 'export') { result = transfer.exportLocal(); if (result.upload === 'queued') result.cloud = await transfer.sync() }
    else if (command === 'import') {
      const index = args.indexOf('--file')
      if (index < 0 || !args[index + 1]) throw Error('missing file')
      result = transfer.importFile(resolve(args[index + 1]))
      if (transfer.status().enabled) result.cloud = await transfer.sync()
    } else result = command === 'sync' ? await transfer.sync() : transfer.status()
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.error || result.cloud?.error) process.exitCode = 1
    await close()
  }
} catch {
  process.stderr.write('记忆操作未完成。请检查配置、文件、同步状态或百度授权；未输出凭据。\n')
  process.exitCode = 1
  await close()
}
