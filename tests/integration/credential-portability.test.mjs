import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTION_FORMAT, CredentialStore, describeConnection, parseConnection, serializeConnection, validateConnectionFields } from '../../lib/cloud/credentials.js'

const credentials = {
  appKey: 'a'.repeat(32),
  secretKey: 's'.repeat(32),
  appFolder: '情感记忆插件同步',
  tokens: { accessToken: 'access-token-value', refreshToken: 'refresh-token-value', expiresAtMs: 1793000000000 }
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'credential-portability-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('导出连接配置默认只带应用信息，不带任何令牌', () => {
  const text = serializeConnection(credentials)
  const parsed = JSON.parse(text)
  assert.equal(parsed.format, CONNECTION_FORMAT)
  assert.equal(parsed.appKey, credentials.appKey)
  assert.equal(parsed.appFolder, '情感记忆插件同步')
  assert.equal(parsed.tokens, undefined)
  assert.ok(!text.includes('access-token-value'))
  assert.ok(!text.includes('refresh-token-value'))
  assert.ok(text.includes(credentials.secretKey), '导出必须包含 secretKey，否则无法跳过手抄')
})

test('只有显式勾选才导出令牌，并能被导入还原', () => {
  const text = serializeConnection(credentials, { includeTokens: true })
  const parsed = parseConnection(text)
  assert.equal(parsed.tokens.accessToken, 'access-token-value')
  assert.equal(parsed.tokens.refreshToken, 'refresh-token-value')
  assert.equal(parsed.tokens.expiresAtMs, 1793000000000)
  assert.equal(parseConnection(serializeConnection(credentials)).tokens, undefined)
})

test('导入的连接配置必须带齐三项且目录名合法', () => {
  const cases = [
    ['not json', /连接配置无效/],
    ['{}', /连接配置无效/],
    [JSON.stringify({ appKey: 'k', secretKey: 's' }), /连接配置无效/],
    [JSON.stringify({ format: CONNECTION_FORMAT, appKey: 'k', secretKey: 's', appFolder: '..' }), /连接配置无效/],
    [JSON.stringify({ format: CONNECTION_FORMAT, appKey: 'k', secretKey: 's', appFolder: 'a/b' }), /连接配置无效/],
    [JSON.stringify({ format: CONNECTION_FORMAT, appKey: 'k', secretKey: 's', appFolder: 'ok', tokens: {} }), /连接配置无效/],
    [JSON.stringify({ format: CONNECTION_FORMAT, appKey: 'k', secretKey: 's', appFolder: 'ok', tokens: { accessToken: 'a', expiresAtMs: 'soon' } }), /连接配置无效/],
    [JSON.stringify({ format: 'other/format', appKey: 'k', secretKey: 's', appFolder: 'ok' }), /版本不匹配/]
  ]
  for (const [text, pattern] of cases) assert.throws(() => parseConnection(text), pattern, text)
})

test('校验入口对空白与路径字符的处理与连接页一致', () => {
  assert.deepEqual(validateConnectionFields({ appKey: ' k ', secretKey: ' s ', appFolder: ' ok ' }), { appKey: 'k', secretKey: 's', appFolder: 'ok' })
  assert.throws(() => validateConnectionFields({ appKey: 'k', secretKey: 's', appFolder: '   ' }), /请填写有效的应用信息/)
  assert.throws(() => validateConnectionFields({ appKey: 'k', secretKey: 's', appFolder: 'a\\b' }), /请填写有效的应用信息/)
  assert.throws(() => validateConnectionFields({ appKey: 'k', secretKey: 's', appFolder: '.' }), /请填写有效的应用信息/)
})

test('导出的文本可以写回凭据文件并被原样读出', t => {
  const store = new CredentialStore(join(temp(t), 'credentials', 'baidu.json'))
  store.write(parseConnection(serializeConnection(credentials, { includeTokens: true })))
  const read = store.read()
  assert.equal(read.appKey, credentials.appKey)
  assert.equal(read.appFolder, '情感记忆插件同步')
  assert.equal(read.tokens.accessToken, 'access-token-value')
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['appFolder', 'appKey', 'secretKey', 'tokens'])
  if (process.platform !== 'win32') assert.equal(statSync(store.file).mode & 0o777, 0o600)
})

test('凭据文件缺字段时报同一句中文提示，不泄露细节', t => {
  const file = join(temp(t), 'baidu.json')
  writeFileSync(file, JSON.stringify({ appKey: 'k' }))
  assert.throws(() => new CredentialStore(file).read(), /本地授权配置无效/)
})

test('界面摘要不解出密钥与令牌', () => {
  const summary = describeConnection(credentials)
  assert.equal(summary.appKey, `***${credentials.appKey.slice(-4)}`)
  assert.equal(summary.hasTokens, true)
  assert.equal(summary.expiresAtMs, 1793000000000)
  const text = JSON.stringify(summary)
  assert.ok(!text.includes(credentials.secretKey))
  assert.ok(!text.includes('access-token-value'))
  assert.equal(describeConnection({ appKey: 'short', secretKey: 's', appFolder: 'x' }).appKey, '***')
})
