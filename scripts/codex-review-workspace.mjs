import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const blockedDirectories = new Set(['.git', 'node_modules', 'artifacts', 'dist', 'credentials', '.credentials'])
const manifestName = '.codex-review-manifest.json'

function relativePath(value) {
  if (typeof value !== 'string' || !value || /[\\:\u0000-\u001f]/u.test(value) || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error('Review source paths must be safe repository-relative paths')
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part))) {
    throw new Error('Review source paths must not contain traversal or ambiguous segments')
  }
  return parts
}

function excluded(parts) {
  return parts.some(part => blockedDirectories.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))
    || /\.(?:sqlite3?|db3?)(?:[-.].*)?$/iu.test(parts.at(-1))
    || /^(?:\.?credentials?)(?:\.(?:json|ya?ml|ini|conf|toml|txt)|$)/iu.test(parts.at(-1))
    || /^(?:auth\.json|\.netrc|id_rsa|id_ed25519)$/iu.test(parts.at(-1))
    || /\.(?:pem|key|p12|pfx)$/iu.test(parts.at(-1))
}

async function requireDirectory(path) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Review paths must not contain symbolic links or junctions')
}

async function ensureDirectory(path) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  await requireDirectory(current)
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await requireDirectory(current)
  }
}

async function git(root, args) {
  const { stdout } = await executeFile('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  })
  return stdout
}

/** Copy current source files into a disposable workspace; no Git state or runtime data is copied. */
export async function createReviewWorkspace(sourceRoot, { baseDirectory, id, extraPaths = [] } = {}) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('A repository sourceRoot is required')
  const root = await realpath(resolve(sourceRoot))
  await requireDirectory(root)
  let gitRoot
  try { gitRoot = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim()) }
  catch { throw new Error('Review snapshots require a Git repository at sourceRoot') }
  if (gitRoot !== root) throw new Error('Review sourceRoot must be the Git repository root')
  if (id !== undefined && (typeof id !== 'string' || !/^[a-z\d][a-z\d._-]{0,63}$/iu.test(id))) {
    throw new Error('Review id must be a safe name of at most 64 characters')
  }
  if (!Array.isArray(extraPaths) || extraPaths.length > 2) throw new Error('At most two explicit exchange Markdown files may be added')
  for (const path of extraPaths) {
    const parts = relativePath(path)
    if (parts.length < 3 || parts[0] !== 'docs' || parts[1] !== '_exchange' || !/\.md$/iu.test(parts.at(-1)) || excluded(parts)) {
      throw new Error('Extra review paths must name individual Markdown files within docs/_exchange/')
    }
  }

  const listed = (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  const files = [...new Set([...listed, ...extraPaths])].filter(path => !excluded(relativePath(path))).sort()
  if (files.includes(manifestName)) throw new Error('Review manifest filename is reserved')
  let gitHead = null
  try { gitHead = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim() }
  catch { /* A freshly initialized repository may not have a commit yet. */ }

  const base = baseDirectory === undefined ? join(root, 'artifacts', 'codex-reviews') : resolve(root, baseDirectory)
  await ensureDirectory(base)
  const cwd = join(base, `${id ?? 'review'}-${randomUUID()}`)
  await mkdir(cwd, { mode: 0o700 })
  const manifestFile = join(cwd, manifestName)
  const directoryChecks = new Map()
  const fileDetails = new Array(files.length)
  let next = 0
  async function copyNext() {
    while (next < files.length) {
      const index = next++
      const path = files[index], parts = relativePath(path)
      let stat, content
      try {
        let source = root
        for (const part of parts.slice(0, -1)) {
          source = join(source, part)
          if (!directoryChecks.has(source)) directoryChecks.set(source, requireDirectory(source))
          await directoryChecks.get(source)
        }
        source = join(source, parts.at(-1))
        stat = await lstat(source)
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Review source must be a regular file: ${path}`)
        const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          if (!(await handle.stat()).isFile()) throw new Error(`Review source must be a regular file: ${path}`)
          content = await handle.readFile()
        } finally { await handle.close() }
      } catch (error) {
        // Git also lists tracked deletions. Their absence is part of the working
        // tree snapshot; explicitly requested exchange documents remain required.
        if (error.code === 'ENOENT' && !extraPaths.includes(path)) continue
        throw error
      }
      const target = join(cwd, ...parts)
      await ensureDirectory(join(cwd, ...parts.slice(0, -1)))
      await writeFile(target, content, { flag: 'wx', mode: stat.mode & 0o777 })
      fileDetails[index] = { path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length }
    }
  }
  // Wait for all workers even on error, so a rejected snapshot has no background writes left running.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(8, files.length) }, copyNext))
  const failed = workers.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  const copiedFiles = fileDetails.filter(Boolean)
  const manifest = { version: 1, sourceRoot: root, createdAt: new Date().toISOString(), gitHead, files: copiedFiles }
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { cwd, sourceRoot: root, manifestFile, files: copiedFiles.map(file => file.path) }
}
