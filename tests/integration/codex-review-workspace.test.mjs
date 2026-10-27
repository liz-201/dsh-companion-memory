import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createReviewWorkspace } from '../../scripts/codex-review-workspace.mjs'

const executeFile = promisify(execFile)

async function fixture(t, initialize = true) {
  const temporaryBase = await realpath(tmpdir())
  const directory = await mkdtemp(join(temporaryBase, 'codex-review-workspace-'))
  const root = join(directory, 'repo')
  await mkdir(root)
  t.after(async () => {
    const target = resolve(directory)
    assert.equal(dirname(target), temporaryBase)
    assert.match(basename(target), /^codex-review-workspace-[a-z\d]+$/iu)
    assert.ok(!relative(temporaryBase, target).startsWith(`..${sep}`))
    await rm(target, { recursive: true, force: true })
  })
  const git = async (...args) => (await executeFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, windowsHide: true })).stdout
  const put = async (path, content = `file ${path}\n`) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  if (initialize) await git('init', '-q')
  return { directory, root, git, put }
}

test('review snapshot captures working changes and untracked source while excluding tracked runtime and sensitive data', async t => {
  const { root, git, put } = await fixture(t)
  const excluded = ['dist/bundle.js', 'node_modules/pkg/index.js', 'artifacts/previous/source.ts',
    'credentials/private.json', 'credentials.json', '.env', '.env.test', 'memory.sqlite',
    'memory.sqlite-wal', 'data/state.db', 'data/state.DB3', 'private.pem', 'auth.json']
  await put('.gitignore', 'ignored/\ndocs/_exchange/\n')
  await put('src/current.ts', 'old source\n')
  await put('src/cloud/credentials.ts', 'export const safeSourceCode = true\n')
  for (const path of excluded) await put(path, 'sensitive-runtime-marker\n')
  await git('add', '-f', '.gitignore', 'src', ...excluded)
  await git('-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', 'commit', '-qm', 'baseline')
  await put('src/current.ts', 'current uncommitted source\n')
  await put('src/new.ts', 'new untracked source\n')
  await put('ignored/not-source.txt', 'ignored-marker\n')
  const before = await git('status', '--porcelain=v1', '--untracked-files=all')
  const result = await createReviewWorkspace(root, { id: 'parallel-review' })
  assert.equal(result.sourceRoot, await realpath(root))
  assert.equal(dirname(result.cwd), join(root, 'artifacts', 'codex-reviews'))
  assert.match(basename(result.cwd), /^parallel-review-[a-f\d-]+$/u)
  assert.deepEqual(result.files, ['.gitignore', 'src/cloud/credentials.ts', 'src/current.ts', 'src/new.ts'])
  assert.equal(await readFile(join(result.cwd, 'src/current.ts'), 'utf8'), 'current uncommitted source\n')
  assert.equal(await readFile(join(result.cwd, 'src/new.ts'), 'utf8'), 'new untracked source\n')
  await assert.rejects(lstat(join(result.cwd, '.git')), { code: 'ENOENT' })
  const manifestText = await readFile(result.manifestFile, 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.gitHead, (await git('rev-parse', 'HEAD')).trim())
  assert.equal(manifest.sourceRoot, result.sourceRoot)
  assert.ok(Number.isFinite(Date.parse(manifest.createdAt)))
  assert.ok(!manifestText.includes('current uncommitted source'))
  assert.ok(!manifestText.includes('sensitive-runtime-marker'))
  assert.deepEqual(manifest.files.find(file => file.path === 'src/current.ts'), {
    path: 'src/current.ts', bytes: Buffer.byteLength('current uncommitted source\n'),
    sha256: createHash('sha256').update('current uncommitted source\n').digest('hex'),
  })
  await writeFile(join(result.cwd, 'src/current.ts'), 'review edit\n')
  assert.equal(await readFile(join(root, 'src/current.ts'), 'utf8'), 'current uncommitted source\n')
  const after = await git('status', '--porcelain=v1', '--untracked-files=all')
  assert.equal(after.split('\n').filter(line => !line.includes('artifacts/codex-reviews/')).join('\n'), before)
})

test('review copies at most two explicit ignored exchange documents without traversing their neighbors', async t => {
  const { directory, root, put, git } = await fixture(t)
  await put('.gitignore', 'docs/_exchange/\n')
  await git('add', '.gitignore')
  await put('docs/_exchange/first.md', 'handoff one\n')
  await put('docs/_exchange/second.md', 'handoff two\n')
  await put('docs/_exchange/TO_CHATGPT/NIGHT-HANDOFF.md', 'nested handoff\n')
  await put('docs/_exchange/TO_CHATGPT/private.md', 'must not copy nested neighbor\n')
  await put('docs/_exchange/private.md', 'must not copy\n')
  const result = await createReviewWorkspace(root, { baseDirectory: join(directory, 'reviews'),
    extraPaths: ['docs/_exchange/first.md', 'docs/_exchange/TO_CHATGPT/NIGHT-HANDOFF.md'] })
  assert.deepEqual(result.files, ['.gitignore', 'docs/_exchange/TO_CHATGPT/NIGHT-HANDOFF.md', 'docs/_exchange/first.md'])
  assert.deepEqual((await readdir(join(result.cwd, 'docs/_exchange'))).sort(), ['TO_CHATGPT', 'first.md'])
  assert.deepEqual(await readdir(join(result.cwd, 'docs/_exchange/TO_CHATGPT')), ['NIGHT-HANDOFF.md'])
  assert.equal(await readFile(join(result.cwd, 'docs/_exchange/TO_CHATGPT/NIGHT-HANDOFF.md'), 'utf8'), 'nested handoff\n')
  assert.equal(JSON.parse(await readFile(result.manifestFile, 'utf8')).gitHead, null)
  await assert.rejects(createReviewWorkspace(root, { extraPaths: Array(3).fill('docs/_exchange/first.md') }), /At most two/u)
  await assert.rejects(createReviewWorkspace(root, { extraPaths: ['docs/_exchange/missing/deleted.md'] }), { code: 'ENOENT' })
})

test('review rejects traversal, ambiguous names, and extra paths outside the explicit exchange files', async t => {
  const { root } = await fixture(t)
  const paths = ['../outside.md', '/docs/_exchange/one.md', 'C:/docs/_exchange/one.md',
    'docs\\_exchange\\one.md', 'docs/_exchange/../one.md', 'docs/_exchange/one.md:stream',
    'docs/_exchange/.env.md', 'docs/_exchange/nested/../one.md', 'docs/_exchange/one.sqlite',
    'src/one.md', 'docs//one.md', 'docs/_exchange/one.md.', 'docs/_exchange/one\0.md']
  for (const path of paths) await assert.rejects(createReviewWorkspace(root, { extraPaths: [path] }), /Review|review|Extra/u)
  for (const id of ['../escape', 'nested/name', 'bad\\name', 'x:stream', '..', '', 'a'.repeat(65)]) {
    await assert.rejects(createReviewWorkspace(root, { id }), /safe name/u)
  }
  await assert.rejects(createReviewWorkspace(root, { extraPaths: 'docs/_exchange/one.md' }), /At most two/u)
})

test('review omits tracked deletions including missing parent directories from files and manifest', async t => {
  const { directory, root, put, git } = await fixture(t)
  await put('src/present.ts', 'still present\n')
  await put('src/deleted.ts', 'tracked but deleted\n')
  await put('removed-directory/deleted.ts', 'parent removed\n')
  await git('add', 'src', 'removed-directory')
  await git('-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', 'commit', '-qm', 'baseline before deletion')
  await unlink(join(root, 'src/deleted.ts'))
  await rename(join(root, 'removed-directory'), join(directory, 'removed-source'))
  const result = await createReviewWorkspace(root)
  assert.deepEqual(result.files, ['src/present.ts'])
  const manifest = JSON.parse(await readFile(result.manifestFile, 'utf8'))
  assert.deepEqual(manifest.files.map(file => file.path), ['src/present.ts'])
  await assert.rejects(lstat(join(result.cwd, 'src/deleted.ts')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(result.cwd, 'removed-directory')), { code: 'ENOENT' })
  assert.equal(await readFile(join(result.cwd, 'src/present.ts'), 'utf8'), 'still present\n')
  assert.match(await git('status', '--porcelain=v1'), / D src\/deleted\.ts/u)
})

test('review rejects a junction or symbolic directory in a tracked file path', async t => {
  const { directory, root, put, git } = await fixture(t)
  await put('source/current.ts', 'original tracked source\n')
  await git('add', 'source/current.ts')
  await rename(join(root, 'source'), join(directory, 'saved-source'))
  await mkdir(join(directory, 'outside'))
  await writeFile(join(directory, 'outside/current.ts'), 'do not read outside\n')
  await symlink(join(directory, 'outside'), join(root, 'source'), 'junction')
  await assert.rejects(createReviewWorkspace(root), /symbolic links or junctions/u)
  assert.equal(await readFile(join(directory, 'outside/current.ts'), 'utf8'), 'do not read outside\n')
})

test('review rejects file symlinks and linked output directories', async t => {
  const { directory, root, put, git } = await fixture(t)
  await put('source.ts', 'original\n')
  await git('add', 'source.ts')
  await rename(join(root, 'source.ts'), join(directory, 'outside.ts'))
  let fileLinkSupported = true
  try { await symlink(join(directory, 'outside.ts'), join(root, 'source.ts'), 'file') }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    fileLinkSupported = false
    t.diagnostic('File symlink creation requires privileges on this host; directory junction coverage remains active')
    await rename(join(directory, 'outside.ts'), join(root, 'source.ts'))
  }
  if (fileLinkSupported) await assert.rejects(createReviewWorkspace(root), /regular file/u)
  await mkdir(join(directory, 'outside-output'))
  await symlink(join(directory, 'outside-output'), join(directory, 'linked-output'), 'junction')
  await assert.rejects(createReviewWorkspace(root, { baseDirectory: join(directory, 'linked-output') }), /symbolic links or junctions/u)
  assert.deepEqual(await readdir(join(directory, 'outside-output')), [])
})

test('review requires Git metadata and creates unique independent snapshots', async t => {
  const { directory, root, put, git } = await fixture(t, false)
  await assert.rejects(createReviewWorkspace(root), /require a Git repository/u)
  await git('init', '-q')
  await put('source.ts', 'current source\n')
  const baseDirectory = join(directory, 'reviews')
  const [first, second] = await Promise.all([
    createReviewWorkspace(root, { baseDirectory, id: 'same-id' }),
    createReviewWorkspace(root, { baseDirectory, id: 'same-id' }),
  ])
  assert.notEqual(first.cwd, second.cwd)
  assert.equal(await readFile(join(first.cwd, 'source.ts'), 'utf8'), 'current source\n')
  assert.equal(await readFile(join(second.cwd, 'source.ts'), 'utf8'), 'current source\n')
})
