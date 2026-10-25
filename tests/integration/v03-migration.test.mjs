import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from '../helpers/fixture.mjs'
import { migrate } from '../../lib/storage/migrations.js'
test('new schema migrations roll back as one batch when a later migration fails', () => {
  const f = fixture()
  try {
    const directory = path.join(f.directory, 'migrations')
    fs.mkdirSync(directory)
    for (const file of fs.readdirSync('migrations')) fs.copyFileSync(path.join('migrations', file), path.join(directory, file))
    fs.writeFileSync(path.join(directory, '008_batch_probe.sql'), 'CREATE TABLE batch_probe(id TEXT);')
    fs.writeFileSync(path.join(directory, '009_invalid.sql'), 'THIS IS INVALID SQL;')
    assert.throws(() => migrate(f.db, { now: f.now(), fts5: true, directory }))
    assert.equal(f.db.get("SELECT name FROM sqlite_master WHERE name = 'batch_probe'"), undefined)
    assert.equal(f.db.get('SELECT MAX(version) AS version FROM schema_migrations').version, 7)
  } finally { f.close() }
})
