/**
 * M57 P3：个人连接（成员「我的连接」卡）。
 * - 成员可创建 / 编辑 / 删除**自己的** personal 连接（服务端强制 scope=personal + ownerId=本人）；
 * - 建好后可在会话头部「资源」入口绑定（与 system 连接同等等级；仅属主可用，他人 不可见）；
 * - 媒体 / 嵌入连接为全局配置，不在此处创建（服务端 403 指引）。
 */
import * as React from 'react'
import type { ConnectionDefinition, ConnectionKind } from '@multi-agent/shared'
import { Cable, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, apiPut } from '../../lib/api'
import { useAuthStore } from '../../stores/auth-store'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

/** 可创建的个人连接类型（媒体 / 嵌入 = 全局配置） */
const KINDS: Array<{ kind: ConnectionKind; label: string }> = [
  { kind: 'sqlite', label: 'SQLite' },
  { kind: 'postgres', label: 'PostgreSQL' },
  { kind: 'mysql', label: 'MySQL' },
  { kind: 'ssh', label: 'SSH' },
]

interface FormState {
  name: string
  kind: ConnectionKind
  host: string
  port: string
  database: string
  username: string
  password: string
  path: string
}

const EMPTY: FormState = { name: '', kind: 'sqlite', host: '127.0.0.1', port: '', database: '', username: '', password: '', path: '' }

function formOf(connection: ConnectionDefinition): FormState {
  const c = connection.config as Record<string, unknown>
  const str = (key: string): string => (typeof c[key] === 'string' ? (c[key] as string) : '')
  return {
    name: connection.name,
    kind: connection.kind,
    host: str('host') || '127.0.0.1',
    port: c.port !== undefined ? String(c.port) : '',
    database: str('database'),
    username: str('username'),
    password: '',
    path: str('path'),
  }
}

function payloadOf(form: FormState): { config: Record<string, unknown>; secret?: Record<string, unknown> } {
  if (form.kind === 'sqlite') return { config: { path: form.path.trim(), readOnly: true, allowWrites: false } }
  if (form.kind === 'ssh') {
    return {
      config: {
        host: form.host.trim() || '127.0.0.1',
        port: form.port.trim() ? Number(form.port) : 22,
        username: form.username.trim(),
        authMethod: 'password',
        allowExec: false,
      },
      secret: form.password ? { password: form.password } : undefined,
    }
  }
  return {
    config: {
      host: form.host.trim() || '127.0.0.1',
      port: form.port.trim() ? Number(form.port) : form.kind === 'postgres' ? 5432 : 3306,
      database: form.database.trim(),
      username: form.username.trim(),
      readOnly: true,
      allowWrites: false,
    },
    secret: form.password ? { password: form.password } : undefined,
  }
}

const KIND_LABEL = new Map(KINDS.map((k) => [k.kind, k.label]))

export function PersonalConnectionsCard(): React.JSX.Element {
  const me = useAuthStore((s) => s.user)
  const [items, setItems] = React.useState<ConnectionDefinition[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState<ConnectionDefinition | null>(null)
  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(EMPTY)
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<{ connections: ConnectionDefinition[] }>('/api/connections')
      setItems(res.connections.filter((c) => c.scope === 'personal' && c.ownerId === me?.id))
    } catch {
      // 静默（设置页主体不受影响）
    } finally {
      setLoading(false)
    }
  }, [me?.id])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const openCreate = (): void => {
    setEditing(null)
    setForm({ ...EMPTY })
    setFormOpen(true)
  }

  const openEdit = (connection: ConnectionDefinition): void => {
    setEditing(connection)
    setForm(formOf(connection))
    setFormOpen(true)
  }

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      toast.error('请填写连接名称')
      return
    }
    if (form.kind === 'sqlite' && !form.path.trim()) {
      toast.error('请填写 SQLite 文件绝对路径')
      return
    }
    setBusy(true)
    try {
      const { config, secret } = payloadOf(form)
      if (editing) {
        await apiPut(`/api/connections/${editing.id}`, { name: form.name.trim(), config, secret: secret ?? undefined })
        toast('连接已更新')
      } else {
        await apiPost('/api/connections', { name: form.name.trim(), kind: form.kind, config, secret: secret ?? undefined })
        toast('连接已创建（在会话头部「资源」入口绑定后可用）')
      }
      setFormOpen(false)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (connection: ConnectionDefinition): Promise<void> => {
    setBusy(true)
    try {
      await apiDelete(`/api/connections/${connection.id}`)
      toast('连接已删除')
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isDb = form.kind === 'postgres' || form.kind === 'mysql'
  const inputClass = 'mt-1 block w-full rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] focus:border-primary/40 focus:outline-none'

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 pb-1">
        <Cable className="size-4 text-muted-foreground" />
        <CardTitle className="text-[13px]">我的连接</CardTitle>
        <span className="text-[11px] text-muted-foreground">仅本人可见；在会话头部「资源」入口绑定后，Agent 工具即可使用</span>
        <Button size="sm" variant="outline" className="ml-auto h-7 text-[12px]" onClick={openCreate}>
          <Plus className="size-3.5" />
          新建
        </Button>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载中…
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[12px] text-muted-foreground">
            还没有个人连接：点「新建」添加你的数据库 / SSH（不会与团队共享）
          </p>
        ) : (
          items.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]">
              <span className="font-medium">{c.name}</span>
              <span className="text-[11px] text-muted-foreground">{KIND_LABEL.get(c.kind) ?? c.kind}</span>
              {!c.enabled && <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">已禁用</span>}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <Button size="icon-sm" variant="ghost" title="编辑" disabled={busy} onClick={() => openEdit(c)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" title="删除（会话绑定一并解除）" disabled={busy} onClick={() => void remove(c)}>
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              </span>
            </div>
          ))
        )}
      </CardContent>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[14px]">{editing ? '编辑个人连接' : '新建个人连接'}</DialogTitle>
            <DialogDescription className="text-[12px]">
              个人连接仅自己可见可用；凭据加密存储，留空 = 不修改。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <label className="block">
              <span className="text-[12px] font-medium">名称</span>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：我的测试库" className={inputClass} />
            </label>
            {!editing && (
              <label className="block">
                <span className="text-[12px] font-medium">类型</span>
                <select
                  value={form.kind}
                  onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ConnectionKind }))}
                  className={inputClass}
                >
                  {KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {form.kind === 'sqlite' ? (
              <label className="block">
                <span className="text-[12px] font-medium">文件路径（绝对路径）</span>
                <input value={form.path} onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} placeholder="/Users/me/data.db" className={inputClass} />
              </label>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <label className="col-span-2 block">
                    <span className="text-[12px] font-medium">主机</span>
                    <input value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} className={inputClass} />
                  </label>
                  <label className="block">
                    <span className="text-[12px] font-medium">端口</span>
                    <input value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} placeholder={isDb ? (form.kind === 'postgres' ? '5432' : '3306') : '22'} className={inputClass} />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[12px] font-medium">用户名</span>
                    <input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} className={inputClass} />
                  </label>
                  <label className="block">
                    <span className="text-[12px] font-medium">密码（加密存储）</span>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                      placeholder={editing ? '留空 = 不修改' : ''}
                      className={inputClass}
                    />
                  </label>
                </div>
                {isDb && (
                  <label className="block">
                    <span className="text-[12px] font-medium">数据库名</span>
                    <input value={form.database} onChange={(e) => setForm((f) => ({ ...f, database: e.target.value }))} className={inputClass} />
                  </label>
                )}
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>
                取消
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {editing ? '保存' : '创建'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
