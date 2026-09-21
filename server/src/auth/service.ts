/**
 * 认证服务（M57 多用户 P1）：账号 / 登录 / 会话令牌 / API Key / 密码策略与锁定。
 *
 * 关键语义：
 * - 单用户兼容模式：`users` 表为空时系统与旧版行为一致（无需登录；AUTH_TOKEN 仍生效）；
 *   `setup()` 创建首个管理员后进入多用户模式，并一次性回填存量数据归属；
 * - 会话令牌 = 不透明随机串（`sa_` 前缀），库中只存 SHA-256 哈希；滑动过期 + 绝对过期 + 可撤销；
 * - 登录防爆破：失败计数 + 锁定（阈值 / 时长可配）；未知用户名执行哑哈希（防时序枚举）；
 * - legacy AUTH_TOKEN：映射到最早创建的管理员（无用户时为合成管理员上下文），带弃用告警。
 */
import crypto from 'node:crypto'
import type { ApiKeyInfo, AuthStatus, UserAvatar, UserInfo, UserRole } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import type { ApiKeyStore, AuthSessionStore } from '../store/auth-sessions.js'
import type { AuditStore } from '../store/audit.js'
import type { SessionStore } from '../store/sessions.js'
import type { UserRecord, UserStore } from '../store/users.js'
import { toUserInfo } from '../store/users.js'
import { isImageAvatar, removeAvatarFile } from './avatar.js'
import { HttpError } from '../util/http-error.js'
import { generateInitialPassword, hashPassword, passwordPolicyError, verifyPassword } from './passwords.js'

/** 请求上下文中的用户（挂到 req.user）；legacy = 尚无账号的单用户兼容模式 */
export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  /** 管理员下发初始密码后为 true：客户端强制进入改密页 */
  mustChangePassword?: boolean
  legacy?: boolean
  /** M79-B：画像（头衔 / 简介 / 头像；缺省 = 未设置） */
  headline?: string
  bio?: string
  avatar?: UserAvatar
}

export interface LoginResult {
  user: AuthUser
  rawToken: string
  mustChangePassword: boolean
}

/** 哑哈希（未知用户名时执行，抵抗用户名的时序枚举） */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`
}

function toAuthUser(record: UserRecord): AuthUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    // M79-B：画像随登录态投影（/auth/me / 登录响应携带；缺省 = 未设置）
    ...(record.headline ? { headline: record.headline } : {}),
    ...(record.bio ? { bio: record.bio } : {}),
    ...(record.avatar ? { avatar: record.avatar } : {}),
    role: record.role,
    mustChangePassword: record.mustChangePassword ? true : undefined,
  }
}

export interface AuthServiceDeps {
  cfg: AppConfig
  users: UserStore
  authSessions: AuthSessionStore
  apiKeys: ApiKeyStore
  audit?: AuditStore
  /** M57：会话存储（setup 回填时先落盘 + 回填后清缓存，保证归属回填对内存缓存生效） */
  sessions?: SessionStore
}

export class AuthService {
  private userCountCache: number | undefined

  constructor(private readonly deps: AuthServiceDeps) {}

  get multiUser(): boolean {
    if (this.userCountCache === undefined) this.userCountCache = this.deps.users.count()
    return this.userCountCache > 0
  }

  private invalidate(): void {
    this.userCountCache = undefined
  }

  status(): AuthStatus {
    const multiUser = this.multiUser
    return {
      needsSetup: !multiUser,
      authRequired: multiUser || Boolean(this.deps.cfg.authToken),
      multiUser,
    }
  }

  // ---------- 首启与登录 ----------

  /** 首启创建管理员（仅无用户时可用）；成功后自动签发登录会话并回填存量归属 */
  async setup(input: {
    username: string
    password: string
    displayName?: string
    ip?: string
    userAgent?: string
  }): Promise<LoginResult> {
    if (this.multiUser) throw new HttpError(400, '系统已完成初始化（管理员已存在），请直接登录')
    const username = input.username.trim()
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      throw new HttpError(400, '用户名需为 3–32 位字母 / 数字 / _. -')
    }
    const policy = passwordPolicyError(input.password)
    if (policy) throw new HttpError(400, policy)
    const passwordHash = await hashPassword(input.password)
    const user = this.deps.users.create({
      username,
      displayName: input.displayName?.trim() || username,
      passwordHash,
      role: 'admin',
    })
    this.invalidate()
    // 单用户时期的历史数据（owner_id NULL）归引导管理员（先落盘，再回填，最后清缓存——防陈旧缓存覆盖回填）
    try {
      this.deps.sessions?.flushAll()
      this.deps.users.backfillLegacyOwnership(user.id)
      this.deps.sessions?.invalidateCache()
    } catch (err) {
      this.deps.audit?.record({
        actor: 'system',
        action: 'auth.setup',
        ok: false,
        error: `存量数据回填失败：${(err as Error).message}`,
      })
    }
    this.deps.audit?.record({
      actor: 'user',
      userId: user.id,
      action: 'auth.setup',
      resourceType: 'user',
      resourceId: user.id,
      ip: input.ip,
    })
    const login = this.issueSession(user, input)
    return { ...login, mustChangePassword: false }
  }

  /** 登录：锁定 / 禁用 / 密码错误统一处理；成功后签发会话（首登强制改密透传） */
  async login(input: { username: string; password: string; ip?: string; userAgent?: string }): Promise<LoginResult> {
    const user = this.deps.users.getByUsername(input.username)
    if (!user) {
      // 哑哈希：未知用户名与密码错误耗时一致（防枚举）
      await verifyPassword(input.password, DUMMY_HASH)
      this.deps.audit?.record({ actor: 'user', action: 'auth.login', ok: false, ip: input.ip, error: '用户名不存在' })
      throw new HttpError(401, '用户名或密码错误')
    }
    if (user.status !== 'active') {
      this.deps.audit?.record({
        actor: 'user',
        userId: user.id,
        action: 'auth.login',
        ok: false,
        ip: input.ip,
        error: '账号已禁用',
      })
      throw new HttpError(403, '账号已被禁用，请联系管理员')
    }
    if (user.lockedUntil && user.lockedUntil > new Date().toISOString()) {
      const minutes = Math.max(1, Math.ceil((Date.parse(user.lockedUntil) - Date.now()) / 60_000))
      throw new HttpError(429, `尝试次数过多：账号已锁定，请约 ${minutes} 分钟后再试`)
    }
    const ok = await verifyPassword(input.password, user.passwordHash)
    if (!ok) {
      const { lockedUntil } = this.deps.users.recordLoginFailure(
        user.id,
        this.deps.cfg.loginLockoutThreshold,
        this.deps.cfg.loginLockoutMs,
      )
      this.deps.audit?.record({
        actor: 'user',
        userId: user.id,
        action: 'auth.login',
        ok: false,
        ip: input.ip,
        error: lockedUntil ? '密码错误（已达阈值，账号锁定）' : '密码错误',
      })
      if (lockedUntil) {
        throw new HttpError(429, `尝试次数过多：账号已锁定，请约 ${Math.ceil(this.deps.cfg.loginLockoutMs / 60_000)} 分钟后再试`)
      }
      throw new HttpError(401, '用户名或密码错误')
    }
    this.deps.users.recordLoginSuccess(user.id, input.ip ?? '')
    this.deps.audit?.record({
      actor: 'user',
      userId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      ip: input.ip,
    })
    const login = this.issueSession(user, input)
    return { ...login, mustChangePassword: Boolean(user.mustChangePassword) }
  }

  private issueSession(
    user: UserRecord,
    meta: { ip?: string; userAgent?: string },
  ): LoginResult {
    const rawToken = randomToken('sa_')
    const ttlMs = this.deps.cfg.sessionTtlDays * 24 * 3600_000
    const absMs = this.deps.cfg.sessionAbsoluteTtlDays * 24 * 3600_000
    this.deps.authSessions.create({
      userId: user.id,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + absMs).toISOString(),
      userAgent: meta.userAgent,
      ip: meta.ip,
    })
    // 顺手清理过期会话行（轻量、低频）
    if (Math.random() < 0.05) {
      try {
        this.deps.authSessions.prune()
      } catch {
        // 清理失败无妨
      }
    }
    return { user: toAuthUser(user), rawToken, mustChangePassword: Boolean(user.mustChangePassword) }
  }

  // ---------- 令牌校验（HTTP / WS 共用） ----------

  /** 校验登录会话令牌（滑动续期节流 5 分钟） */
  verifySessionToken(rawToken: string): AuthUser | undefined {
    if (!rawToken) return undefined
    const record = this.deps.authSessions.findValidByHash(sha256Hex(rawToken))
    if (!record) return undefined
    const user = this.deps.users.get(record.userId)
    if (!user || user.status !== 'active') return undefined
    const now = Date.now()
    if (now - Date.parse(record.lastSeenAt) > 5 * 60_000) {
      const ttlMs = this.deps.cfg.sessionTtlDays * 24 * 3600_000
      const next = Math.min(now + ttlMs, Date.parse(record.absoluteExpiresAt))
      this.deps.authSessions.touch(record.id, new Date(next).toISOString())
    }
    return toAuthUser(user)
  }

  /** 校验 API Key（Bearer 通道；命中后更新 last_used_at） */
  verifyApiKey(rawKey: string): AuthUser | undefined {
    if (!rawKey) return undefined
    const record = this.deps.apiKeys.findValidByHash(sha256Hex(rawKey))
    if (!record) return undefined
    const user = this.deps.users.get(record.userId)
    if (!user || user.status !== 'active') return undefined
    this.deps.apiKeys.touchUsed(record.id)
    return toAuthUser(user)
  }

  /**
   * legacy AUTH_TOKEN 校验（兼容期）：
   * - 有账号：映射到最早创建的管理员（共享令牌无法归因，日志持续提示弃用）；
   * - 无账号：合成管理员上下文（legacy 标记：无归属隔离，行为与旧版一致）。
   */
  verifyLegacyToken(token: string): AuthUser | undefined {
    const expected = this.deps.cfg.authToken
    if (!expected || !token) return undefined
    const a = Buffer.from(token)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined
    if (this.multiUser) {
      const admin = this.deps.users.firstAdmin()
      return admin ? toAuthUser(admin) : undefined
    }
    return { id: '', username: 'legacy', displayName: '本地管理员（AUTH_TOKEN）', role: 'admin', legacy: true }
  }

  /** 登出：撤销当前令牌（幂等） */
  logout(rawToken: string): void {
    if (!rawToken) return
    const record = this.deps.authSessions.findValidByHash(sha256Hex(rawToken))
    if (record) this.deps.authSessions.revoke(record.id)
  }

  // ---------- 密码 ----------

  /** 自助改密：校验原密码 → 写入 → 吊销其它会话（当前会话保留） */
  async changePassword(input: {
    userId: string
    currentPassword: string
    newPassword: string
    keepSessionToken?: string
  }): Promise<void> {
    const user = this.deps.users.get(input.userId)
    if (!user) throw new HttpError(404, '账号不存在')
    const ok = await verifyPassword(input.currentPassword, user.passwordHash)
    if (!ok) throw new HttpError(400, '当前密码不正确')
    const policy = passwordPolicyError(input.newPassword)
    if (policy) throw new HttpError(400, policy)
    if (input.currentPassword === input.newPassword) throw new HttpError(400, '新密码不能与原密码相同')
    this.deps.users.setPassword(user.id, await hashPassword(input.newPassword), { mustChange: false })
    // 吊销其它会话（含所有 API Key 之外的手持令牌）
    let keepId: string | undefined
    if (input.keepSessionToken) keepId = this.deps.authSessions.findValidByHash(sha256Hex(input.keepSessionToken))?.id
    this.deps.authSessions.revokeAllForUser(user.id, keepId)
    this.deps.audit?.record({
      actor: 'user',
      userId: user.id,
      action: 'auth.password-change',
      resourceType: 'user',
      resourceId: user.id,
    })
  }

  /** 管理员重置密码：生成初始密码 + 强制首登改密 + 吊销全部会话 */
  async resetPassword(userId: string, actor?: { userId?: string; ip?: string }): Promise<{ user: UserInfo; initialPassword: string }> {
    const user = this.deps.users.get(userId)
    if (!user) throw new HttpError(404, '账号不存在')
    const initialPassword = generateInitialPassword()
    this.deps.users.setPassword(user.id, await hashPassword(initialPassword), { mustChange: true })
    this.deps.authSessions.revokeAllForUser(user.id)
    this.deps.audit?.record({
      actor: 'user',
      userId: actor?.userId,
      ip: actor?.ip,
      action: 'auth.user-password-reset',
      resourceType: 'user',
      resourceId: userId,
    })
    const fresh = this.deps.users.get(userId)!
    return { user: toUserInfo(fresh), initialPassword }
  }

  // ---------- 账号管理（admin） ----------

  /** 账号清单（admin 视图；绝不含密文与凭据字段） */
  listUsers(): UserInfo[] {
    return this.deps.users.list()
  }

  /** API Key 清单（admin 或本人；仅元数据） */
  listApiKeys(userId: string): ApiKeyInfo[] {
    return this.deps.apiKeys.listForUser(userId)
  }

  /** 读取账号（不存在返回 undefined） */
  getUser(userId: string): UserInfo | undefined {
    const record = this.deps.users.get(userId)
    return record ? toUserInfo(record) : undefined
  }

  /** 按用户名查找（M57 P2 共享邀请用；不区分大小写；不存在返回 undefined） */
  getUserByUsername(username: string): UserInfo | undefined {
    const record = this.deps.users.getByUsername(username)
    return record ? toUserInfo(record) : undefined
  }

  /** 创建账号（邀请制）：未提供初始密码则生成并仅在本次响应返回一次 */
  async createUser(
    input: {
      username: string
      displayName?: string
      role?: UserRole
      password?: string
    },
    actor?: { userId?: string; ip?: string },
  ): Promise<{ user: UserInfo; initialPassword?: string }> {
    const username = input.username.trim()
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      throw new HttpError(400, '用户名需为 3–32 位字母 / 数字 / _. -')
    }
    if (this.deps.users.getByUsername(username)) throw new HttpError(409, `用户名已存在：${username}`)
    let initialPassword = input.password
    if (initialPassword !== undefined) {
      const policy = passwordPolicyError(initialPassword)
      if (policy) throw new HttpError(400, policy)
    } else {
      initialPassword = generateInitialPassword()
    }
    const user = this.deps.users.create({
      username,
      displayName: input.displayName?.trim() || username,
      passwordHash: await hashPassword(initialPassword),
      role: input.role ?? 'member',
      mustChangePassword: true,
    })
    this.invalidate()
    this.deps.audit?.record({
      actor: 'user',
      userId: actor?.userId,
      ip: actor?.ip,
      action: 'auth.user-create',
      resourceType: 'user',
      resourceId: user.id,
      detail: { username: user.username, role: user.role },
    })
    return { user: toUserInfo(user), initialPassword: input.password === undefined ? initialPassword : undefined }
  }

  /** 更新账号（显示名 / 角色 / 状态）；内置护栏：不能移除最后一个管理员 */
  updateUser(
    targetId: string,
    patch: { displayName?: string; role?: UserRole; status?: 'active' | 'disabled' },
    actor?: { userId?: string; ip?: string },
  ): UserInfo {
    const target = this.deps.users.get(targetId)
    if (!target) throw new HttpError(404, '账号不存在')
    const losingAdmin = target.role === 'admin' && (patch.role === 'member' || patch.status === 'disabled')
    if (losingAdmin && this.deps.users.countAdmins() <= 1) {
      throw new HttpError(400, '系统至少保留一名启用中的管理员')
    }
    const updated = this.deps.users.update(targetId, patch)
    if (patch.status === 'disabled') {
      this.deps.authSessions.revokeAllForUser(targetId)
    }
    this.deps.audit?.record({
      actor: 'user',
      userId: actor?.userId,
      ip: actor?.ip,
      action: patch.status === 'disabled' ? 'auth.user-disable' : 'auth.user-update',
      resourceType: 'user',
      resourceId: targetId,
      detail: patch as Record<string, unknown>,
    })
    return toUserInfo(updated ?? target)
  }

  /** 删除账号（级联清理其会话 / 记忆等由外键与调用方负责）；不能删除最后一个管理员 */
  deleteUser(targetId: string, actor?: { userId?: string; ip?: string }): void {
    const target = this.deps.users.get(targetId)
    if (!target) throw new HttpError(404, '账号不存在')
    if (target.role === 'admin' && this.deps.users.countAdmins() <= 1) {
      throw new HttpError(400, '系统至少保留一名管理员（不能删除最后一个管理员）')
    }
    // M79-Q：级联清理图片头像文件（users 行删除后文件名信息不可再取，先留存）
    const avatarFileName = isImageAvatar(target.avatar) ? target.avatar.value : undefined
    this.deps.users.remove(targetId)
    if (avatarFileName) removeAvatarFile(this.deps.cfg.dataDir, avatarFileName)
    this.invalidate()
    this.deps.audit?.record({
      actor: 'user',
      userId: actor?.userId,
      ip: actor?.ip,
      action: 'auth.user-delete',
      resourceType: 'user',
      resourceId: targetId,
      detail: { username: target.username },
    })
  }

  // ---------- API Key ----------

  createApiKey(
    userId: string,
    name: string,
    expiresAt?: string,
    actor?: { userId?: string; ip?: string },
  ): { key: ApiKeyInfo; raw: string } {
    const user = this.deps.users.get(userId)
    if (!user) throw new HttpError(404, '账号不存在')
    const raw = randomToken('mk_')
    const record = this.deps.apiKeys.create({
      userId,
      name: name.trim() || 'API Key',
      tokenHash: sha256Hex(raw),
      expiresAt,
    })
    this.deps.audit?.record({
      actor: 'user',
      userId: actor?.userId ?? userId,
      ip: actor?.ip,
      action: 'auth.apikey-create',
      resourceType: 'api_key',
      resourceId: record.id,
      detail: { owner: userId, name: record.name },
    })
    const { userId: _u, tokenHash: _t, ...key } = record
    return { key, raw }
  }

  revokeApiKey(userId: string, keyId: string, actor?: { userId?: string; ip?: string }): void {
    const key = this.deps.apiKeys.get(keyId)
    if (!key || key.userId !== userId) throw new HttpError(404, 'API Key 不存在')
    this.deps.apiKeys.revoke(keyId)
    this.deps.audit?.record({
      actor: 'user',
      userId: actor?.userId ?? userId,
      ip: actor?.ip,
      action: 'auth.apikey-revoke',
      resourceType: 'api_key',
      resourceId: keyId,
      detail: { owner: userId },
    })
  }
}
