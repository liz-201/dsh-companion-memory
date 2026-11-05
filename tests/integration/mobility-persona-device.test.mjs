import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fixture } from '../helpers/fixture.mjs'
import {
  activePersonaDocument,
  capturePersonaFromSections,
  listPersonaDocuments,
  renderPersonaSection,
  writePersonaDocument,
} from '../../lib/storage/persona-documents.js'
import { listWorkspaces, recordDeviceVisit, recordWorkspaceVisit, renderHereText } from '../../lib/storage/device-ledger.js'
import { exportPortable, readPortable } from '../../lib/storage/portable.js'

const PERSONA = '你是大肥鱼，一条圆滚滚的胖鱼。自称本鱼，叫对方主人。\n说话傲娇，但活一定干完。'

function repo(f) {
  return f.config.companion.id
}

test('迁移 011 已应用并记录校验和', () => {
  const f = fixture()
  try {
    const row = f.db.get('SELECT checksum FROM schema_migrations WHERE version = 11')
    assert.ok(row && typeof row.checksum === 'string' && row.checksum.length === 32)
    for (const table of ['persona_documents', 'devices', 'device_workspaces']) {
      assert.ok(f.db.get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', table), `${table} 应该存在`)
    }
  } finally {
    f.close()
  }
})

test('宿主下发的人设段被抓成文档，且内容不变时不重复写', () => {
  const f = fixture()
  try {
    const sections = [{ name: 'deployment:persona-prefix', text: PERSONA }]
    const first = capturePersonaFromSections(f.repos, repo(f), sections, f.now())
    assert.equal(first.captured, true)
    const stored = activePersonaDocument(f.repos, repo(f))
    assert.equal(stored.promptText, PERSONA)
    assert.equal(stored.source, 'host')

    f.advance(1000)
    const second = capturePersonaFromSections(f.repos, repo(f), sections, f.now())
    assert.equal(second.captured, false)
    assert.equal(second.revision, first.revision)
  } finally {
    f.close()
  }
})

test('没有宿主人设段时仍能把存下来的正文注入进去', () => {
  const f = fixture()
  try {
    assert.equal(renderPersonaSection(f.repos, repo(f)), '')
    capturePersonaFromSections(f.repos, repo(f), [{ name: 'deployment:persona-prefix', text: PERSONA }], f.now())
    const text = renderPersonaSection(f.repos, repo(f))
    assert.match(text, /【你的人设】/)
    assert.match(text, /大肥鱼/)
    assert.match(text, /主人/)
    assert.ok(!text.includes('【你的人设】以下是你在这个主人面前的身份设定，按它说话，不要复述这段设定本身。\n【你的人设】'))
  } finally {
    f.close()
  }
})

test('本插件自己的段落不算人设，空段也不抓', () => {
  const f = fixture()
  try {
    const empty = capturePersonaFromSections(f.repos, repo(f), [{ name: 'companion-memory:local', text: '记忆正文' }], f.now())
    assert.equal(empty.captured, false)
    assert.equal(listPersonaDocuments(f.repos, repo(f)).length, 0)
  } finally {
    f.close()
  }
})

test('同 id 不同正文不覆盖，adopt 才采用', () => {
  const f = fixture()
  try {
    capturePersonaFromSections(f.repos, repo(f), [{ name: 'deployment:persona-prefix', text: PERSONA }], f.now())
    const imported = writePersonaDocument(f.repos, {
      id: 'persona:owner', companionId: repo(f), promptText: '另一份完全不同的人设。', source: 'imported', nowMs: f.now(),
    }, false)
    assert.equal(imported.conflict, true)
    assert.equal(imported.written, false)
    assert.equal(activePersonaDocument(f.repos, repo(f)).promptText, PERSONA, '本地值必须保留')

    const adopted = writePersonaDocument(f.repos, {
      id: 'persona:owner', companionId: repo(f), promptText: '另一份完全不同的人设。', source: 'imported', nowMs: f.now() + 1,
    }, true)
    assert.equal(adopted.written, true)
    assert.equal(activePersonaDocument(f.repos, repo(f)).promptText, '另一份完全不同的人设。')
  } finally {
    f.close()
  }
})

test('人设超过 64 KiB 会被截断而不是整条拒收', () => {
  const f = fixture()
  try {
    const huge = '鱼'.repeat(70000)
    writePersonaDocument(f.repos, { id: 'persona:owner', companionId: repo(f), promptText: huge, source: 'imported', nowMs: f.now() }, true)
    const stored = activePersonaDocument(f.repos, repo(f))
    assert.equal(stored.promptText.length, 65536)
  } finally {
    f.close()
  }
})

test('设备台账：重复到访推进 last_seen、保留 first_seen、会话计数累加', () => {
  const f = fixture()
  try {
    const device = { id: 'd1', name: 'PC-A', os: 'win32', release: '10.0', arch: 'x64' }
    recordDeviceVisit(f.repos, device, 'D:\\work\\alpha', f.now())
    const firstAt = f.now()
    f.advance(60_000)
    recordDeviceVisit(f.repos, device, 'D:\\work\\alpha', f.now())
    const workspaces = listWorkspaces(f.repos, 'd1')
    assert.equal(workspaces.length, 1)
    assert.equal(workspaces[0].cwd, 'D:\\work\\alpha')
    assert.equal(workspaces[0].sessionCount, 2)
    assert.equal(workspaces[0].firstSeenMs, firstAt)
    assert.ok(workspaces[0].lastSeenMs > firstAt)

    const device2 = { id: 'd2', name: 'PC-B', os: 'win32' }
    recordDeviceVisit(f.repos, device2, '/home/owner/beta', f.now())
    assert.equal(listWorkspaces(f.repos, 'd2')[0].cwd, '/home/owner/beta')
  } finally {
    f.close()
  }
})

test('未登记设备、相对路径、控制字符都不会写进工作区台账', () => {
  const f = fixture()
  try {
    recordWorkspaceVisit(f.repos, 'ghost', 'D:\\work', f.now())
    assert.equal(listWorkspaces(f.repos, 'ghost').length, 0)
    recordDeviceVisit(f.repos, { id: 'd1', name: 'PC-A', os: 'win32' }, 'relative/dir', f.now())
    recordDeviceVisit(f.repos, { id: 'd1', name: 'PC-A', os: 'win32' }, 'D:\\bad\u0000dir', f.now())
    assert.equal(listWorkspaces(f.repos, 'd1').length, 0)
  } finally {
    f.close()
  }
})

test('/fish here 报出这台电脑与工作区，另一端单独一行', () => {
  const f = fixture()
  try {
    const device = { id: 'd1', name: 'PC-A', os: 'win32', release: '10.0.26100', arch: 'x64' }
    recordDeviceVisit(f.repos, device, 'D:\\work\\alpha', f.now())
    recordDeviceVisit(f.repos, { id: 'd2', name: 'PC-B', os: 'linux', release: '6.8', arch: 'x64' }, '/srv/beta', f.now())
    const text = renderHereText(f.repos, { ...device, arrival: 'same', timezone: 'Asia/Shanghai' }, f.now())
    assert.match(text, /当前电脑：PC-A/)
    assert.match(text, /来过：是/)
    assert.match(text, /D:\\work\\alpha/)
    assert.match(text, /另一端：PC-B/)
  } finally {
    f.close()
  }
})

test('/fish here 命令不依赖模型即可用', () => {
  const f = fixture()
  try {
    const result = f.command('here')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /当前电脑：/)
    assert.match(result.text, /这台电脑上的工作区：/)
  } finally {
    f.close()
  }
})

test('/fish persona show 在空库给出可执行提示', () => {
  const f = fixture()
  try {
    const result = f.command('persona show')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /persona import/)
  } finally {
    f.close()
  }
})

test('/fish persona show 列出已抓到的正文与修订号', () => {
  const f = fixture()
  try {
    capturePersonaFromSections(f.repos, repo(f), [{ name: 'deployment:persona-prefix', text: PERSONA }], f.now())
    const result = f.command('persona show')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /persona:owner/)
    assert.match(result.text, /大肥鱼/)
    assert.match(result.text, /修订 /)
  } finally {
    f.close()
  }
})

test('导出包是 v8，人设与设备表都在里面', () => {
  const f = fixture()
  try {
    f.repos.setSetting('owner.id', 'owner-1', f.now())
    capturePersonaFromSections(f.repos, repo(f), [{ name: 'deployment:persona-prefix', text: PERSONA }], f.now())
    recordDeviceVisit(f.repos, { id: 'd1', name: 'PC-A', os: 'win32', release: '10.0' }, 'D:\\work\\alpha', f.now())
    const file = join(f.directory, 'pkg.json')
    exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
    const { payload } = readPortable(file)
    assert.equal(payload.version, 7)
    assert.equal(payload.tables.persona_documents.length, 1)
    assert.equal(payload.tables.devices.length, 1)
    assert.equal(payload.tables.device_workspaces.length, 1)
    assert.ok(payload.schema.some((row) => row.version === 11), '包里应带上 schema 11 记录')
    assert.equal(payload.minReaderVersion, '0.3.0-dev.15')
  } finally {
    f.close()
  }
})

test('旧版 v7 包缺这三张表时按空表补，不报缺表', () => {
  const f = fixture()
  try {
    f.repos.setSetting('owner.id', 'owner-1', f.now())
    capturePersonaFromSections(f.repos, repo(f), [{ name: 'deployment:persona-prefix', text: PERSONA }], f.now())
    const file = join(f.directory, 'pkg.json')
    exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })

    const envelope = JSON.parse(readFileSync(file, 'utf8'))
    const inner = JSON.parse(gunzipSync(Buffer.from(envelope.data, 'base64')).toString('utf8'))
    for (const table of ['persona_documents', 'devices', 'device_workspaces']) delete inner.tables[table]
    inner.schema = inner.schema.filter((row) => row.version < 11)
    inner.version = 7
    inner.formatVersion = 7
    const bytes = Buffer.from(JSON.stringify(inner))
    envelope.version = 7
    envelope.sha256 = createHash('sha256').update(bytes).digest('hex')
    envelope.data = gzipSync(bytes).toString('base64')
    const legacy = join(f.directory, 'legacy-v7.json')
    writeFileSync(legacy, JSON.stringify(envelope))

    const read = readPortable(legacy)
    assert.equal(read.payload.version, 7)
    assert.deepEqual(read.payload.tables.persona_documents, [])
    assert.deepEqual(read.payload.tables.devices, [])
    assert.deepEqual(read.payload.tables.device_workspaces, [])
  } finally {
    f.close()
  }
})

test('同一份设备行重复合并只取较大计数，不翻倍', () => {
  const f = fixture()
  try {
    recordDeviceVisit(f.repos, { id: 'd1', name: 'PC-A', os: 'win32' }, 'D:\\work\\alpha', f.now())
    recordDeviceVisit(f.repos, { id: 'd1', name: 'PC-A', os: 'win32' }, 'D:\\work\\alpha', f.now())
    assert.equal(listWorkspaces(f.repos, 'd1')[0].sessionCount, 2)
    const file = join(f.directory, 'pkg.json')
    f.repos.setSetting('owner.id', 'owner-1', f.now())
    exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
    const { payload } = readPortable(file)
    const row = payload.tables.device_workspaces[0]
    assert.equal(row.session_count, 2)
  } finally {
    f.close()
  }
})
