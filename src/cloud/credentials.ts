import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BaiduCredentials } from './baidu-client.js'

/** This file stays outside transfer snapshots and is never returned through status. */
export class CredentialStore {
  constructor(readonly file: string) {}

  read(): BaiduCredentials | null {
    if (!existsSync(this.file)) return null
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as BaiduCredentials
      if (!value.appKey?.trim() || !value.secretKey?.trim() || !value.appFolder?.trim()) throw new Error('invalid')
      if (/[\/\\\x00-\x1f]/.test(value.appFolder) || ['.', '..'].includes(value.appFolder)) throw new Error('invalid')
      return value
    } catch { throw new Error('百度网盘本地授权配置无效，请在记忆管理页重新连接。') }
  }

  write(value: BaiduCredentials): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }

  disconnect(): void { if (existsSync(this.file)) unlinkSync(this.file) }
}
