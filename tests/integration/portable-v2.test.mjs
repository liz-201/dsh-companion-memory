import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { PersonalityProfiles } from '../../lib/storage/personality-profiles.js'
import { exportPortable, readPortable, importPortable } from '../../lib/storage/portable.js'
const opts = mix => ({ mix, overrides: {}, variation: { enabled: false, maxDelta: .05, seed: null } })
function transfer(a, b, filename) {
  const file = join(a.directory, filename)
  exportPortable(a.db, a.config, file, { includePlugin: false })
  const read = readPortable(file)
  return { read, report: importPortable(b.db, b.config, read.payload, read.checksum) }
}
test('A36 / A37 / A39: v2 keeps personality conflicts and never transfers executable pending outbox', () => {
  const a = fixture(), b = fixture()
  try {
    const owner = new OwnerIdentity(a.repos, a.config, a.now(), 'A')
    owner.binding('dsh', 'one')
    const profiles = new PersonalityProfiles(a.repos)
    const legacy = a.repos.getSnapshot(owner.principalId).snapshot.personality
    a.repos.enqueueOutbox({ id: 'pending', conversationId: 'c', turnId: null, candidateKey: 'pending', taskId: null, content: 'must not send', contentHash: 'hash', plannedAtMs: a.now(), expectedInboundSeq: 0 })
    const first = transfer(a, b, 'base.json')
    assert.equal(first.read.payload.version, 2)
    assert.equal(first.read.payload.tables.outbox.length, 0)
    const otherProfiles = new PersonalityProfiles(b.repos)
    assert.deepEqual(otherProfiles.get(a.config.companion.id, 'builtin').traits, profiles.get(a.config.companion.id, 'builtin').traits)
    profiles.configure(a.config.companion.id, 'builtin', legacy, opts({ gentle: 1 }), a.now() + 1)
    otherProfiles.configure(b.config.companion.id, 'builtin', legacy, opts({ playful: 1 }), b.now() + 2)
    const head = otherProfiles.get(b.config.companion.id, 'builtin').revisionId
    transfer(a, b, 'branch.json')
    assert.equal(otherProfiles.get(b.config.companion.id, 'builtin').revisionId, head)
    assert.ok(b.db.get('SELECT conflict_json FROM personality_heads').conflict_json)
    otherProfiles.configure(b.config.companion.id, 'builtin', legacy, opts({ earnest: 1 }), b.now() + 3)
    const resolved = otherProfiles.get(b.config.companion.id, 'builtin')
    assert.equal(resolved.parentRevisionIds.length, 2)
    transfer(b, a, 'resolved.json')
    assert.equal(profiles.get(a.config.companion.id, 'builtin').revisionId, resolved.revisionId)
    assert.equal(a.db.get('SELECT conflict_json FROM personality_heads').conflict_json, null)
  } finally { a.close(); b.close() }
})
