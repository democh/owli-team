/**
 * 流 token（M22）：watch / takeover 频道级授权凭证（服务端签发，HMAC-SHA256）。
 *
 * 设计：
 * - payload = base64url(JSON{topic, mode, exp, nonce})，签名 = HMAC(secret, payload)；
 * - watch token：TTL 内可复用（面板重连无需重复签发）；
 * - takeover token：一次性（验证通过即消费 nonce）——控制权转移不可重放；
 * - secret 为进程级随机（重启即失效，前端按 401 重新签发即可）。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { StreamTokenResponse } from '@multi-agent/shared'

interface TokenPayload {
  t: string
  m: 'watch' | 'takeover'
  exp: number
  n: string
  /** M57：绑定的用户 id（多用户：握手校验一致性；缺省 = 单用户兼容模式） */
  u?: string
}

export class StreamTokenService {
  private readonly secret = randomBytes(32)
  /** 已消费的 takeover nonce → 过期时间（定期清理） */
  private readonly consumed = new Map<string, number>()

  constructor(private readonly ttlMs: number) {}

  /** 签发（M57：userId 绑定发布方——握手时要求同一用户；单用户兼容模式缺省） */
  issue(topic: string, mode: 'watch' | 'takeover', userId?: string): StreamTokenResponse {
    const payload: TokenPayload = {
      t: topic,
      m: mode,
      exp: Date.now() + this.ttlMs,
      n: randomBytes(8).toString('hex'),
      ...(userId ? { u: userId } : {}),
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    return { token: `${encoded}.${sig}`, topic, mode, expiresIn: Math.floor(this.ttlMs / 1000) }
  }

  verify(
    token: string,
    topic: string,
    mode: 'watch' | 'takeover',
    userId?: string,
  ): { ok: true } | { ok: false; reason: string } {
    const [encoded, sig] = token.split('.')
    if (!encoded || !sig) return { ok: false, reason: 'token 格式非法' }
    const expected = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'token 签名校验失败' }
    let payload: TokenPayload
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as TokenPayload
    } catch {
      return { ok: false, reason: 'token 内容非法' }
    }
    if (payload.exp < Date.now()) return { ok: false, reason: 'token 已过期' }
    if (payload.t !== topic) return { ok: false, reason: 'token 与频道不匹配' }
    if (payload.m !== mode) return { ok: false, reason: 'token 权限级别不匹配' }
    // M57：多用户绑定校验（token 带用户且请求用户不一致 → 拒绝；兼容模式不强制）
    if (payload.u && payload.u !== userId) return { ok: false, reason: 'token 与当前用户不匹配' }
    if (mode === 'takeover') {
      this.pruneConsumed()
      if (this.consumed.has(payload.n)) return { ok: false, reason: 'takeover token 已被使用（一次性）' }
      this.consumed.set(payload.n, payload.exp)
    }
    return { ok: true }
  }

  private pruneConsumed(): void {
    const now = Date.now()
    for (const [nonce, exp] of this.consumed) {
      if (exp < now) this.consumed.delete(nonce)
    }
  }
}
