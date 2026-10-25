/**
 * 访问控制服务（M57 多用户 P1；P2 扩展共享角色）：归属判定的唯一事实源。
 *
 * 语义：
 * - 单用户兼容模式（尚无账号）：全部放行（行为与旧版一致）；
 * - 多用户模式：读取 = owner ∪ 共享成员（跨用户一律 404，不泄漏存在性）；
 *   写入 = owner / editor（viewer 只读，可自助退出 /leave）；
 * - 孤儿行（owner 为 NULL：migration 与 setup 之间的历史数据）仅管理员可见（兜底阀门）。
 * - 下线资产（直接删除）只保留历史兼容：执行入口额外拒绝含下线成员的会话，读取不受影响。
 */
import { RETIRED_SESSION_HINT, retiredScenesOf } from '@multi-agent/shared'
import type { ProjectDefinition, Session, SessionAccessRole } from '@multi-agent/shared'
import type { ProjectStore } from '../store/projects.js'
import type { SessionMemberStore } from '../store/session-members.js'
import type { SessionStore } from '../store/sessions.js'
import { HttpError } from '../util/http-error.js'
import type { AuthUser } from './service.js'

export interface AccessServiceDeps {
  /** 是否已进入多用户模式（AuthService.multiUser 的惰性读取） */
  isMultiUser: () => boolean
  sessions: SessionStore
  projects: ProjectStore
  /** M57 P2：会话共享成员（owner 之外的用户角色） */
  members: SessionMemberStore
}

export class AccessService {
  constructor(private readonly deps: AccessServiceDeps) {}

  get multiUser(): boolean {
    return this.deps.isMultiUser()
  }

  /** 会话读取判定（列表过滤 / WS 订阅 / 守卫共用；含共享成员） */
  canAccessSession(user: AuthUser | undefined, sessionId: string): boolean {
    if (!this.multiUser) return true
    if (!user) return false
    return this.sessionRole(user, sessionId) !== undefined
  }

  /** 会话写操作判定（M57 P2：owner / editor；viewer 只读） */
  canWriteSession(user: AuthUser | undefined, sessionId: string): boolean {
    if (!this.multiUser) return true
    if (!user) return false
    const role = this.sessionRole(user, sessionId)
    return role === 'owner' || role === 'editor'
  }

  /** 当前用户相对会话的角色（owner / editor / viewer；undefined = 无访问权） */
  sessionRole(user: AuthUser | undefined, sessionId: string): SessionAccessRole | undefined {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) return undefined
    if (!this.multiUser) return 'owner'
    if (!user) return undefined
    if (this.ownsOrAdmin(user, session.ownerId)) return 'owner'
    return this.deps.members.get(sessionId, user.id)?.role
  }

  /** 会话守卫：不存在 / 无权限 → 404（消息文案与既有接口一致） */
  assertSession(user: AuthUser | undefined, sessionId: string): Session {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) throw new HttpError(404, '会话不存在')
    if (!this.multiUser) return session
    if (!user || this.sessionRole(user, sessionId) === undefined) throw new HttpError(404, '会话不存在')
    return session
  }

  /** 会话写守卫：无读权 → 404；viewer → 403（M57 P2） */
  assertSessionWrite(user: AuthUser | undefined, sessionId: string): Session {
    const session = this.assertSession(user, sessionId)
    if (!this.multiUser) return session
    if (!this.canWriteSession(user, sessionId)) {
      throw new HttpError(403, '当前为只读共享（viewer）：无写权限')
    }
    return session
  }

  /** 会话属主守卫（成员管理 / 删除会话）：无读权 → 404；非 owner → 403 */
  assertSessionOwner(user: AuthUser | undefined, sessionId: string): Session {
    const session = this.assertSession(user, sessionId)
    if (!this.multiUser) return session
    if (!user || this.sessionRole(user, sessionId) !== 'owner') {
      throw new HttpError(403, '仅会话属主可执行此操作')
    }
    return session
  }

  /**
   * 执行入口守卫（发送 / 派发 / 续跑 / 重试 / 后台触发）：先归属与写权，再拦下线成员。
   * 历史会话仍可读取、改名、隐藏与删除；只是不允许继续运行，也不静默替换角色。
   */
  assertSessionExecutable(user: AuthUser | undefined, sessionId: string): Session {
    const session = this.assertSessionWrite(user, sessionId)
    const retired = retiredScenesOf(session.participantIds)
    if (retired.length > 0) {
      throw new HttpError(409, `该会话包含已下线角色（${retired.join('、')}）：${RETIRED_SESSION_HINT}`)
    }
    return session
  }

  canAccessProject(user: AuthUser | undefined, projectId: string): boolean {
    if (!this.multiUser) return true
    if (!user) return false
    const project = this.deps.projects.get(projectId)
    if (!project) return false
    return this.ownsOrAdmin(user, project.ownerId)
  }

  assertProject(user: AuthUser | undefined, projectId: string): ProjectDefinition {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new HttpError(404, '项目不存在')
    if (!this.multiUser) return project
    if (!user || !this.ownsOrAdmin(user, project.ownerId)) throw new HttpError(404, '项目不存在')
    return project
  }

  /** 用户可见会话 id 集合（通知降级轮询过滤 / WS 订阅用；含共享会话；单用户兼容模式返回 undefined = 不过滤） */
  visibleSessionIds(user: AuthUser | undefined): Set<string> | undefined {
    if (!this.multiUser) return undefined
    if (!user) return new Set()
    return new Set(this.deps.sessions.listForUser(user.id).map((s) => s.id))
  }

  private ownsOrAdmin(user: AuthUser, ownerId: string | undefined): boolean {
    if (ownerId === user.id) return true
    // 孤儿行兜底：owner 为空的历史数据仅管理员可见（正常路径在 setup 时已回填完成）
    return !ownerId && user.role === 'admin'
  }
}
