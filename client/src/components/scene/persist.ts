/**
 * M52-A：场景层本地态（§7.3 / §7.8）——交互态存 sessionStorage（键 `ma:sc:*`，不落库）；
 * 布局偏好（纯列表开关 / dock 右区宽度折叠）存 localStorage；一律容错（隐私模式 / 非浏览器环境不崩）。
 */
import * as React from 'react'
import { useSessionStore } from '../../stores/session-store'

export const SC_LIST_KEY = 'ma:sc:list'
export const SC_DOCK_KEY = 'ma:sc:dock'

/** 会话内选中态键（面板 tab 等；sessionStorage） */
export function sceneTabKey(sessionId: string, key: string): string {
  return `ma:sc:tab:${sessionId || '-'}:${key}`
}

export function readStored<T>(kind: 'local' | 'session', key: string, fallback: T): T {
  try {
    const raw = kind === 'local' ? localStorage.getItem(key) : sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeStored(kind: 'local' | 'session', key: string, value: unknown): void {
  try {
    const raw = JSON.stringify(value)
    if (kind === 'local') localStorage.setItem(key, raw)
    else sessionStorage.setItem(key, raw)
  } catch {
    // 持久化失败不影响交互
  }
}

// ---------- dock 右区偏好 ----------

export interface DockPref {
  width: number
  collapsed: boolean
  closed: boolean
}

export const DOCK_DEFAULT: DockPref = { width: 360, collapsed: false, closed: false }
export const DOCK_MIN_W = 280
export const DOCK_MAX_W = 640

export function loadDockPref(): DockPref {
  const raw = readStored<Partial<DockPref>>('local', SC_DOCK_KEY, {})
  const width = typeof raw.width === 'number' && Number.isFinite(raw.width) ? Math.min(Math.max(raw.width, DOCK_MIN_W), DOCK_MAX_W) : DOCK_DEFAULT.width
  return {
    width,
    collapsed: raw.collapsed === true,
    closed: raw.closed === true,
  }
}

export function saveDockPref(pref: DockPref): void {
  writeStored('local', SC_DOCK_KEY, pref)
}

// ---------- roundtable 偏好（M59：汇聚板折叠 / 关闭；M59 续：顶区收起；localStorage，全局记忆） ----------

export const SC_RT_KEY = 'ma:sc:rt'

export interface RtPref {
  /** 折叠为窄条 rail（展开钮 + 竖标） */
  collapsed: boolean
  /** 关闭为浮动恢复胶囊 */
  closed: boolean
  /** 顶区收起为单行迷你条（小头像堆叠 + 摘要 + 展开钮） */
  topMini: boolean
}

export const RT_DEFAULT: RtPref = { collapsed: false, closed: false, topMini: false }

export function loadRtPref(): RtPref {
  const raw = readStored<Partial<RtPref>>('local', SC_RT_KEY, {})
  return { collapsed: raw.collapsed === true, closed: raw.closed === true, topMini: raw.topMini === true }
}

export function saveRtPref(pref: RtPref): void {
  writeStored('local', SC_RT_KEY, pref)
}

// ---------- 会话内选中态（sessionStorage；刷新保留、关闭标签即清） ----------

/** 面板 tab 等会话内选中态：键 `ma:sc:tab:<sessionId>:<key>`，值为 JSON 字符串 */
export function useSceneTab(
  key: string,
  fallback: string,
  sessionId?: string,
): [string, (v: string) => void] {
  const currentId = useSessionStore((s) => s.currentId)
  const sid = sessionId ?? currentId ?? ''
  const [value, setValue] = React.useState<string>(() => readStored('session', sceneTabKey(sid, key), fallback))
  // 切会话重读（同一面板实例跨会话复用时避免串态）
  React.useEffect(() => {
    setValue(readStored('session', sceneTabKey(sid, key), fallback))
  }, [sid, key, fallback])
  const set = React.useCallback(
    (v: string) => {
      setValue(v)
      writeStored('session', sceneTabKey(sid, key), v)
    },
    [sid, key],
  )
  return [value, set]
}

// ---------- 勾选态（coach 打卡等；sessionStorage，按会话） ----------

export function checksKey(sessionId: string): string {
  return `ma:sc:checks:${sessionId || '-'}`
}

export function loadChecks(sessionId: string): Map<string, boolean> {
  const obj = readStored<Record<string, boolean>>('session', checksKey(sessionId), {})
  const out = new Map<string, boolean>()
  for (const [k, v] of Object.entries(obj)) if (v === true || v === false) out.set(k, v)
  return out
}

export function saveChecks(sessionId: string, checks: Map<string, boolean>): void {
  writeStored('session', checksKey(sessionId), Object.fromEntries(checks))
}
