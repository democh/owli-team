/**
 * M65-B：工作台场景数据 hook——加载（artifact content raw）/ 草稿编辑 / 保存（design-scenes PUT）。
 *
 * - 加载：GET artifacts/content（raw）→ parseDesignScene（宽容过滤）；加载同时拉 design-scenes
 *   列表拿 mtimeMs 作乐观锁基准；
 * - 编辑：update 为纯草稿更新（dirty 标记），不落盘；
 * - 保存：PUT 携带 ifUnmodifiedSince；409（文件已被更新）→ 返回 conflict 供 UI 提示。
 */
import * as React from 'react'
import type { DesignScene } from '@multi-agent/shared'
import { artifactContentUrl } from '../../lib/artifacts'
import { apiGet, apiPut, ApiError } from '../../lib/api'
import { parseDesignScene } from './design-scene-model'

interface SceneFileEntry {
  path: string
  mtimeMs: number
  size: number
}

export interface DesignSceneState {
  scene?: DesignScene
  loading: boolean
  error?: string
  /** 方案源文件不存在（404：成员声明未落盘 / 已被移除）——错误卡展示「补落盘」引导 */
  notFound: boolean
  /** 被宽容过滤的条目数（>0 时 UI 提示） */
  filtered: number
  dirty: boolean
  save: () => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  update: (updater: (scene: DesignScene) => DesignScene) => void
  reload: () => void
}

export function useDesignScene(sessionId: string | undefined, path: string | undefined): DesignSceneState {
  const [scene, setScene] = React.useState<DesignScene>()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [notFound, setNotFound] = React.useState(false)
  const [filtered, setFiltered] = React.useState(0)
  const [dirty, setDirty] = React.useState(false)
  const mtimeRef = React.useRef<number | undefined>(undefined)
  const [reloadTick, setReloadTick] = React.useState(0)

  React.useEffect(() => {
    if (!sessionId || !path) {
      setScene(undefined)
      setError(undefined)
      setNotFound(false)
      setDirty(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setNotFound(false)
    setDirty(false)
    // mtime 基准（列表查询失败不阻塞加载：退化为无条件覆盖）
    void apiGet<{ scenes: SceneFileEntry[] }>(`/api/sessions/${sessionId}/design-scenes`)
      .then((r) => {
        mtimeRef.current = r.scenes.find((s) => s.path === path)?.mtimeMs
      })
      .catch(() => {
        mtimeRef.current = undefined
      })
    void fetch(artifactContentUrl(sessionId, path, { raw: true }))
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
          throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status })
        }
        return (await res.json()) as unknown
      })
      .then((raw) => {
        if (cancelled) return
        const parsed = parseDesignScene(raw)
        if (!parsed.ok) {
          setScene(undefined)
          setError(parsed.error)
          return
        }
        setScene(parsed.scene)
        setFiltered(parsed.filtered)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 404：文件未落盘（成员只声明未写入 / 已被移除）——给出可行动的提示而非裸错误
        if ((err as { status?: number }).status === 404) {
          setNotFound(true)
          setError(`方案源未落盘：${path} 不存在（成员可能只声明未写入，可让其补落盘）`)
          return
        }
        setError(`加载失败：${(err as Error).message}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, path, reloadTick])

  const update = React.useCallback((updater: (s: DesignScene) => DesignScene): void => {
    setScene((prev) => {
      if (!prev) return prev
      return updater(prev)
    })
    setDirty(true)
  }, [])

  const save = React.useCallback(async (): Promise<{ ok: boolean; error?: string; conflict?: boolean }> => {
    if (!sessionId || !path || !scene) return { ok: false, error: '暂无可保存内容' }
    try {
      const res = await apiPut<{ path: string; mtimeMs: number }>(`/api/sessions/${sessionId}/design-scenes`, {
        path,
        data: scene,
        ...(mtimeRef.current !== undefined ? { ifUnmodifiedSince: mtimeRef.current } : {}),
      })
      mtimeRef.current = res.mtimeMs
      setDirty(false)
      return { ok: true }
    } catch (err) {
      if (err instanceof ApiError) {
        return { ok: false, error: err.message, conflict: err.status === 409 }
      }
      return { ok: false, error: (err as Error).message }
    }
  }, [sessionId, path, scene])

  const reload = React.useCallback((): void => setReloadTick((t) => t + 1), [])

  return {
    ...(scene ? { scene } : {}),
    loading,
    ...(error ? { error } : {}),
    notFound,
    filtered,
    dirty,
    save,
    update,
    reload,
  }
}
