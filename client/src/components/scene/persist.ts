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
  /** 宽度意图：null = 自适应（随容器宽按比例，双击复位回到此态）；数值 = 用户拖拽 / 键盘的显式宽度 */
  width: number | null
  collapsed: boolean
  closed: boolean
}

export const DOCK_DEFAULT: DockPref = { width: null, collapsed: false, closed: false }
export const DOCK_MIN_W = 280
/** 上限口径：容器宽度的一半（「最多一半」；批九） */
export const DOCK_HALF_FRAC = 0.5
/** 自适应默认：容器宽的 1/3，clamp 380–600（窗口越宽右区越宽；批九） */
export const DOCK_DEFAULT_FRAC = 1 / 3
export const DOCK_DEFAULT_MIN_W = 380
export const DOCK_DEFAULT_MAX_W = 600
/** 旧版固定默认宽（360）：存量偏好迁移为自适应——未显式拖宽的用户升级后默认变宽（批九） */
const LEGACY_DEFAULT_W = 360

/** 容器宽度 → 右区上限（最多一半；下限保 DOCK_MIN_W） */
export function dockMaxW(containerW: number): number {
  return Math.max(DOCK_MIN_W, Math.floor(containerW * DOCK_HALF_FRAC))
}

/** 容器宽度 → 自适应默认宽（1/3，clamp 380–600；不超过半屏上限） */
export function dockDefaultW(containerW: number): number {
  const byFrac = Math.round(containerW * DOCK_DEFAULT_FRAC)
  return Math.min(Math.min(Math.max(byFrac, DOCK_DEFAULT_MIN_W), DOCK_DEFAULT_MAX_W), dockMaxW(containerW))
}

/** 显式宽度落到当前容器约束（[DOCK_MIN_W, 当前半屏上限]） */
export function clampDockW(width: number, containerW: number): number {
  return Math.min(Math.max(Math.round(width), DOCK_MIN_W), dockMaxW(containerW))
}

export function loadDockPref(): DockPref {
  const raw = readStored<Partial<DockPref>>('local', SC_DOCK_KEY, {})
  // 旧固定默认值（360）迁移为自适应；落盘值只做下限护栏——上限随容器动态收敛（渲染期 clampDockW），
  // 窗口再放宽时原始意图不丢（不把临时收敛值写回存储）
  const stored = typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width !== LEGACY_DEFAULT_W ? raw.width : null
  const width = stored === null ? null : Math.max(stored, DOCK_MIN_W)
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

// ---------- 终局结论条（M63 A6；sessionStorage，按会话） ----------

export function conclusionKey(sessionId: string): string {
  return `ma:sc:concl:${sessionId || '-'}`
}

/** 结论条是否已被用户关闭（本会话已读语义） */
export function loadConclusionClosed(sessionId: string): boolean {
  return readStored<unknown>('session', conclusionKey(sessionId), false) === true
}

/** 关闭结论条（本会话隐藏；换会话重新展示） */
export function saveConclusionClosed(sessionId: string): void {
  writeStored('session', conclusionKey(sessionId), true)
}

// ---------- 点亮态（M38 点子池；sessionStorage，按会话；ADR 0145） ----------

/** 点亮变更事件名（同会话多实例同步：消息内点子卡 × 汇聚板点子池） */
export const LIGHTS_EVENT = 'ma:sc:lights'

export function lightsKey(sessionId: string): string {
  return `ma:sc:lights:${sessionId || '-'}`
}

/** 点亮键集合（键含 messageId + 编号 + 标题，与卡片 / 面板同源；非法项过滤） */
export function loadLights(sessionId: string): Set<string> {
  const arr = readStored<unknown>('session', lightsKey(sessionId), [])
  const out = new Set<string>()
  if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'string' && v !== '') out.add(v)
  return out
}

export function saveLights(sessionId: string, lights: ReadonlySet<string>): void {
  writeStored('session', lightsKey(sessionId), [...lights])
}

/**
 * 点亮态 hook：读 / 切换 / 跨实例同步——写入自持态并广播事件，
 * 同会话内的其他实例（消息内卡片 ↔ 汇聚板）经事件重读，保证两处一致。
 */
export function useSceneLights(sessionId: string): [ReadonlySet<string>, (key: string) => void] {
  const [lights, setLights] = React.useState<ReadonlySet<string>>(() => loadLights(sessionId))
  React.useEffect(() => {
    setLights(loadLights(sessionId))
  }, [sessionId])
  React.useEffect(() => {
    const onEvent = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === sessionId) setLights(loadLights(sessionId))
    }
    window.addEventListener(LIGHTS_EVENT, onEvent)
    return () => window.removeEventListener(LIGHTS_EVENT, onEvent)
  }, [sessionId])
  const toggle = React.useCallback(
    (key: string): void => {
      if (!key) return
      const next = new Set(loadLights(sessionId))
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveLights(sessionId, next)
      setLights(next)
      try {
        window.dispatchEvent(new CustomEvent(LIGHTS_EVENT, { detail: sessionId }))
      } catch {
        // 非浏览器 / 隐私模式：忽略（仅即时态）
      }
    },
    [sessionId],
  )
  return [lights, toggle]
}
