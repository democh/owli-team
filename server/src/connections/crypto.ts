/**
 * 连接凭据加密（M22 连接中心地基）：AES-256-GCM。
 *
 * 主密钥来源（优先级）：
 * 1. `CONNECTION_SECRET_KEY`（64 位 hex 或 32 字节 base64）；非法则告警并回退文件；
 * 2. 密钥文件 `data/secrets.key`（0600，自动生成一次，本地开箱即用）；
 * 3. 文件不可写（只读卷等）→ 进程内临时密钥（告警：重启后旧密文不可解，需重新保存凭据）。
 *
 * 密文包格式 `v1:<iv-b64>:<tag-b64>:<data-b64>`：自带版本号供未来密钥轮换；
 * 解密失败（换过密钥 / 数据损坏）返回 undefined，由调用方按「凭据不可用」降级处理，绝不抛错。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getLogger } from '../logger.js'

const KEY_BYTES = 32
const KEY_FILE_MODE = 0o600

export interface SecretVaultOptions {
  /** 环境变量材料（优先，非法时回退文件） */
  keyMaterial?: string
  /** 密钥文件路径（缺失则创建） */
  keyFile: string
}

export class SecretVault {
  private constructor(
    private readonly key: Buffer,
    readonly source: 'env' | 'file' | 'ephemeral',
  ) {}

  /** 解析密钥材料：64 位 hex 或 32 字节 base64，其它返回 undefined */
  static parseKeyMaterial(raw: string): Buffer | undefined {
    const value = raw.trim()
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex')
    if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
      const buf = Buffer.from(value, 'base64')
      if (buf.length === KEY_BYTES) return buf
    }
    return undefined
  }

  /** 加载（必要时创建）主密钥 —— 本函数不抛错，任何异常都降级 */
  static load(opts: SecretVaultOptions): SecretVault {
    const material = opts.keyMaterial?.trim()
    if (material) {
      const key = SecretVault.parseKeyMaterial(material)
      if (key) return new SecretVault(key, 'env')
      getLogger().warn('CONNECTION_SECRET_KEY 非法（需 64 位 hex 或 32 字节 base64），已回退密钥文件')
    }
    return SecretVault.loadOrCreateFile(opts.keyFile)
  }

  private static loadOrCreateFile(file: string): SecretVault {
    try {
      if (fs.existsSync(file)) {
        const key = SecretVault.parseKeyMaterial(fs.readFileSync(file, 'utf8'))
        if (key) return new SecretVault(key, 'file')
        getLogger().warn({ file }, '密钥文件内容非法，已重新生成（旧密文将无法解密，请重新保存连接凭据）')
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const hex = crypto.randomBytes(KEY_BYTES).toString('hex')
      fs.writeFileSync(file, `${hex}\n`, { mode: KEY_FILE_MODE })
      return new SecretVault(Buffer.from(hex, 'hex'), 'file')
    } catch (err) {
      getLogger().error(
        { err, file },
        '密钥文件不可用（只读卷？），本次运行使用临时密钥：重启后已保存的连接凭据不可解密，需重新保存',
      )
      return new SecretVault(crypto.randomBytes(KEY_BYTES), 'ephemeral')
    }
  }

  /** 加密任意 JSON 值 → `v1:<iv>:<tag>:<data>` */
  encrypt(value: unknown): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':')
  }

  /** 解密（失败返回 undefined，绝不抛错） */
  decrypt(payload: string): unknown {
    try {
      const parts = payload.split(':')
      if (parts.length !== 4 || parts[0] !== 'v1') return undefined
      const [, ivB64, tagB64, dataB64] = parts
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64!, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64!, 'base64'))
      const out = Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64')), decipher.final()])
      return JSON.parse(out.toString('utf8')) as unknown
    } catch {
      return undefined
    }
  }
}

/** 生成一份可写入 .env / 密钥文件的随机器（供 UI「生成密钥」/运维使用） */
export function generateKeyHex(): string {
  return crypto.randomBytes(KEY_BYTES).toString('hex')
}
