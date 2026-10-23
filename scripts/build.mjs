#!/usr/bin/env node
/**
 * 构建脚本（任务书 §23 脚本契约）。
 *
 * 本机没有全局 TypeScript、也没有可用的包管理器联网安装，因此把 TypeScript
 * 编译器（5.9.3）连同 @types/node 一起 vendored 在 `_vendor/` 下，由本脚本
 * 直接调用 tsc 的编译 API。`_vendor/` 不进发布包（package.json 的 files 不含它）。
 *
 * 用法：
 *   node scripts/build.mjs              编译 src 下全部 .ts -> lib/
 *   node scripts/build.mjs --check-only 只做类型检查，不写文件
 *   node scripts/build.mjs --clean      先清空 lib/ 再编译
 *
 * 跨平台：只用 node:path / node:fs，不依赖 bash 或 PowerShell。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const tsc = join(root, '_vendor', 'typescript', 'lib', 'tsc.js')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check-only')
const clean = args.includes('--clean')

if (!existsSync(tsc)) {
  console.error(`[build] 找不到 vendored TypeScript：${tsc}`)
  console.error('[build] 请把 typescript 解包到 _vendor/typescript（见 docs/ENVIRONMENT.md）。')
  process.exit(2)
}

if (clean && !checkOnly) {
  const lib = join(root, 'lib')
  if (existsSync(lib)) {
    rmSync(lib, { recursive: true, force: true })
    console.log('[build] 已清空 lib/')
  }
}

const tscArgs = [tsc, '-p', join(root, 'tsconfig.json')]
if (checkOnly) tscArgs.push('--noEmit')

const result = spawnSync(process.execPath, tscArgs, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

if (result.error !== undefined) {
  console.error(`[build] 无法启动 tsc：${result.error.message}`)
  process.exit(2)
}
if (result.status !== 0) {
  console.error(`[build] 编译失败（exit ${result.status}）`)
  process.exit(result.status ?? 1)
}

if (checkOnly) {
  console.log('[build] 类型检查通过（未写出文件）')
} else {
  const count = countFiles(join(root, 'lib'))
  console.log(`[build] 编译完成：lib/ 下 ${count} 个文件`)
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) total += countFiles(full)
    else total += 1
  }
  return total
}
