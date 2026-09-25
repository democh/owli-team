/**
 * M57 P3：个人 MCP（成员「我的 MCP」卡）。
 * - 成员可创建 / 删除自己的 personal MCP 服务器（stdio / http；服务端强制 scope=personal + owner=本人）；
 * - 连接状态一目了然（idle / ok / error），可手动重连 / 测试（test = 探测连接 + 工具清单）；
 * - 在会话头部「资源」入口绑定后，其工具自动授予该会话（无需管理员编辑 Agent 白名单）；
 * - system MCP 服务器仍由管理员在 MCP 管理台统一维护。
 */
import * as React from 'react'
import type { McpServerDefinition } from '@multi-agent/shared'
import { Blocks, Loader2, PlugZap, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost } from '../../lib/api'
import { useAuthStore } from '../../stores/auth-store'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

interface FormState {
  name: string
  displayName: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
}

const EMPTY: FormState = { name: '', displayName: '', transport: 'stdio', command: '', args: '', url: '' }

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  ok: { text: '已连接', className: 'text-emerald-700' },
  error: { text: '连接失败', className: 'text-rose-600' },
  idle: { text: '未连接', className: 'text-muted-foreground' },
}

export function PersonalMcpCard(): React.JSX.Element {
  const me = useAuthStore((s) => s.user)
  const [items, setItems] = React.useState<McpServerDefinition[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(EMPTY)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<{ servers: McpServerDefinition[] }>('/api/mcp/servers')
      setItems(res.servers.filter((s) => s.scope === 'personal' && s.ownerId === me?.id))
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
    setForm({ ...EMPTY })
    setFormOpen(true)
  }

  const save = async (): Promise<void> => {
    const name = form.name.trim()
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
      toast.error('服务器名需为小写 slug（字母开头，含小写字母 / 数字 / 连字符）——将作为工具名前缀')
      return
    }
    if (form.transport === 'stdio' && !form.command.trim()) {
      toast.error('stdio 需要填写启动命令')
      return
    }
    if (form.transport === 'http' && !/^https?:\/\//i.test(form.url.trim())) {
      toast.error('http 需要填写 http(s) 地址')
      return
    }
    setBusy(true)
    try {
      const config =
        form.transport === 'stdio'
          ? { command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : [] }
          : { url: form.url.trim() }
      const res = await apiPost<{ server: McpServerDefinition }>('/api/mcp/servers', {
        name,
        displayName: form.displayName.trim() || undefined,
        transport: form.transport,
        config,
      })
      setFormOpen(false)
      // 保存即测试（连接 + 工具清单探测；失败不阻断创建）
      try {
        const tested = await apiPost<{ ok: boolean; detail?: string; error?: string }>(`/api/mcp/servers/${res.server.id}/test`, {})
        if (tested.ok) toast.success(`已创建并连接成功${tested.detail ? ` · ${tested.detail}` : ''}`)
        else toast.error(`已创建，但连接失败：${tested.error ?? tested.detail ?? '未知原因'}（可在列表中重连）`)
      } catch (err) {
        toast.error(`已创建，测试失败：${(err as Error).message}`)
      }
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reconnect = async (server: McpServerDefinition): Promise<void> => {
    setBusy(true)
    try {
      await apiPost(`/api/mcp/servers/${server.id}/reconnect`, {})
      toast.success(`已重连「${server.displayName ?? server.name}」`)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const test = async (server: McpServerDefinition): Promise<void> => {
    setBusy(true)
    try {
      const result = await apiPost<{ ok: boolean; detail?: string; error?: string }>(`/api/mcp/servers/${server.id}/test`, {})
      if (result.ok) toast.success(`连接正常${result.detail ? ` · ${result.detail}` : ''}`)
      else toast.error(result.error ?? result.detail ?? '连接失败')
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (server: McpServerDefinition): Promise<void> => {
    setBusy(true)
    try {
      await apiDelete(`/api/mcp/servers/${server.id}`)
      toast('服务器已删除（会话绑定一并解除）')
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'mt-1 block w-full rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] focus:border-primary/40 focus:outline-none'

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 pb-1">
        <Blocks className="size-4 text-muted-foreground" />
        <CardTitle className="text-[13px]">我的 MCP</CardTitle>
        <span className="text-[11px] text-muted-foreground">仅本人可见；在会话头部「资源」入口绑定后，其工具自动授予该会话</span>
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
            还没有个人 MCP 服务器：点「新建」接入你的 stdio / http 服务（不会与团队共享）
          </p>
        ) : (
          items.map((server) => {
            const status = STATUS_LABEL[server.status] ?? STATUS_LABEL.idle!
            return (
              <div key={server.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]">
                <span className="font-medium">{server.displayName ?? server.name}</span>
                <span className="text-[11px] text-muted-foreground">{server.name} · {server.transport}</span>
                <span className={`text-[11px] ${status.className}`} title={server.lastError ?? undefined}>
                  {status.text}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <Button size="icon-sm" variant="ghost" title="测试连接（探测工具清单）" disabled={busy} onClick={() => void test(server)}>
                    <ShieldCheck className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" title="重连（重建进程 / 连接）" disabled={busy} onClick={() => void reconnect(server)}>
                    <RefreshCw className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" title="删除（会话绑定一并解除）" disabled={busy} onClick={() => void remove(server)}>
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </span>
              </div>
            )
          })
        )}
      </CardContent>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[14px]">新建个人 MCP 服务器</DialogTitle>
            <DialogDescription className="text-[12px]">
              仅自己可见可用；stdio 启动本机命令 / http 连接远程服务；凭据（env / headers）请写入命令参数或服务端配置。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[12px] font-medium">服务器名（slug，工具前缀）</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="如 my-notes"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium">展示名（可选）</span>
                <input
                  value={form.displayName}
                  onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                  placeholder="如 我的笔记库"
                  className={inputClass}
                />
              </label>
            </div>
            <label className="block">
              <span className="text-[12px] font-medium">传输方式</span>
              <select
                value={form.transport}
                onChange={(e) => setForm((f) => ({ ...f, transport: e.target.value as FormState['transport'] }))}
                className={inputClass}
              >
                <option value="stdio">stdio（本机命令）</option>
                <option value="http">http（远程 Streamable HTTP）</option>
              </select>
            </label>
            {form.transport === 'stdio' ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[12px] font-medium">启动命令</span>
                  <input
                    value={form.command}
                    onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                    placeholder="如 npx"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="text-[12px] font-medium">参数（空格分隔）</span>
                  <input
                    value={form.args}
                    onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                    placeholder="如 -y @modelcontextprotocol/server-memory"
                    className={inputClass}
                  />
                </label>
              </div>
            ) : (
              <label className="block">
                <span className="text-[12px] font-medium">服务地址</span>
                <input
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://example.com/mcp"
                  className={inputClass}
                />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>
                取消
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                创建并连接
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
