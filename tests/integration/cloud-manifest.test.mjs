import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { LIBRARY_MANIFEST, MANIFEST_FORMAT, MemoryTransfer, libraryManifestPath, sanitizeManifest } from '../../lib/cloud/memory-transfer.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const root = '/apps/test-app/dsh-companion-memory'
const directoryFor = companionId => `${root}/${digest(companionId).slice(0, 24)}`

class FakeCloud {
  files = new Map()
  uploads = 0
  downloads = 0
  packageDownloads = 0
  async list(directory) {
    return [...this.files.values()].filter(file => file.path.startsWith(directory + '/')).map(({ bytes, ...row }) => row)
  }
  async upload(path, bytes) {
    this.uploads++
    const old = this.files.get(path)
    const file = { id: old?.id ?? this.files.size + 1, path, name: path.split('/').at(-1), size: bytes.length, modifiedAtMs: 1000, bytes: Uint8Array.from(bytes) }
    this.files.set(path, file)
    return file
  }
  async download(file) {
    this.downloads++
    if (file.name.endsWith('.companion.json')) this.packageDownloads++
    return this.files.get(file.path).bytes
  }
}

function setup(t, cloud, device, companionId = 'blue-fish-main') {
  const f = fixture()
  new OwnerIdentity(f.repos, f.config)
  f.repos.setSetting('owner.id', `owner-${device}`, f.now())
  const config = {
    ...f.config,
    companion: { ...f.config.companion, id: companionId },
    storage: { ...f.config.storage, directory: f.directory },
    cloud: { ...f.config.cloud, enabled: true, autoUpload: true }
  }
  const transfer = new MemoryTransfer(f.db, config, device, { clientFactory: () => cloud })
  transfer.credentials.write({ appKey: 'test-key', secretKey: 'test-secret', appFolder: 'test-app', tokens: { accessToken: 'test-access', refreshToken: 'test-refresh' } })
  t.after(async () => { await transfer.stop(); f.close() })
  return { ...f, transfer, config }
}

function raw(f, id, content = id) {
  f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh', content,
    occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
}

function readManifestFile(cloud, directory) {
  const file = cloud.files.get(libraryManifestPath(directory))
  return file ? JSON.parse(Buffer.from(file.bytes).toString('utf8')) : null
}

test('上传后写入云端清单，清单里没有任何凭据', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a')
  raw(a, 'from-a')
  await a.transfer.sync()
  const directory = directoryFor(a.config.companion.id)
  const manifest = readManifestFile(cloud, directory)
  assert.ok(manifest, '同步成功后云端必须有 manifest.json')
  assert.equal(manifest.format, MANIFEST_FORMAT)
  assert.equal(manifest.companionId, a.config.companion.id)
  assert.ok(manifest.ownerId.length > 0)
  assert.equal(manifest.files.length, 1)
  assert.match(manifest.files[0].checksum, /^[0-9a-f]{64}$/)
  assert.equal(manifest.files[0].size, cloud.files.get(manifest.files[0].path).size)
  const text = JSON.stringify(manifest)
  for (const secret of ['test-secret', 'test-access', 'test-refresh', 'test-key']) assert.ok(!text.includes(secret), `清单不得包含 ${secret}`)
  assert.equal(cloud.files.get(libraryManifestPath(directory)).name, LIBRARY_MANIFEST)
})

test('重复同步仍会下载快照，但已导入的内容不会重复写入', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'from-a')
  await a.transfer.sync()
  const first = await b.transfer.sync()
  assert.equal(first.imported, 1, '首次同步必须真正下载并导入 a 的快照')
  const before = cloud.packageDownloads
  const second = await b.transfer.sync()
  assert.ok(cloud.packageDownloads > before, '本轮不做下载跳过：清单无法安全证明云端对象未变')
  assert.equal(b.repos.db.all("SELECT COUNT(*) AS n FROM raw_messages WHERE id = 'from-a'")[0].n, 1, '重复导入不得复制原文')
  assert.equal(b.repos.getRawMessage('from-a').content, 'from-a')
})

test('快照变化后清单校验和不再匹配，必须重新下载', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'from-a')
  await a.transfer.sync()
  await b.transfer.sync()
  raw(a, 'from-a-2', '新增的原文')
  await a.transfer.sync()
  const before = cloud.packageDownloads
  const status = await b.transfer.sync()
  assert.ok(cloud.packageDownloads > before, 'a 的新快照必须重新下载')
  assert.equal(b.repos.getRawMessage('from-a-2').content, '新增的原文')
})

test('companion.id 不一致时给出可读提示，而不是静默传到另一个目录', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a', 'blue-fish-main'), b = setup(t, cloud, 'b', 'other-fish')
  raw(a, 'from-a')
  await a.transfer.sync()
  const status = await b.transfer.sync()
  assert.equal(status.error, null, '发现别的记忆库不应算同步失败')
  assert.equal(status.foreignLibraries.length, 1)
  assert.equal(status.foreignLibraries[0].companionDigest, digest('blue-fish-main').slice(0, 24))
  assert.match(status.notice, /云端另有记忆库/)
  assert.equal(b.repos.getRawMessage('from-a'), undefined, '不同 companion.id 的记忆库不得合并')
  assert.ok(cloud.files.has(`${directoryFor('other-fish')}/${digest('b').slice(0, 24)}.companion.json`), '本机仍照常发布自己的快照')
})

test('云端清单损坏时照常下载导入，不因清单而漏合并', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'from-a')
  await a.transfer.sync()
  cloud.files.get(libraryManifestPath(directoryFor('blue-fish-main'))).bytes = Uint8Array.from(Buffer.from('not json'))
  const status = await b.transfer.sync()
  assert.equal(status.error, null, '清单损坏不算同步失败')
  assert.equal(b.repos.getRawMessage('from-a').content, 'from-a')
})

test('清单解析丢弃未知字段，令牌不会被重新写回云端', () => {
  const dirty = {
    format: MANIFEST_FORMAT, companionId: 'c', ownerId: 'o', updatedAtMs: 5, accessToken: 'secret-token',
    files: [{ path: 'p', size: 3, checksum: 'a'.repeat(64), deviceId: 'd', updatedAtMs: 1, secretKey: 'leak' }]
  }
  const clean = sanitizeManifest(dirty)
  assert.ok(clean)
  assert.equal(clean.files.length, 1)
  const text = JSON.stringify(clean)
  assert.ok(!text.includes('secret-token'))
  assert.ok(!text.includes('leak'))
  assert.equal(sanitizeManifest({ ...dirty, format: 'other' }), null)
  assert.equal(sanitizeManifest({ ...dirty, companionId: '' }), null)
  assert.equal(sanitizeManifest({ ...dirty, files: [{ path: 'p', size: 1, checksum: 'zz' }] }).files.length, 0)
})
