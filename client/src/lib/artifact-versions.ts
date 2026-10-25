/**
 * M44（AF-1 / AF-2 / AF-5）：交付件版本列表共享缓存——按（会话 + 路径 + artifactVersion）拉取
 * `GET /api/sessions/:id/artifacts/versions`；供锚定条（vN + 版本线 + 修改者头像流）、变更卡
 * （vN 徽章）与签收块（vN）共用；失败静默（undefined → 降级「仅文件名」）。
 * 与 artifact-store 同构：会话切换重置；版本递增保留旧表避免闪烁、按需重拉。
 */
import * as React from 'react'
import { create } from 'zustand'
import type { ArtifactVersion } from '../components/artifacts/DiffView'
import { apiGet } from './api'
import { useSessionStore } from '../stores/session-store'

interface ArtifactVersionsState {
  sessionId?: string
  version: number
  byPath: Map<string, ArtifactVersion[]>
}

export const useArtifactVersionsStore = create<ArtifactVersionsState>(() => ({ version: -1, byPath: new Map() }))

/** 在途请求键（会话~版本~路径）：并发调用只发一次 */
const inflight = new Set<string>()

function load(sessionId: string, version: number, path: string): void {
  const key = `${sessionId}~${version}~${path}`
  if (inflight.has(key)) return
  inflight.add(key)
  apiGet<{ versions: ArtifactVersion[] }>(
    `/api/sessions/${sessionId}/artifacts/versions?path=${encodeURIComponent(path)}`,
  )
    .then((res) => {
      const s = useArtifactVersionsStore.getState()
      if (s.sessionId !== sessionId || s.version !== version) return
      const byPath = new Map(s.byPath)
      byPath.set(path, res.versions ?? [])
      useArtifactVersionsStore.setState({ byPath })
    })
    .catch(() => {
      /* 静默：无版本信息回退基础展示（仅文件名） */
    })
    .finally(() => {
      inflight.delete(key)
    })
}

/** 指定路径的版本列表（新 → 旧）；会话切换或 artifactVersion 递增后自动刷新；未就绪 undefined */
export function useArtifactVersions(path: string | undefined): ArtifactVersion[] | undefined {
  const sessionId = useSessionStore((s) => s.currentId)
  const version = useSessionStore((s) => s.artifactVersion)
  const byPath = useArtifactVersionsStore((s) => s.byPath)
  const sid = sessionId ?? ''

  React.useEffect(() => {
    if (!sid || !path) return
    const s = useArtifactVersionsStore.getState()
    if (s.sessionId !== sid || s.version !== version) {
      useArtifactVersionsStore.setState({
        sessionId: sid,
        version,
        byPath: s.sessionId === sid ? s.byPath : new Map(),
      })
    }
    load(sid, version, path)
  }, [sid, version, path])

  return path ? byPath.get(path) : undefined
}
