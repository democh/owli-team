/**
 * 交付件单一数据源（M87）。
 *
 * 背景：交付件面板 / 实况面 / 消息元数据曾各自维护缓存并各自全量拉取列表，一轮 N 个产物会因
 * SSE + WS 双通道事件放大成 O(3N) 次请求。现在统一到本 store：
 * - 首次访问按会话拉一次全量（服务端索引分页默认 500）；
 * - 后续 `artifact:updated` 只做 250ms 合并，再按 `revision` 拉增量（deletes + upserts）；
 * - 会话切换即重置；服务端无 revision（旧版 / 测试替身）时退化为全量拉取。
 */
import * as React from 'react'
import { create } from 'zustand'
import type { Artifact } from '@multi-agent/shared'
import { apiGet } from '../lib/api'
import { useSessionStore } from './session-store'

/** 事件合并窗口：一轮多产物 / 双通道重复事件收敛为一次请求 */
const MERGE_WINDOW_MS = 250

interface ArtifactListResponse {
  artifacts: Artifact[]
  revision?: number
  total?: number
}

interface ArtifactChangesResponse {
  revision: number
  upserts: Artifact[]
  deletes: string[]
}

export interface ArtifactState {
  sessionId?: string
  /** 服务端索引版本（旧版响应缺省 0 = 不支持增量） */
  revision: number
  artifacts: Artifact[]
  byPath: Map<string, Artifact>
  loading: boolean
  loaded: boolean
  ensure: (sessionId: string, opts?: { force?: boolean }) => Promise<void>
  refresh: (sessionId: string) => Promise<void>
}

let inflight: Promise<void> | null = null
let inflightKey = ''
let mergeTimer: ReturnType<typeof setTimeout> | undefined
let pendingSession: string | undefined

function applyList(sessionId: string, res: ArtifactListResponse): void {
  const artifacts = res.artifacts ?? []
  useArtifactStore.setState({
    sessionId,
    revision: typeof res.revision === 'number' ? res.revision : 0,
    artifacts,
    byPath: new Map(artifacts.map((a) => [a.path, a])),
    loading: false,
    loaded: true,
  })
}

function applyChanges(sessionId: string, res: ArtifactChangesResponse): boolean {
  const state = useArtifactStore.getState()
  if (state.sessionId !== sessionId) return false
  // 增量截断（服务端单次上限 500）→ 交由调用方全量重拉
  if (res.upserts.length + res.deletes.length >= 500) return false
  if (res.upserts.length === 0 && res.deletes.length === 0) {
    useArtifactStore.setState({ revision: res.revision })
    return true
  }
  const byPath = new Map(state.byPath)
  for (const path of res.deletes) byPath.delete(path)
  for (const artifact of res.upserts) byPath.set(artifact.path, artifact)
  const artifacts = state.artifacts.filter((a) => byPath.has(a.path)).map((a) => byPath.get(a.path)!)
  const known = new Set(artifacts.map((a) => a.path))
  for (const artifact of res.upserts) {
    if (!known.has(artifact.path)) artifacts.push(artifact)
  }
  artifacts.sort((a, b) => b.mtime - a.mtime)
  useArtifactStore.setState({ revision: res.revision, byPath, artifacts })
  return true
}

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  sessionId: undefined,
  revision: 0,
  artifacts: [],
  byPath: new Map(),
  loading: false,
  loaded: false,

  ensure: async (sessionId, opts = {}) => {
    const state = get()
    if (state.sessionId !== sessionId) {
      set({
        sessionId,
        revision: 0,
        artifacts: [],
        byPath: new Map(),
        loaded: false,
        loading: true,
      })
    } else if (state.loaded && !opts.force) {
      return
    } else if (!state.loading) {
      set({ loading: true })
    }
    const key = `${sessionId}~${opts.force ? 1 : 0}`
    if (inflight && inflightKey === key) return inflight
    inflightKey = key
    const task = apiGet<ArtifactListResponse>(`/api/sessions/${sessionId}/artifacts`)
      .then((res) => {
        if (get().sessionId === sessionId) applyList(sessionId, res)
      })
      .catch(() => {
        // 静默：展示层回退「名称 + 扩展名图标」，不阻塞消息渲染
        if (get().sessionId === sessionId) set({ loading: false })
      })
      .finally(() => {
        if (inflight === task) {
          inflight = null
          inflightKey = ''
        }
      })
    inflight = task
    return task
  },

  refresh: async (sessionId) => {
    const state = get()
    if (state.sessionId !== sessionId || !state.loaded || state.revision === 0) {
      return get().ensure(sessionId, { force: true })
    }
    try {
      const res = await apiGet<ArtifactChangesResponse>(
        `/api/sessions/${sessionId}/artifacts/changes?since=${state.revision}`,
      )
      if (applyChanges(sessionId, res)) return
    } catch {
      // 增量失败 → 全量兜底
    }
    return get().ensure(sessionId, { force: true })
  },
}))

/** 合并窗口中的刷新（事件风暴 → 一次请求） */
function scheduleRefresh(sessionId: string): void {
  pendingSession = sessionId
  if (mergeTimer) clearTimeout(mergeTimer)
  mergeTimer = setTimeout(() => {
    mergeTimer = undefined
    const target = pendingSession
    pendingSession = undefined
    if (!target) return
    void useArtifactStore.getState().refresh(target)
  }, MERGE_WINDOW_MS)
}

// 会话切换 / 交付件事件：统一在这里收敛（组件不再各自订阅 artifactVersion 拉全量）
useSessionStore.subscribe((state, prev) => {
  if (state.currentId !== prev.currentId) {
    if (!state.currentId) {
      useArtifactStore.setState({
        sessionId: undefined,
        revision: 0,
        artifacts: [],
        byPath: new Map(),
        loaded: false,
      })
      return
    }
    void useArtifactStore.getState().ensure(state.currentId)
    return
  }
  if (state.artifactVersion !== prev.artifactVersion && state.currentId) {
    scheduleRefresh(state.currentId)
  }
})

/** 当前会话交付件元数据（path → Artifact）；缺失时展示层回退基础样式 */
export function useArtifactMeta(): Map<string, Artifact> {
  const sessionId = useSessionStore((s) => s.currentId)
  const byPath = useArtifactStore((s) => s.byPath)
  React.useEffect(() => {
    if (sessionId) void useArtifactStore.getState().ensure(sessionId)
  }, [sessionId])
  return byPath
}
