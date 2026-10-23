#!/usr/bin/env node
/**
 * scripts/package.mjs — 打可安装包（规格 §23 `package`）。
 *
 * 产物：
 *   dist/dsh-companion-memory-<version>/       可直接 link 或复制进 profile 的目录
 *   dist/dsh-companion-memory-<version>.json   清单：逐文件 sha256、字节数、构建时间
 *
 * 只做本地打包，不联网、不发布。默认先跑一次 build，保证 lib/ 与 src/ 一致。
 *
 * 用法：node scripts/package.mjs [--skip-build]
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skipBuild = process.argv.includes('--skip-build')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const stage = join(root, 'dist', `${pkg.name}-${pkg.version}`)

function runBuild() {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}\n`)
    throw new Error(`build 失败，退出码 ${result.status}`)
  }
  process.stdout.write((result.stdout ?? '').trim() + '\n')
}

function copy(entry) {
  const from = join(root, entry)
  const to = join(stage, entry)
  if (!existsSync(from)) throw new Error(`缺少必须打包的文件/目录：${entry}`)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main() {
  if (!skipBuild) runBuild()

  if (!stage.startsWith(resolve(root, 'dist') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe staging directory')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // src 是运行入口（package.json main 指向 src/index.js），lib 是编译产物；
  // prompts/migrations 是运行时资源，缺一不可。
  const entries = ['src', 'lib', 'prompts', 'migrations', 'integration', 'scripts', 'docs', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']
  for (const entry of entries) copy(entry)

  const files = walk(stage).map((full) => ({
    path: relative(stage, full).split('\\').join('/'),
    bytes: statSync(full).size,
    sha256: sha256(full)
  }))

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    node: process.versions.node,
    platform: process.platform,
    entry: pkg.main,
    bundlePatch: pkg.dsh?.bundle?.patch ?? null,
    files
  }
  const manifestPath = join(root, 'dist', `${pkg.name}-${pkg.version}.json`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  process.stdout.write(`打包完成：${files.length} 个文件 · ${(totalBytes / 1024).toFixed(1)} KiB\n`)
  process.stdout.write(`目录：${stage}\n`)
  process.stdout.write(`清单：${manifestPath}\n`)
  process.stdout.write(`安装：把 dist/${pkg.name}-${pkg.version} 复制到 profile 的 node_modules/${pkg.name}，或在 profile package.json 写 "link:${stage}"\n`)
}

main()
