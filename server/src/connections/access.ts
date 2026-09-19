/**
 * M57 P2：连接使用最小权限复核（工具执行侧，与绑定侧闸门 / 浏览器 M62 复核口径一致）。
 *
 * 背景（共享会话缺口）：会话绑定是 P1 的闸门（成员绑定时仅可绑 member_use=1 的连接），
 * 但「admin 在会话里绑定了私有 / 未开放连接 → 会话共享给成员 → 成员通过 Agent 工具间接触达」
 * 这条路径没有复核；member_use 事后撤销也存在同样窗口。本模块在执行点以「本 Run 触发者」复核。
 *
 * 语义：
 * - 单用户兼容模式 → 全部放行（行为与旧版一致）；
 * - 触发者为 admin / 未知（历史 run、系统触发）→ 放行；
 * - 成员（member）→ 放行 member_use=1 的 system 连接，以及**本人创建的 personal 连接**（M57 P3）。
 */
import type { ConnectionStore } from '../store/connections.js'
import type { UserStore } from '../store/users.js'

export interface ConnectionUseGuardDeps {
  /** 是否已进入多用户模式（AuthService.multiUser 的惰性读取） */
  multiUser: () => boolean
  users: UserStore
  connections: ConnectionStore
}

/** 连接可用性复核（返回拒绝文案；undefined = 放行） */
export type ConnectionUseGuard = (connectionId: string, triggerUserId?: string) => string | undefined

export function createConnectionUseGuard(deps: ConnectionUseGuardDeps): ConnectionUseGuard {
  return (connectionId, triggerUserId) => {
    if (!deps.multiUser()) return undefined
    const user = triggerUserId ? deps.users.get(triggerUserId) : undefined
    if (!user || user.role === 'admin') return undefined
    if (deps.connections.memberUsable(connectionId)) return undefined
    // M57 P3：personal 连接仅属主可用（成员自有连接）
    if (deps.connections.ownsPersonal(user.id, connectionId)) return undefined
    return '该连接未对成员开放（需管理员在连接设置中开启「允许成员使用」）：请联系管理员，或改用本会话已开放的其他连接'
  }
}
