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
  hasMore?: boolean
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
  total: number
  error: string | null
  ensure: (sessionId: string, opts?: { force?: boolean; reconcile?: boolean }) => Promise<void>
  refresh: (sessionId: string) => Promise<void>
}

let inflight: Promise<void> | null = null
let inflightKey = ''
let generation = 0
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
    total: res.total ?? artifacts.length,
    error: null,
  })
}

function applyChanges(sessionId: string, res: ArtifactChangesResponse): boolean {
  const state = useArtifactStore.getState()
  if (state.sessionId !== sessionId) return false
  if (res.revision < state.revision) return true
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
  useArtifactStore.setState({
    revision: res.revision,
    byPath,
    artifacts,
    total: artifacts.length,
    error: null,
  })
  return true
}

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  sessionId: undefined,
  revision: 0,
  artifacts: [],
  byPath: new Map(),
  loading: false,
  loaded: false,
  total: 0,
  error: null,

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
        total: 0,
        error: null,
      })
    } else if (state.loaded && !opts.force) {
      return
    } else if (!state.loading) {
      set({ loading: true, error: null })
    }
    const key = `${sessionId}~${opts.reconcile ? 1 : 0}`
    if (inflight && inflightKey === key && state.sessionId === sessionId) return inflight
    inflightKey = key
    const version = ++generation
    const isCurrent = (): boolean => generation === version && get().sessionId === sessionId
    const task = (async () => {
      // 顺序取齐分页；版本变化时重新取快照，避免 offset 漂移造成漏项。
      for (let attempt = 0; attempt < 3; attempt++) {
        let offset = 0
        let revision: number | undefined
        const byPath = new Map<string, Artifact>()
        while (isCurrent()) {
          const params = new URLSearchParams()
          if (offset) {
            params.set('offset', String(offset))
            params.set('limit', '500')
          }
          if (opts.reconcile && attempt === 0 && offset === 0) params.set('refresh', '1')
          const query = params.toString()
          const res = await apiGet<ArtifactListResponse>(
            `/api/sessions/${sessionId}/artifacts${query ? `?${query}` : ''}`,
          )
          if (!isCurrent()) return
          if (offset > 0 && revision !== res.revision) break
          revision = res.revision
          const page = res.artifacts ?? []
          for (const artifact of page) byPath.set(artifact.path, artifact)
          offset += page.length
          if (!(res.hasMore ?? (typeof res.total === 'number' && offset < res.total))) {
            applyList(sessionId, { ...res, artifacts: [...byPath.values()] })
            return
          }
          if (page.length === 0) throw new Error('交付件分页未返回数据，请重试刷新')
        }
        if (!isCurrent()) return
      }
      throw new Error('工作区正在持续更新，请稍后重试刷新')
    })()
      .catch((err: unknown) => {
        if (isCurrent()) set({ loading: false, error: err instanceof Error ? err.message : '交付件加载失败' })
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
    if (state.loading && inflight && state.sessionId === sessionId) {
      await inflight
      if (get().sessionId === sessionId) return get().refresh(sessionId)
      return
    }
    const version = generation
    if (state.sessionId !== sessionId || !state.loaded || state.revision === 0) {
      return get().ensure(sessionId, { force: true })
    }
    try {
      const res = await apiGet<ArtifactChangesResponse>(
        `/api/sessions/${sessionId}/artifacts/changes?since=${state.revision}`,
      )
      if (generation !== version || get().sessionId !== sessionId) return
      if (applyChanges(sessionId, res)) return
    } catch {
      // 增量失败 → 全量兜底
    }
    if (generation === version && get().sessionId === sessionId)
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
    if (!target || useSessionStore.getState().currentId !== target) return
    void useArtifactStore.getState().refresh(target)
  }, MERGE_WINDOW_MS)
}

// 会话切换 / 交付件事件：统一在这里收敛（组件不再各自订阅 artifactVersion 拉全量）
useSessionStore.subscribe((state, prev) => {
  if (state.currentId !== prev.currentId) {
    if (!state.currentId) {
      generation++
      inflight = null
      inflightKey = ''
      useArtifactStore.setState({
        sessionId: undefined,
        revision: 0,
        artifacts: [],
        byPath: new Map(),
        loaded: false,
        loading: false,
        total: 0,
        error: null,
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
