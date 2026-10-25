import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'

test('a deferred constraint failure during COMMIT does not poison subsequent transactions', t => {
  const f = fixture(); t.after(() => f.close())
  f.db.exec('CREATE TABLE tx_parent(id INTEGER PRIMARY KEY); CREATE TABLE tx_child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tx_parent(id) DEFERRABLE INITIALLY DEFERRED)')
  assert.throws(() => f.db.transaction(() => f.db.run('INSERT INTO tx_child VALUES (1, 999)')), /FOREIGN KEY/)
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM tx_child').n, 0)
  f.db.transaction(() => {
    f.db.run('INSERT INTO tx_parent VALUES (2)')
    f.db.run('INSERT INTO tx_child VALUES (2, 2)')
  })
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM tx_child').n, 1)
  assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), [])
})

test('a caught nested failure rolls back its savepoint and the outer transaction can still commit', t => {
  const f = fixture(); t.after(() => f.close())
  f.db.exec('CREATE TABLE tx_values(id INTEGER PRIMARY KEY)')
  f.db.transaction(() => {
    f.db.run('INSERT INTO tx_values VALUES (1)')
    assert.throws(() => f.db.transaction(() => {
      f.db.run('INSERT INTO tx_values VALUES (2)')
      throw new Error('inner failure')
    }), /inner failure/)
    f.db.transaction(() => f.db.run('INSERT INTO tx_values VALUES (3)'))
  })
  assert.deepEqual(f.db.all('SELECT id FROM tx_values ORDER BY id').map(row => row.id), [1, 3])
})
