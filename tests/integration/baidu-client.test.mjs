import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { BaiduClient, BaiduError } from '../../lib/cloud/baidu-client.js'

const NOW = 1_700_000_000_000
const APP_FOLDER = 'dsh-companion'
const ROOT = `/apps/${APP_FOLDER}`
const APP_KEY = 'app-key-测试'
const SECRET_KEY = 'secret-key-测试'

test('cancel aborts an active request and prevents later requests from using a disconnected client', async () => {
  let notify
  const started = new Promise(resolve => { notify = resolve })
  const { client } = clientFor(call => new Promise((_resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })
    notify()
  }))
  const pending = client.list(ROOT)
  await started; client.cancel()
  await assert.rejects(pending, error => error.code === 'cancelled')
  await assert.rejects(client.list(ROOT), error => error.code === 'cancelled')
})

test('first upload creates application-owned parent directories in order', async () => {
  const directories = [], parents = new Set(['/apps'])
  const { client } = clientFor(call => {
    const form = new URLSearchParams(call.body), method = kindOf(call)
    if (method === 'mkdir') {
      const path = form.get('path')
      assert.ok(parents.has(path.slice(0, path.lastIndexOf('/'))))
      parents.add(path); directories.push(path)
      assert.equal(form.get('rtype'), '0')
      return json({ errno: 0 })
    }
    assert.equal(method, 'precreate')
    return json({ errno: 0, return_type: 2, fs_id: 33, size: 1 })
  })
  await client.upload(`${ROOT}/one/two/file.bin`, new Uint8Array([1]))
  assert.deepEqual(directories, [ROOT, `${ROOT}/one`, `${ROOT}/one/two`])
})

test('a full list page without has_more still fetches the next page', async () => {
  const { client, calls } = clientFor(call => {
    const start = Number(new URL(call.url).searchParams.get('start'))
    return json({ errno: 0, list: start === 0 ? Array.from({ length: 1000 }, (_, i) => ({ fs_id: i + 1, path: `${ROOT}/${i}`, size: 1 })) : [{ fs_id: 1001, path: `${ROOT}/last`, size: 1 }] })
  })
  assert.equal((await client.list(ROOT)).length, 1001)
  assert.equal(calls.length, 2)
})

test('download accepts Baidu PCS CDN subdomains but rejects lookalike domains', async () => {
  for (const host of ['d11.baidupcs.com', 'node.pcs.baidu.com', 'd11.baidupcs.com.evil.invalid']) {
    const { client } = clientFor(call => kindOf(call) === 'filemetas'
      ? json({ errno: 0, list: [{ fs_id: 12, dlink: `https://${host}/file/data` }] })
      : new Response(new Uint8Array([1, 2])))
    const pending = client.download({ id: 12, path: `${ROOT}/file`, name: 'file', size: 2, modifiedAtMs: NOW })
    if (host.endsWith('evil.invalid')) await assert.rejects(pending, error => error.code === 'unsafe-host')
    else assert.deepEqual(Array.from(await pending), [1, 2])
  }
})

test('rapid upload accepts nested info metadata without requiring a redundant list', async () => {
  const { client } = clientFor(call => kindOf(call) === 'mkdir' ? json({ errno: 0 })
    : json({ errno: 0, return_type: 2, uploadid: '', info: { fs_id: 88, path: `${ROOT}/file`, size: 2 } }))
  assert.equal((await client.upload(`${ROOT}/file`, new Uint8Array([1, 2]))).id, 88)
})

function md5(bytes) {
  return createHash('md5').update(bytes).digest('hex')
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recorder(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
      redirect: init.redirect,
      signal: init.signal
    }
    calls.push(call)
    return handler(call, calls)
  }
  return { calls, fetchImpl }
}

function clientFor(handler, overrides = {}) {
  const { calls, fetchImpl } = recorder(handler)
  const saved = []
  const client = new BaiduClient({
    credentials: {
      appKey: APP_KEY,
      secretKey: SECRET_KEY,
      appFolder: APP_FOLDER,
      tokens: { accessToken: 'AT1', refreshToken: 'RT1', expiresAtMs: NOW + 3_600_000 }
    },
    fetchImpl,
    saveTokens: tokens => saved.push(tokens),
    now: () => NOW,
    ...overrides
  })
  return { client, calls, saved }
}

function panOf(call) {
  const url = new URL(call.url)
  return { url, method: url.searchParams.get('method'), token: url.searchParams.get('access_token') }
}

// 官方没有 mkdir：建目录是 method=create + isdir=1，这里把两者区分开，便于用例阅读。
function kindOf(call) {
  const { method } = panOf(call)
  if (method !== 'create' || call.body === undefined) return method
  return new URLSearchParams(call.body).get('isdir') === '1' ? 'mkdir' : 'create'
}

// ── 授权 ──────────────────────────────────────────────────────────────────

test('beginAuthorization posts app_key and scope to the official device endpoint', async () => {
  const { client, calls } = clientFor(() =>
    json({ device_code: 'DC', user_code: 'UC', verification_url: 'https://openapi.baidu.com/device', expires_in: 300, interval: 5 })
  )
  const result = await client.beginAuthorization()
  assert.deepEqual(result, {
    deviceCode: 'DC',
    userCode: 'UC',
    verificationUrl: 'https://openapi.baidu.com/device',
    expiresIn: 300,
    interval: 5
  })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://openapi.baidu.com/oauth/2.0/device/code')
  assert.equal(calls[0].method, 'POST')
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('client_id'), APP_KEY)
  assert.equal(form.get('response_type'), 'device_code')
  assert.equal(form.get('scope'), 'basic,netdisk')
})

test('completeAuthorization is a single poll that reports pending without leaking anything', async () => {
  const { client, calls, saved } = clientFor(() => json({ error: 'authorization_pending' }))
  await assert.rejects(client.completeAuthorization('DC'), error => {
    assert.equal(error.code, 'authorization_pending')
    for (const leaked of [APP_KEY, SECRET_KEY, 'DC', 'access_token', 'secret']) {
      assert.equal(String(error.message).includes(leaked), false, `错误信息泄露了 ${leaked}`)
    }
    return true
  })
  assert.equal(calls.length, 1, '不允许内部循环轮询')
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('grant_type'), 'device_token')
  assert.equal(form.get('code'), 'DC')
  assert.equal(form.get('client_secret'), SECRET_KEY)
  assert.deepEqual(saved, [])
})

test('completeAuthorization persists tokens before the client uses them', async () => {
  const { client, saved } = clientFor(() => json({ access_token: 'AT9', refresh_token: 'RT9', expires_in: 3600 }))
  const tokens = await client.completeAuthorization('DC')
  assert.deepEqual(tokens, { accessToken: 'AT9', refreshToken: 'RT9', expiresAtMs: NOW + 3_600_000 })
  assert.deepEqual(saved, [tokens])
})

test('a denied device code surfaces as its own code, not a generic failure', async () => {
  const { client } = clientFor(() => json({ error: 'access_denied' }))
  await assert.rejects(client.completeAuthorization('DC'), error => error.code === 'authorization_denied')
})

// ── 列目录 ────────────────────────────────────────────────────────────────

test('list paginates, drops directories and never returns paths outside the app folder', async () => {
  const { client, calls } = clientFor(call => {
    const { url } = panOf(call)
    const start = Number(url.searchParams.get('start'))
    if (start === 0) {
      return json({
        errno: 0,
        has_more: 1,
        list: [
          { fs_id: 1, path: `${ROOT}/a.bin`, server_filename: 'a.bin', size: 10, server_mtime: 1700000000, isdir: 0 },
          { fs_id: 2, path: `${ROOT}/sub`, server_filename: 'sub', size: 0, server_mtime: 1700000000, isdir: 1 },
          { fs_id: 3, path: '/apps/other/evil.bin', server_filename: 'evil.bin', size: 5, server_mtime: 1700000000, isdir: 0 },
          { fs_id: 4, path: `${ROOT}/../../escape.bin`, server_filename: 'escape.bin', size: 5, server_mtime: 1700000000, isdir: 0 }
        ]
      })
    }
    return json({
      errno: 0,
      has_more: 0,
      list: [{ fs_id: 5, path: `${ROOT}/b.bin`, server_filename: 'b.bin', size: 20, server_mtime: 1700000123, isdir: 0 }]
    })
  })

  const files = await client.list(ROOT)
  assert.deepEqual(files.map(file => file.id), [1, 5])
  assert.deepEqual(files[0], { id: 1, name: 'a.bin', path: `${ROOT}/a.bin`, size: 10, modifiedAtMs: 1_700_000_000_000 })
  assert.deepEqual(files[1], { id: 5, name: 'b.bin', path: `${ROOT}/b.bin`, size: 20, modifiedAtMs: 1_700_000_123_000 })
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1].url).searchParams.get('start'), '1000')
  assert.equal(panOf(calls[0]).method, 'list')
  assert.equal(new URL(calls[0].url).searchParams.get('dir'), ROOT)
})

test('list treats a missing directory as empty instead of an error', async () => {
  const { client } = clientFor(() => json({ errno: 12, list: [] }))
  assert.deepEqual(await client.list(`${ROOT}/nope`), [])
})

test('list defaults to the app folder when asked for the root', async () => {
  const { client, calls } = clientFor(() => json({ errno: 0, has_more: 0, list: [] }))
  await client.list('/')
  assert.equal(new URL(calls[0].url).searchParams.get('dir'), ROOT)
})

// ── 上传 ──────────────────────────────────────────────────────────────────

test('rapid upload (return_type 2) succeeds with an empty uploadid and never calls create', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    // 官方 scene/upload.go:104 —— 秒传时 uploadid 允许为空，直接算成功。
    if (method === 'precreate') return json({ errno: 0, uploadid: '', return_type: 2, block_list: [] })
    if (method === 'list') {
      return json({
        errno: 0,
        list: [
          {
            fs_id: 777,
            path: `${ROOT}/dev-a.bin`,
            server_filename: 'dev-a.bin',
            size: 5,
            isdir: 0,
            server_mtime: 1_700_000_500
          }
        ]
      })
    }
    throw new Error(`unexpected method ${method}`)
  })

  const file = await client.upload(`${ROOT}/dev-a.bin`, bytes)
  assert.deepEqual(file, {
    id: 777,
    name: 'dev-a.bin',
    path: `${ROOT}/dev-a.bin`,
    size: 5,
    modifiedAtMs: 1_700_000_500_000
  })
  assert.equal(calls.some(call => kindOf(call) === 'create'), false, '秒传不能拿空 uploadid 去 create')
  assert.equal(calls.some(call => call.url.startsWith('https://d.pcs.baidu.com/')), false, '快速上传不应传分片')

  const precreate = new URLSearchParams(calls.find(call => panOf(call).method === 'precreate').body)
  // xpan 文件上传使用 rtype 3 覆盖；请求侧 block_list 是分片 md5。
  assert.equal(precreate.get('rtype'), '3')
  assert.equal(precreate.get('size'), '5')
  assert.equal(precreate.get('autoinit'), '1')
  assert.deepEqual(JSON.parse(precreate.get('block_list')), [md5(bytes)])
})

test('rapid upload resolves fs_id from precreate when the API provides one', async () => {
  const bytes = new Uint8Array([9, 9, 9])
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') {
      return json({ errno: 0, uploadid: '', return_type: 2, fs_id: 4242, size: 3, mtime: 1_700_000_800 })
    }
    throw new Error(`unexpected method ${method}`)
  })

  const file = await client.upload(`${ROOT}/dev-f.bin`, bytes)
  assert.equal(file.id, 4242)
  assert.equal(file.modifiedAtMs, 1_700_000_800_000)
  assert.equal(calls.some(call => panOf(call).method === 'list'), false, '有 fs_id 就不必列目录')
})

test('rapid upload fails loudly when no fs_id can be confirmed', async () => {
  const { client } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: '', return_type: 2, block_list: [] })
    if (method === 'list') {
      // 同名但大小不同：不是这次上传的文件，不能拿来冒充成功。
      return json({
        errno: 0,
        list: [
          { fs_id: 1, path: `${ROOT}/dev-g.bin`, server_filename: 'dev-g.bin', size: 99, isdir: 0, server_mtime: 1 }
        ]
      })
    }
    throw new Error(`unexpected method ${method}`)
  })

  await assert.rejects(client.upload(`${ROOT}/dev-g.bin`, new Uint8Array([1])), error => {
    assert.equal(error.code, 'rapid-upload-unresolved')
    return true
  })
})

test('chunked upload sends 4MiB parts as multipart and uploads the parts the server asks for', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1000)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
  const first = bytes.subarray(0, 4 * 1024 * 1024)
  const digests = [md5(first), md5(bytes.subarray(4 * 1024 * 1024))]

  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    // 响应侧 block_list 是「还要传的分片序号」，不是 md5（官方 upload_precreate.go:61-63）。
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP2', return_type: 1, block_list: [0, 1] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) {
      const part = Number(new URL(call.url).searchParams.get('partseq'))
      return json({ errno: 0, md5: digests[part] })
    }
    if (method === 'create') return json({ errno: 0, fs_id: 888, path: `${ROOT}/dev-b.bin`, size: bytes.length, mtime: 1_700_000_600 })
    throw new Error(`unexpected ${method}`)
  })

  const file = await client.upload(`${ROOT}/dev-b.bin`, bytes)
  assert.equal(file.id, 888)
  assert.equal(file.size, bytes.length)

  const precreate = new URLSearchParams(calls.find(call => panOf(call).method === 'precreate').body)
  assert.deepEqual(JSON.parse(precreate.get('block_list')), digests, '请求侧仍是 md5 列表')

  const parts = calls.filter(call => call.url.startsWith('https://d.pcs.baidu.com/'))
  assert.deepEqual(
    parts.map(call => new URL(call.url).searchParams.get('partseq')),
    ['0', '1']
  )
  const partUrl = new URL(parts[0].url)
  assert.equal(partUrl.searchParams.get('method'), 'upload')
  assert.equal(partUrl.searchParams.get('type'), 'tmpfile')
  assert.equal(partUrl.searchParams.get('path'), `${ROOT}/dev-b.bin`)
  assert.equal(partUrl.searchParams.get('uploadid'), 'UP2')

  const contentType = parts[0].headers['content-type']
  assert.match(contentType, /^multipart\/form-data; boundary=----dsh/)
  const boundary = contentType.split('boundary=')[1]
  const body = Buffer.from(parts[0].body)
  assert.ok(body.includes(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"`)))
  assert.ok(body.includes(Buffer.from(`\r\n--${boundary}--\r\n`)))
  assert.equal(body.includes(Buffer.from(first.subarray(0, 64))), true, '分片内容必须原样上传')

  const create = new URLSearchParams(calls.find(call => kindOf(call) === 'create').body)
  assert.equal(create.get('uploadid'), 'UP2')
  assert.equal(create.get('rtype'), '3')
})

test('only the parts missing on the server are uploaded', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 10)
  const digests = [md5(bytes.subarray(0, 4 * 1024 * 1024)), md5(bytes.subarray(4 * 1024 * 1024))]
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP6', return_type: 1, block_list: [1] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) return json({ errno: 0, md5: digests[1] })
    if (method === 'create') return json({ errno: 0, fs_id: 606, path: `${ROOT}/dev-c.bin`, size: bytes.length })
    throw new Error(`unexpected ${method}`)
  })

  await client.upload(`${ROOT}/dev-c.bin`, bytes)
  assert.deepEqual(
    calls.filter(call => call.url.startsWith('https://d.pcs.baidu.com/')).map(call => new URL(call.url).searchParams.get('partseq')),
    ['1'],
    '第 0 片已在服务端，不能重传'
  )
})

test('a malformed part index list is rejected instead of silently uploading everything', async () => {
  const bad = [[-1], [2], ['x'], [1.5], [null], {}]
  for (const blockList of bad) {
    const { client, calls } = clientFor(call => {
      const method = kindOf(call)
      if (method === 'mkdir') return json({ errno: 0 })
      if (method === 'precreate') return json({ errno: 0, uploadid: 'UP7', return_type: 1, block_list: blockList })
      if (call.url.startsWith('https://d.pcs.baidu.com/')) return json({ errno: 0 })
      if (method === 'create') return json({ errno: 0, fs_id: 1, path: `${ROOT}/x.bin` })
      throw new Error(`unexpected ${method}`)
    })
    await assert.rejects(client.upload(`${ROOT}/x.bin`, new Uint8Array([1])), error => {
      assert.equal(error.code, 'invalid-response', `block_list=${JSON.stringify(blockList)}`)
      return true
    })
    assert.equal(calls.some(call => call.url.startsWith('https://d.pcs.baidu.com/')), false)
  }
})

test('an omitted part index list means every part must be uploaded', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1)
  const digests = [md5(bytes.subarray(0, 4 * 1024 * 1024)), md5(bytes.subarray(4 * 1024 * 1024))]
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP8', return_type: 1 })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) {
      return json({ errno: 0, md5: digests[Number(new URL(call.url).searchParams.get('partseq'))] })
    }
    if (method === 'create') return json({ errno: 0, fs_id: 8, path: `${ROOT}/dev-d.bin`, size: bytes.length })
    throw new Error(`unexpected ${method}`)
  })

  await client.upload(`${ROOT}/dev-d.bin`, bytes)
  assert.equal(calls.filter(call => call.url.startsWith('https://d.pcs.baidu.com/')).length, 2)
})

test('creating the app folder is idempotent when it already exists', async () => {
  const bytes = new Uint8Array([7])
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: -8, info: [{ errno: -8 }] })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP3', return_type: 1, block_list: [0] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) return json({ errno: 0, md5: md5(bytes) })
    if (method === 'create') return json({ errno: 0, fs_id: 5, path: `${ROOT}/c.bin`, size: 1, mtime: 1_700_000_700 })
    throw new Error(`unexpected ${method}`)
  })
  const file = await client.upload(`${ROOT}/c.bin`, bytes)
  assert.equal(file.id, 5)
  assert.equal(calls.filter(call => kindOf(call) === 'mkdir').length, 1)
})

// ── 令牌 ──────────────────────────────────────────────────────────────────

test('concurrent calls share a single refresh request (singleflight)', async () => {
  let tokenRequests = 0
  const { client, calls, saved } = clientFor(
    call => {
      if (call.url.startsWith('https://openapi.baidu.com/oauth/2.0/token')) {
        tokenRequests += 1
        return json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })
      }
      return json({ errno: 0, has_more: 0, list: [] })
    },
    { credentials: { appKey: APP_KEY, secretKey: SECRET_KEY, appFolder: APP_FOLDER, tokens: { accessToken: 'AT1', refreshToken: 'RT1', expiresAtMs: NOW - 1000 } } }
  )

  await Promise.all([client.list(ROOT), client.list(ROOT), client.list(ROOT)])
  assert.equal(tokenRequests, 1, '并发刷新只能发一次')
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0], { accessToken: 'AT2', refreshToken: 'RT2', expiresAtMs: NOW + 3_600_000 })
  const listCalls = calls.filter(call => panOf(call).method === 'list')
  assert.deepEqual(
    listCalls.map(call => panOf(call).token),
    ['AT2', 'AT2', 'AT2']
  )
})

test('an auth errno triggers one refresh and one retry', async () => {
  let listCalls = 0
  const { client, calls } = clientFor(call => {
    if (call.url.startsWith('https://openapi.baidu.com/oauth/2.0/token')) {
      return json({ access_token: 'AT3', refresh_token: 'RT3', expires_in: 3600 })
    }
    listCalls += 1
    return listCalls === 1 ? json({ errno: -6 }) : json({ errno: 0, has_more: 0, list: [] })
  })

  assert.deepEqual(await client.list(ROOT), [])
  assert.equal(listCalls, 2)
  const tokens = calls.filter(call => panOf(call).method === 'list').map(call => panOf(call).token)
  assert.deepEqual(tokens, ['AT1', 'AT3'])
})

test('a repeated auth errno fails once instead of looping', async () => {
  let listCalls = 0
  const { client } = clientFor(call => {
    if (call.url.startsWith('https://openapi.baidu.com/oauth/2.0/token')) {
      return json({ access_token: 'AT4', refresh_token: 'RT4', expires_in: 3600 })
    }
    listCalls += 1
    return json({ errno: -6 })
  })
  await assert.rejects(client.list(ROOT), error => {
    assert.equal(error.code, 'baidu--6')
    return true
  })
  assert.equal(listCalls, 2, '只允许一次重试')
})

test('refresh failure asks for reauthorization without echoing the response', async () => {
  const { client } = clientFor(
    () => json({ error: 'invalid_grant', error_description: 'refresh_token=RT1 secret=SECRET_KEY' }),
    { credentials: { appKey: APP_KEY, secretKey: SECRET_KEY, appFolder: APP_FOLDER, tokens: { accessToken: 'AT1', refreshToken: 'RT1', expiresAtMs: NOW - 1000 } } }
  )
  await assert.rejects(client.list(ROOT), error => {
    assert.equal(error.code, 'refresh-failed')
    for (const leaked of ['RT1', SECRET_KEY, 'invalid_grant', 'error_description']) {
      assert.equal(String(error.message).includes(leaked), false, `错误信息泄露了 ${leaked}`)
    }
    return true
  })
})

// ── 下载 ──────────────────────────────────────────────────────────────────

test('download resolves dlink, follows an allowed redirect and sends the pan.baidu.com UA', async () => {
  const payload = new Uint8Array([9, 8, 7, 6])
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'filemetas') {
      return json({ errno: 0, list: [{ fs_id: 42, dlink: 'https://d.pcs.baidu.com/file/abc?fid=42' }] })
    }
    if (call.url.startsWith('https://d.pcs.baidu.com/file/abc?fid=42')) {
      return new Response(null, { status: 302, headers: { location: 'https://d.pcs.baidu.com/file/def?fid=42' } })
    }
    if (call.url.startsWith('https://d.pcs.baidu.com/file/def')) {
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.byteLength) } })
    }
    throw new Error(`unexpected ${call.url}`)
  })

  const bytes = await client.download({ id: 42, name: 'a.bin', path: `${ROOT}/a.bin`, size: 4, modifiedAtMs: NOW })
  assert.deepEqual(Array.from(bytes), [9, 8, 7, 6])

  const metas = new URL(calls.find(call => panOf(call).method === 'filemetas').url)
  // 官方 download_meta.go: filemetas 在 multimedia 分组下，走 xpan/file 会 404。
  assert.equal(metas.pathname, '/rest/2.0/xpan/multimedia')
  assert.equal(metas.searchParams.get('fsids'), '[42]')
  assert.equal(metas.searchParams.get('dlink'), '1')

  const first = new URL(calls[1].url)
  assert.equal(first.searchParams.get('access_token'), 'AT1', 'dlink 需要补 access_token')
  assert.equal(calls[1].headers['User-Agent'], 'pan.baidu.com')
  assert.equal(calls[1].redirect, 'manual')
  assert.equal(calls[2].headers['User-Agent'], 'pan.baidu.com')
})

test('download refuses a redirect to a host outside the Baidu allowlist', async () => {
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'filemetas') return json({ errno: 0, list: [{ fs_id: 7, dlink: 'https://d.pcs.baidu.com/file/x?fid=7' }] })
    return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal?fid=7' } })
  })
  await assert.rejects(client.download({ id: 7, name: 'x', path: `${ROOT}/x`, size: 1, modifiedAtMs: NOW }), error => {
    assert.equal(error.code, 'unsafe-host')
    return true
  })
  assert.equal(calls.length, 2, '越权重定向必须停在第二跳之前')
})

test('an http dlink is rejected before any request is made', async () => {
  const { client, calls } = clientFor(call => json({ errno: 0, list: [{ fs_id: 8, dlink: 'http://d.pcs.baidu.com/file/y?fid=8' }] }))
  await assert.rejects(client.download({ id: 8, name: 'y', path: `${ROOT}/y`, size: 1, modifiedAtMs: NOW }), error => {
    assert.equal(error.code, 'unsafe-url')
    return true
  })
  assert.equal(calls.length, 1, '只允许 filemetas 这一跳')
})

// ── 边界与脱敏 ────────────────────────────────────────────────────────────

test('remote paths outside the app folder, with dot segments, backslashes or control characters are refused', async () => {
  const { client, calls } = clientFor(() => json({ errno: 0, has_more: 0, list: [] }))
  const cases = [
    ['../escape', 'unsafe-path'],
    ['/apps/other/x.bin', 'path-outside-app-folder'],
    [`${ROOT}/../../x.bin`, 'unsafe-path'],
    [`${ROOT}/a\\b.bin`, 'unsafe-path'],
    [`${ROOT}/a\u0007b.bin`, 'unsafe-path'],
    [ROOT, 'unsafe-path']
  ]
  for (const [path, code] of cases) {
    await assert.rejects(client.upload(path, new Uint8Array([1])), error => {
      assert.equal(error.code, code, `${path} 应被拒绝为 ${code}`)
      return true
    })
  }
  assert.equal(calls.length, 0, '非法路径不应发出任何请求')
})

test('an oversized transfer is refused without touching the network', async () => {
  const { client, calls } = clientFor(() => json({ errno: 0 }))
  const huge = { byteLength: 512 * 1024 * 1024 + 1 }
  await assert.rejects(client.upload(`${ROOT}/big.bin`, huge), error => error.code === 'too-large')
  assert.equal(calls.length, 0)
})

test('a stalled request times out as its own error code', async () => {
  // send() 的超时计时器是 unref 的：若没有别的句柄，事件循环会先退出，
  // 表现为 "Promise resolution is still pending"，所以这里自己保活。
  const keepAlive = setTimeout(() => {}, 1000)
  const { client } = clientFor(
    call =>
      new Promise((_resolve, reject) => {
        call.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
      }),
    { timeoutMs: 20 }
  )
  try {
    await assert.rejects(client.list(ROOT), error => {
      assert.equal(error.code, 'timeout')
      assert.equal(String(error.message).includes('pan.baidu.com'), false)
      return true
    })
  } finally {
    clearTimeout(keepAlive)
  }
})

test('a business errno is reported by code without echoing the response body', async () => {
  const { client } = clientFor(() =>
    json({ errno: 31066, errmsg: 'token=AT1 secret=SECRET_KEY path=/apps/x/private.bin' })
  )
  await assert.rejects(client.list(ROOT), error => {
    assert.equal(error.code, 'baidu-31066')
    for (const leaked of ['AT1', SECRET_KEY, 'private.bin', 'errmsg']) {
      assert.equal(String(error.message).includes(leaked), false, `错误信息泄露了 ${leaked}`)
    }
    return true
  })
})

test('a non-JSON response is reported as invalid instead of being parsed loosely', async () => {
  const { client } = clientFor(() => new Response('<html>gateway</html>', { status: 200 }))
  await assert.rejects(client.list(ROOT), error => {
    assert.equal(error.code, 'invalid-response')
    assert.equal(String(error.message).includes('gateway'), false)
    return true
  })
})

test('BaiduError instances stay identifiable for callers', async () => {
  const { client } = clientFor(() => json({ errno: 4 }))
  await assert.rejects(client.list(ROOT), error => {
    assert.ok(error instanceof BaiduError)
    assert.equal(error.name, 'BaiduError')
    assert.equal(error.code, 'baidu-4')
    return true
  })
})

test('a missing remote directory reads as empty instead of failing the caller', async () => {
  const { client } = clientFor(() => json({ errno: 12 }))
  assert.deepEqual(await client.list(ROOT), [])
})

test('a part body is byte-exact: head + chunk + tail and nothing else', async () => {
  const bytes = new Uint8Array(1024)
  bytes.fill(7)
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP3', return_type: 1, block_list: [0] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) return json({ errno: 0, md5: md5(bytes) })
    if (method === 'create') return json({ errno: 0, fs_id: 1, path: `${ROOT}/small.bin`, size: bytes.length })
    throw new Error(`unexpected ${method}`)
  })

  await client.upload(`${ROOT}/small.bin`, bytes)
  const part = calls.find(call => call.url.startsWith('https://d.pcs.baidu.com/'))
  const boundary = part.headers['content-type'].split('boundary=')[1]
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'
  const tail = `\r\n--${boundary}--\r\n`
  const body = Buffer.from(part.body)
  const headLength = Buffer.byteLength(head)

  assert.equal(body.length, headLength + bytes.length + Buffer.byteLength(tail), '不能多一个字节')
  assert.equal(body.subarray(0, headLength).toString('utf8'), head)
  assert.deepEqual(new Uint8Array(body.subarray(headLength, headLength + bytes.length)), bytes, '分片必须逐字节原样')
  assert.equal(body.subarray(headLength + bytes.length).toString('utf8'), tail)
  assert.equal(boundary.length > 8, true)
})

test('a server-side md5 rejection surfaces as its own code without echoing the body', async () => {
  const bytes = new Uint8Array(64)
  const { client } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP4', return_type: 1, block_list: [0] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) return json({ errno: 0, md5: md5(bytes) })
    if (method === 'create') {
      return json({ errno: 2, errmsg: 'md5 mismatch uploadid=UP4 path=/apps/dsh-companion/secret.bin' })
    }
    throw new Error(`unexpected ${method}`)
  })

  await assert.rejects(client.upload(`${ROOT}/secret.bin`, bytes), error => {
    assert.ok(error instanceof BaiduError)
    assert.equal(error.code, 'baidu-2')
    for (const leaked of ['md5 mismatch', 'UP4', 'secret.bin']) {
      assert.equal(String(error.message).includes(leaked), false, `错误信息泄露了 ${leaked}`)
    }
    return true
  })
})

test('a part upload that hits an expired token refreshes once and retries the same part', async () => {
  const bytes = new Uint8Array(2048)
  bytes.fill(3)
  let partAttempts = 0
  const { client, calls, saved } = clientFor(call => {
    const method = kindOf(call)
    if (call.url.startsWith('https://openapi.baidu.com/oauth/2.0/token')) {
      return json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })
    }
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP5', return_type: 1, block_list: [0] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) {
      partAttempts += 1
      return partAttempts === 1 ? json({ errno: -6, errmsg: 'token=AT1 expired' }) : json({ errno: 0, md5: md5(bytes) })
    }
    if (method === 'create') return json({ errno: 0, fs_id: 77, path: `${ROOT}/retry.bin`, size: bytes.length })
    throw new Error(`unexpected ${method}`)
  })

  const file = await client.upload(`${ROOT}/retry.bin`, bytes)
  assert.equal(file.id, 77)
  const parts = calls.filter(call => call.url.startsWith('https://d.pcs.baidu.com/'))
  assert.equal(parts.length, 2, '过期后必须重试一次，而不是直接失败')
  assert.deepEqual(
    parts.map(call => new URL(call.url).searchParams.get('partseq')),
    ['0', '0'],
    '重试的是同一分片'
  )
  assert.equal(new URL(parts[0].url).searchParams.get('access_token'), 'AT1')
  assert.equal(new URL(parts[1].url).searchParams.get('access_token'), 'AT2')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].accessToken, 'AT2')
})

test('official expiry errnos 20016 and 31045 also trigger the refresh path', async () => {
  for (const errno of [20016, 31045]) {
    let fileApiCalls = 0
    const { client, saved } = clientFor(call => {
      const { url } = panOf(call)
      if (call.url.startsWith('https://openapi.baidu.com/oauth/2.0/token')) {
        return json({ access_token: `AT-${errno}`, expires_in: 3600 })
      }
      fileApiCalls += 1
      return fileApiCalls === 1 ? json({ errno }) : json({ errno: 0, list: [] })
    })
    assert.deepEqual(await client.list(ROOT), [], `errno ${errno} 应当刷新后重试`)
    assert.equal(fileApiCalls, 2)
    assert.equal(saved.at(-1).accessToken, `AT-${errno}`)
  }
})

test('download asks filemetas for the exact fs_id and rejects a response for another file', async () => {
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'filemetas') {
      return json({ errno: 0, list: [{ fs_id: 999, dlink: 'https://d.pcs.baidu.com/file/other?access_token=AT1' }] })
    }
    throw new Error(`unexpected ${method}`)
  })

  await assert.rejects(
    client.download({ id: 123, name: 'a.bin', path: `${ROOT}/a.bin`, size: 10, modifiedAtMs: NOW }),
    error => {
      assert.equal(error.code, 'missing-dlink')
      return true
    }
  )
  const metas = new URL(calls.find(call => panOf(call).method === 'filemetas').url)
  assert.equal(metas.pathname, '/rest/2.0/xpan/multimedia')
  assert.equal(metas.searchParams.get('fsids'), '[123]')
  assert.equal(metas.searchParams.get('dlink'), '1')
  assert.equal(calls.length, 1, '没有匹配的 fs_id 就不应该去下载')
})

test('download refuses a dlink on a host outside the allowlist', async () => {
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'filemetas') {
      return json({ errno: 0, list: [{ fs_id: 5, dlink: 'https://evil.example.com/f?access_token=AT1' }] })
    }
    throw new Error('不能真的去请求外站')
  })

  await assert.rejects(
    client.download({ id: 5, name: 'b.bin', path: `${ROOT}/b.bin`, size: 10, modifiedAtMs: NOW }),
    error => {
      assert.equal(error.code, 'unsafe-host')
      return true
    }
  )
  assert.equal(calls.length, 1)
})

test('a dlink answered with 401 refreshes once and retries the download', async () => {
  const payload = new Uint8Array([1, 2, 3, 4])
  let dlinkHits = 0
  const { client, calls, saved } = clientFor(call => {
    const { method, url } = panOf(call)
    if (call.url.startsWith('https://openapi.baidu.com/oauth/2.0/token')) {
      return json({ access_token: 'AT2', expires_in: 3600 })
    }
    if (method === 'filemetas') {
      return json({ errno: 0, list: [{ fs_id: 42, dlink: 'https://d.pcs.baidu.com/file/x?access_token=AT1' }] })
    }
    if (call.url.startsWith('https://d.pcs.baidu.com/file/')) {
      dlinkHits += 1
      if (dlinkHits === 1) return new Response('denied', { status: 401 })
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } })
    }
    throw new Error(`unexpected ${method}`)
  })

  const bytes = await client.download({ id: 42, name: 'x.bin', path: `${ROOT}/x.bin`, size: 4, modifiedAtMs: NOW })
  assert.deepEqual(new Uint8Array(bytes), payload)
  assert.equal(dlinkHits, 2)
  const second = calls.filter(call => call.url.startsWith('https://d.pcs.baidu.com/file/'))[1]
  assert.equal(new URL(second.url).searchParams.get('access_token'), 'AT2')
  assert.equal(saved.at(-1).accessToken, 'AT2')
})

// ── 协议细节回归（官方 SDK 核对项） ──────────────────────────────────────

test('a response whose body stalls after the headers still times out', async () => {
  const { client } = clientFor(
    call => {
      const method = kindOf(call)
      if (method === 'list') {
        // 头部立刻回来、body 永远不结束：只给 fetch 本身设超时的实现会在这里挂死。
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () =>
            new Promise((_resolve, reject) => {
              call.signal.addEventListener('abort', () => reject(new Error('aborted')))
            }),
          arrayBuffer: () => new Promise(() => {}),
          body: null
        }
      }
      throw new Error(`unexpected ${method}`)
    },
    { timeoutMs: 40 }
  )

  // 客户端的超时定时器是 unref 的（生产里不许拖住进程），所以测试要自己撑住事件循环。
  const keepAlive = setInterval(() => {}, 50)
  try {
    await assert.rejects(client.list(ROOT), error => {
      assert.equal(error.code, 'timeout')
      return true
    })
  } finally {
    clearInterval(keepAlive)
  }
})
test('a download body is cut off as soon as it passes the transfer cap', async () => {
  const chunk = new Uint8Array(400)
  let cancelled = false
  const { client } = clientFor(
    call => {
      const method = kindOf(call)
      if (method === 'filemetas') {
        return json({ errno: 0, list: [{ fs_id: 42, dlink: 'https://d.pcs.baidu.com/file/big?fid=42' }] })
      }
      if (call.url.startsWith('https://d.pcs.baidu.com/file/big')) {
        let served = 0
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          text: async () => '',
          arrayBuffer: async () => new Uint8Array(0),
          body: {
            getReader: () => ({
              read: async () => {
                served += 1
                return served > 10 ? { done: true } : { done: false, value: chunk }
              },
              cancel: async () => {
                cancelled = true
              }
            })
          }
        }
      }
      throw new Error(`unexpected ${call.url}`)
    },
    { maxTransferBytes: 1024 }
  )

  await assert.rejects(
    client.download({ id: 42, name: 'big', path: `${ROOT}/big`, size: 1, modifiedAtMs: NOW }),
    error => {
      assert.equal(error.code, 'too-large')
      return true
    }
  )
  assert.equal(cancelled, true, '超过上限要立刻取消流，不能等整个 body 落地')
})

test('the device page must be the official openapi.baidu.com/device URL', async () => {
  const bad = [
    'https://evil.example.com/device',
    'https://pan.baidu.com/device',
    'https://openapi.baidu.com@evil.example.com/device',
    'https://openapi.baidu.com:8443/device',
    'http://openapi.baidu.com/device',
    'https://openapi.baidu.com/oauth/authorize'
  ]
  for (const verification_url of bad) {
    const { client } = clientFor(() =>
      json({ device_code: 'DC', user_code: 'UC', verification_url, expires_in: 300, interval: 5 })
    )
    await assert.rejects(client.beginAuthorization(), error => {
      assert.equal(error.code.startsWith('unsafe-'), true, `${verification_url} → ${error.code}`)
      return true
    })
  }
})

test('a part md5 that disagrees with the local digest fails before create', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const { client, calls } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP9', return_type: 1, block_list: [0] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) return json({ errno: 0, md5: 'deadbeef' })
    if (method === 'create') return json({ errno: 0, fs_id: 1, path: `${ROOT}/m.bin` })
    throw new Error(`unexpected ${method}`)
  })

  await assert.rejects(client.upload(`${ROOT}/m.bin`, bytes), error => {
    assert.equal(error.code, 'part-md5-mismatch')
    return true
  })
  assert.equal(calls.some(call => kindOf(call) === 'create'), false, '分片 md5 不对就不该 create')
})

test('a silently renamed file fails instead of pretending the overwrite worked', async () => {
  const bytes = new Uint8Array([1])
  const { client } = clientFor(call => {
    const method = kindOf(call)
    if (method === 'mkdir') return json({ errno: 0 })
    if (method === 'precreate') return json({ errno: 0, uploadid: 'UP10', return_type: 1, block_list: [0] })
    if (call.url.startsWith('https://d.pcs.baidu.com/')) return json({ errno: 0, md5: md5(bytes) })
    if (method === 'create') return json({ errno: 0, fs_id: 3, path: `${ROOT}/sync(1).json`, size: 1 })
    throw new Error(`unexpected ${method}`)
  })

  await assert.rejects(client.upload(`${ROOT}/sync.json`, bytes), error => {
    assert.equal(error.code, 'path-renamed')
    return true
  })
})
