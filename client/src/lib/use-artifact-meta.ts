/**
 * 交付件元数据共享缓存：kind / size 等展示信息按（会话 + artifactVersion）单次拉取，
 * 供消息内交付明细行与收尾交付清单共享——避免逐条消息各自请求。
 * - 会话切换即清空（先展示名称，元数据到达后补全）；同会话版本递增保留旧表，避免盘点闪烁；
 * - 拉取失败静默（空表）：展示层回退「通用图标 + 名称」，不阻塞消息渲染。
 */
import * as React from 'react'
import { create } from 'zustand'
import type { Artifact } from '@multi-agent/shared'
import { apiGet } from './api'
import { useSessionStore } from '../stores/session-store'

interface ArtifactMetaState {
  sessionId?: string
  version: number
  byPath: Map<string, Artifact>
}

export const useArtifactMetaStore = create<ArtifactMetaState>(() => ({ version: -1, byPath: new Map() }))

/** 在途请求键（会话~版本）：并发调用只发一次 */
let inflight: string | null = null

function load(sessionId: string, version: number): void {
  const key = `${sessionId}~${version}`
  const s = useArtifactMetaStore.getState()
  if (s.sessionId === sessionId && s.version === version) return
  if (inflight === key) return
  inflight = key
  useArtifactMetaStore.setState({ sessionId, version, byPath: s.sessionId === sessionId ? s.byPath : new Map() })
  apiGet<{ artifacts: Artifact[] }>(`/api/sessions/${sessionId}/artifacts`)
    .then((res) => {
      if (useArtifactMetaStore.getState().sessionId !== sessionId) return
      useArtifactMetaStore.setState({ byPath: new Map((res.artifacts ?? []).map((a) => [a.path, a])) })
    })
    .catch(() => {
      /* 静默：无元数据回退基础展示（名称 + 通用图标） */
    })
    .finally(() => {
      if (inflight === key) inflight = null
    })
}

/** 当前会话交付件元数据（path → Artifact）；随会话切换与 artifactVersion 自动刷新 */
export function useArtifactMeta(): Map<string, Artifact> {
  const sessionId = useSessionStore((s) => s.currentId)
  const version = useSessionStore((s) => s.artifactVersion)
  const byPath = useArtifactMetaStore((s) => s.byPath)
  React.useEffect(() => {
    if (sessionId) load(sessionId, version)
  }, [sessionId, version])
  return byPath
}
