/**
 * M57 P3：用户 LLM 凭据存储（BYOK；迁移 v18 `user_llm_credentials`）。
 *
 * 语义：
 * - 每用户至多一份凭据（apiKey 必填；baseUrl / model 可空 = 用系统默认）；
 * - apiKey 经 SecretVault 加密落库（与连接 / MCP 凭据同源密钥；丢失/更换密钥后不可解密 → 视为未配置）；
 * - status() 投影绝不含密钥（供前端展示）；删除账号随 users FK 级联。
 */
import type { LlmCredentialStatus } from '@multi-agent/shared'
import type { SecretVault } from '../connections/crypto.js'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface LlmCredentials {
  apiKey: string
  baseUrl?: string
  model?: string
  updatedAt: string
}

export interface LlmCredentialsPatch {
  apiKey: string
  baseUrl?: string
  model?: string
}

interface CredRow {
  user_id: string
  base_url: string | null
  model: string | null
  secret_enc: string
  updated_at: string
}

export class LlmCredentialStore {
  constructor(
    private readonly db: AppDb,
    private readonly vault: SecretVault,
  ) {}

  /** 读取并解密（未配置 / 解密失败 → undefined） */
  get(userId: string): LlmCredentials | undefined {
    const row = this.db.get<CredRow>('SELECT * FROM user_llm_credentials WHERE user_id = ?', userId)
    if (!row) return undefined
    const secret = this.vault.decrypt(row.secret_enc) as Record<string, unknown> | undefined
    const apiKey = secret && typeof secret.apiKey === 'string' ? secret.apiKey : undefined
    if (!apiKey) return undefined
    return {
      apiKey,
      baseUrl: row.base_url ?? undefined,
      model: row.model ?? undefined,
      updatedAt: row.updated_at,
    }
  }

  /** 状态投影（前端展示；绝不含密钥） */
  status(userId: string): LlmCredentialStatus {
    const row = this.db.get<CredRow>('SELECT * FROM user_llm_credentials WHERE user_id = ?', userId)
    if (!row) return { configured: false }
    // 解密失败（密钥更换）仍报已配置但不可用 → 归一为未配置，避免误以为生效
    if (!this.get(userId)) return { configured: false }
    return {
      configured: true,
      baseUrl: row.base_url ?? undefined,
      model: row.model ?? undefined,
      updatedAt: row.updated_at,
    }
  }

  /** 写入 / 覆盖（upsert；apiKey 必填） */
  upsert(userId: string, patch: LlmCredentialsPatch): LlmCredentialStatus {
    const ts = nowIso()
    this.db.run(
      `INSERT INTO user_llm_credentials (user_id, base_url, model, secret_enc, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         base_url = excluded.base_url,
         model = excluded.model,
         secret_enc = excluded.secret_enc,
         updated_at = excluded.updated_at`,
      userId,
      patch.baseUrl?.trim() || null,
      patch.model?.trim() || null,
      this.vault.encrypt({ apiKey: patch.apiKey }),
      ts,
    )
    return this.status(userId)
  }

  /** 清除（恢复系统默认）；返回是否确有删除 */
  clear(userId: string): boolean {
    const result = this.db.run('DELETE FROM user_llm_credentials WHERE user_id = ?', userId)
    return result.changes > 0
  }
}
