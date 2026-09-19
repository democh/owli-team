/**
 * M68：用户素材库状态（独立菜单管理页面的数据面）。
 *
 * - 列表 / 容量：GET /api/library/items（query / kind）+ GET /api/library/usage；
 * - 上传：POST /api/library/uploads（raw 二进制 ≤200MB；x-file-name 携原名，服务端白名单校验）；
 * - 删除：行 + 文件双清（DELETE）；放入画布：to-canvas 入仓（copy-on-use）→ canvas-store.sendArtifact 落节点。
 * 归属由服务端从登录身份取（兼容模式 'local'），前端不做任何 owner 传递。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type { LibraryItem, LibraryItemKind, LibraryUsage } from '@multi-agent/shared'
import { useCanvasStore } from './canvas-store'
import { useSessionStore } from './session-store'

interface LibraryState {
  items: LibraryItem[]
  usage?: LibraryUsage
  loading: boolean
  /** 上传中计数（按钮 loading / 禁用） */
  uploading: number
  /** 列表拉取（query / kind 服务端过滤；防抖由调用方控制） */
  load(opts?: { query?: string; kind?: LibraryItemKind }): Promise<void>
  /** 批量上传（逐个串行）；返回成功数 */
  upload(files: readonly File[]): Promise<number>
  /** 删除（双清）；成功即本地移除 */
  remove(id: string): Promise<boolean>
  /** 放入当前会话画布（入仓 + sendArtifact）；返回是否成功 */
  toCanvas(id: string): Promise<boolean>
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `请求失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as T
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  items: [],
  usage: undefined,
  loading: false,
  uploading: 0,

  load: async (opts) => {
    set({ loading: true })
    try {
      const params = new URLSearchParams()
      if (opts?.query?.trim()) params.set('query', opts.query.trim())
      if (opts?.kind) params.set('kind', opts.kind)
      const qs = params.toString()
      const [itemsRes, usageRes] = await Promise.all([
        request<{ items: LibraryItem[] }>(`/api/library/items${qs ? `?${qs}` : ''}`),
        request<{ usage: LibraryUsage }>('/api/library/usage'),
      ])
      set({ items: itemsRes.items, usage: usageRes.usage, loading: false })
    } catch (err) {
      set({ loading: false })
      toast.error((err as Error).message)
    }
  },

  upload: async (files) => {
    if (files.length === 0) return 0
    set({ uploading: get().uploading + files.length })
    let ok = 0
    try {
      for (const file of files) {
        try {
          await request<{ item: LibraryItem }>('/api/library/uploads', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-file-name': encodeURIComponent(file.name),
            },
            body: file,
          })
          ok += 1
        } catch (err) {
          toast.error(`${file.name}：${(err as Error).message}`)
        } finally {
          set({ uploading: Math.max(0, get().uploading - 1) })
        }
      }
      if (ok > 0) {
        toast(ok === 1 ? '素材已上传' : `已上传 ${ok} 个素材`)
        await get().load()
      }
      return ok
    } finally {
      set({ uploading: 0 })
    }
  },

  remove: async (id) => {
    try {
      await request(`/api/library/items/${id}`, { method: 'DELETE' })
      set({ items: get().items.filter((x) => x.id !== id) })
      void get().load() // 容量与列表对账
      toast('素材已删除')
      return true
    } catch (err) {
      toast.error((err as Error).message)
      return false
    }
  },

  toCanvas: async (id) => {
    const sessionId = useSessionStore.getState().currentId
    if (!sessionId) {
      toast.error('先在左侧选择一个会话，再放入画布')
      return false
    }
    try {
      const res = await request<{ path: string; kind: LibraryItemKind }>(`/api/library/items/${id}/to-canvas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      // copy-on-use 入仓完成 → 复用「送上画布」落节点（图片 / 视频直出节点）
      const nodeId = await useCanvasStore.getState().sendArtifact(res.path)
      if (!nodeId) {
        toast.error('画布加载失败，稍后再试')
        return false
      }
      toast('已放入画布（素材副本已存入会话工作区）')
      return true
    } catch (err) {
      toast.error((err as Error).message)
      return false
    }
  },
}))
