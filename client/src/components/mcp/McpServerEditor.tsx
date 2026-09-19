/**
 * M27：MCP 服务器编辑器（新建 / 编辑，Dialog 表单）。
 * - 双传输表单：stdio（command / args / cwd / env）与 http（url / headers）；
 * - 凭据只写不读：env / headers 全量进 SecretVault（加密落库）；编辑时留空 = 不修改，
 *   可显式「清除已保存凭据」（secret: null）；
 * - 策略字段：approvalPolicy（risky/always/never）、readOnlyOverride（auto/readonly/write）、timeoutMs；
 * - M28：eagerLoad（始终加载，跳过延迟发现）；source='json' 时整体只读（文件权威）。
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  McpApprovalPolicy,
  McpReadOnlyOverride,
  McpServerConfig,
  McpServerDefinition,
  McpServerInput,
  McpTransportKind,
} from '@multi-agent/shared'
import { useMcpStore } from '../../stores/mcp-store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { FieldRow, Switch, TextInput } from '../console/fields'

const SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/

interface FormState {
  name: string
  displayName: string
  transport: McpTransportKind
  command: string
  argsText: string
  cwd: string
  url: string
  timeoutMs: string
  approvalPolicy: McpApprovalPolicy
  readOnlyOverride: McpReadOnlyOverride
  envText: string
  headersText: string
  enabled: boolean
  /** M28：始终加载（本服务器全部工具常驻，跳过延迟发现） */
  eagerLoad: boolean
  clearSecret: boolean
}

function initialForm(server?: McpServerDefinition): FormState {
  return {
    name: server?.name ?? '',
    displayName: server?.displayName ?? '',
    transport: server?.transport ?? 'stdio',
    command: server?.config.command ?? '',
    argsText: (server?.config.args ?? []).join('\n'),
    cwd: server?.config.cwd ?? '',
    url: server?.config.url ?? '',
    timeoutMs: server?.config.timeoutMs !== undefined ? String(server.config.timeoutMs) : '',
    approvalPolicy: server?.config.approvalPolicy ?? 'risky',
    readOnlyOverride: server?.config.readOnlyOverride ?? 'auto',
    envText: '',
    headersText: '',
    enabled: server?.enabled ?? true,
    eagerLoad: server?.config.eagerLoad ?? false,
    clearSecret: false,
  }
}

/** `KEY=VALUE` 逐行解析（# 注释 / 空行忽略） */
function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    if (key) out[key] = trimmed.slice(idx + 1).trim()
  }
  return out
}

export function McpServerEditor({
  server,
  onClose,
}: {
  /** 缺省 = 新建 */
  server?: McpServerDefinition
  onClose: () => void
}): React.JSX.Element {
  const [form, setForm] = React.useState<FormState>(() => initialForm(server))
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const isEdit = !!server
  /** M28：mcp.json 管理的服务器只读（文件权威；保存会被服务端 409 拒绝，前端直接禁止修改） */
  const readOnly = server?.source === 'json'
  const patch = (next: Partial<FormState>): void => setForm((f) => ({ ...f, ...next }))

  const save = async (): Promise<void> => {
    const name = form.name.trim()
    if (!SLUG_RE.test(name)) {
      setError('服务器名需为小写 slug：字母开头、仅含字母 / 数字 / 连字符（≤40），作为工具名前缀')
      return
    }
    if (form.transport === 'stdio' && !form.command.trim()) {
      setError('stdio 服务器需填写启动命令（command）')
      return
    }
    if (form.transport === 'http' && !/^https?:\/\/.+/.test(form.url.trim())) {
      setError('http 服务器需填写以 http:// 或 https:// 开头的端点（url）')
      return
    }
    if (form.timeoutMs.trim()) {
      const n = Number(form.timeoutMs)
      if (!Number.isInteger(n) || n < 1_000 || n > 600_000) {
        setError('超时需为 1000–600000 毫秒（1s–600s）')
        return
      }
    }
    setError('')
    const args = form.argsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const config: McpServerConfig = {
      timeoutMs: form.timeoutMs.trim() ? Number(form.timeoutMs) : undefined,
      approvalPolicy: form.approvalPolicy,
      readOnlyOverride: form.readOnlyOverride,
      // M28：仅开启时写入（关 = 缺省按需检索；config 整体替换时旧值自然清除）
      ...(form.eagerLoad ? { eagerLoad: true } : {}),
    }
    if (form.transport === 'stdio') {
      config.command = form.command.trim()
      if (args.length > 0) config.args = args
      if (form.cwd.trim()) config.cwd = form.cwd.trim()
    } else {
      config.url = form.url.trim()
    }
    // 凭据：新建 = 全量提交；编辑 = 留空不修改 / clearSecret 清空 / 有输入则替换
    const secretEntries =
      form.transport === 'stdio' ? parseKeyValues(form.envText) : parseKeyValues(form.headersText)
    const secretDict: Record<string, unknown> =
      form.transport === 'stdio' ? { env: secretEntries } : { headers: secretEntries }
    const hasInput = Object.keys(secretEntries).length > 0
    const input: McpServerInput = {
      name,
      displayName: form.displayName.trim() || null,
      transport: form.transport,
      config,
      enabled: form.enabled,
    }
    if (!isEdit) {
      if (hasInput) input.secret = secretDict
    } else if (form.clearSecret) {
      input.secret = null
    } else if (hasInput) {
      input.secret = secretDict
    }
    setSaving(true)
    try {
      const store = useMcpStore.getState()
      if (server) {
        await store.update(server.id, input)
        toast(`服务器「${name}」已保存${form.enabled ? '，正在按新配置重连' : '（已禁用）'}`)
      } else {
        const created = await store.create(input)
        toast(`服务器「${created.name}」已创建，点「测试」建立连接并注入工具`)
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `编辑 MCP 服务器「${server?.name}」` : '新建 MCP 服务器'}</DialogTitle>
          <DialogDescription>
            工具将以 <span className="font-mono">mcp__&lt;name&gt;__&lt;tool&gt;</span> 注入注册表；凭据（env /
            headers）加密存储、永不回显。保存后点「测试」连接。
          </DialogDescription>
        </DialogHeader>
        {readOnly && (
          <div className="mt-3 rounded-md border border-amber-300/60 bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-700">
            此服务器由 mcp.json 管理（只读）：请编辑配置文件后点管理台的「立即同步」，本地修改不会生效。
          </div>
        )}
        <fieldset
          disabled={readOnly}
          className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto pr-1 disabled:opacity-70"
        >
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="服务器名（slug）" hint="唯一，工具名前缀">
              <TextInput
                value={form.name}
                mono
                ariaLabel="服务器名"
                placeholder="如 filesystem"
                onChange={(v) => patch({ name: v })}
              />
            </FieldRow>
            <FieldRow label="展示名" hint="选填">
              <TextInput
                value={form.displayName}
                ariaLabel="展示名"
                placeholder="如 文件系统"
                onChange={(v) => patch({ displayName: v })}
              />
            </FieldRow>
          </div>

          <FieldRow label="传输方式">
            <div className="flex gap-2">
              {(
                [
                  ['stdio', 'stdio（本地子进程）'],
                  ['http', 'Streamable HTTP（远程端点）'],
                ] as Array<[McpTransportKind, string]>
              ).map(([kind, label]) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={form.transport === kind ? 'secondary' : 'ghost'}
                  className="border"
                  onClick={() => patch({ transport: kind })}
                >
                  {label}
                </Button>
              ))}
            </div>
          </FieldRow>

          {form.transport === 'stdio' ? (
            <>
              <FieldRow label="启动命令（command）" hint="argv 数组直接 exec，不过 shell">
                <TextInput
                  value={form.command}
                  mono
                  ariaLabel="启动命令"
                  placeholder="如 npx"
                  onChange={(v) => patch({ command: v })}
                />
              </FieldRow>
              <FieldRow label="命令参数（args）" hint="每行一个参数">
                <textarea
                  value={form.argsText}
                  rows={3}
                  aria-label="命令参数"
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/me/notes'}
                  onChange={(e) => patch({ argsText: e.target.value })}
                  className="block w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-[12px] leading-5 outline-none placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-primary/15"
                />
              </FieldRow>
              <FieldRow label="工作目录（cwd）" hint="选填，缺省 = 应用根目录">
                <TextInput
                  value={form.cwd}
                  mono
                  ariaLabel="工作目录"
                  onChange={(v) => patch({ cwd: v })}
                />
              </FieldRow>
              <FieldRow label="环境变量（env）" hint="KEY=VALUE 每行一条；加密存储，留空不修改">
                <textarea
                  value={form.envText}
                  rows={3}
                  aria-label="环境变量"
                  placeholder={'API_KEY=xxx\n# 子进程仅获得白名单基座 + 这里配置的变量'}
                  onChange={(e) => patch({ envText: e.target.value, clearSecret: false })}
                  className="block w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-[12px] leading-5 outline-none placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-primary/15"
                />
              </FieldRow>
            </>
          ) : (
            <>
              <FieldRow label="端点 URL" hint="Streamable HTTP 地址">
                <TextInput
                  value={form.url}
                  mono
                  ariaLabel="端点 URL"
                  placeholder="https://host/mcp"
                  onChange={(v) => patch({ url: v })}
                />
              </FieldRow>
              <FieldRow label="请求头（headers）" hint="KEY=VALUE 每行一条（如 Authorization）；加密存储，留空不修改">
                <textarea
                  value={form.headersText}
                  rows={3}
                  aria-label="请求头"
                  placeholder="Authorization=Bearer xxx"
                  onChange={(e) => patch({ headersText: e.target.value, clearSecret: false })}
                  className="block w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-[12px] leading-5 outline-none placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-primary/15"
                />
              </FieldRow>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="审批策略" hint="写类工具默认需审批">
              <select
                value={form.approvalPolicy}
                aria-label="审批策略"
                onChange={(e) => patch({ approvalPolicy: e.target.value as McpApprovalPolicy })}
                className="h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px] shadow-sm focus-visible:border-primary/40 focus-visible:outline-none"
              >
                <option value="risky">risky：仅写类工具触发审批</option>
                <option value="always">always：全部调用触发审批</option>
                <option value="never">never：豁免审批（谨慎）</option>
              </select>
            </FieldRow>
            <FieldRow label="只读判定" hint="readOnlyHint 缺失时的兜底">
              <select
                value={form.readOnlyOverride}
                aria-label="只读判定"
                onChange={(e) => patch({ readOnlyOverride: e.target.value as McpReadOnlyOverride })}
                className="h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px] shadow-sm focus-visible:border-primary/40 focus-visible:outline-none"
              >
                <option value="auto">auto：采信服务器注解</option>
                <option value="readonly">readonly：全部只读（可并行 + 缓存）</option>
                <option value="write">write：全部写类（串行）</option>
              </select>
            </FieldRow>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="调用超时（毫秒）" hint="选填，缺省 = 全局工具超时">
              <TextInput
                value={form.timeoutMs}
                mono
                ariaLabel="调用超时"
                placeholder="如 20000"
                onChange={(v) => patch({ timeoutMs: v.replace(/[^0-9]/g, '') })}
              />
            </FieldRow>
            <FieldRow label="启用" hint="禁用 = 断连并注销工具">
              <div className="flex h-8 items-center">
                <Switch checked={form.enabled} onChange={(v) => patch({ enabled: v })} label="启用服务器" />
                <span className="ml-2 text-[11.5px] text-muted-foreground">{form.enabled ? '启用' : '禁用'}</span>
              </div>
            </FieldRow>
          </div>

          <FieldRow label="始终加载（跳过延迟发现）" hint="M28：开启后本服务器全部工具常驻模型工具清单">
            <div className="flex h-8 items-center">
              <Switch checked={form.eagerLoad} onChange={(v) => patch({ eagerLoad: v })} label="始终加载" />
              <span className="ml-2 text-[11.5px] text-muted-foreground">
                {form.eagerLoad ? '常驻（直接进入工具清单）' : '按需（模型经 tool_search 检索激活）'}
              </span>
            </div>
          </FieldRow>

          {isEdit && server?.secretSet && (
            <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
              <span className="text-[11.5px] text-muted-foreground">
                {form.clearSecret ? '保存后将清除已存凭据' : '已保存凭据（留空 = 不修改）'}
              </span>
              <Button
                type="button"
                size="xs"
                variant={form.clearSecret ? 'secondary' : 'ghost'}
                onClick={() => patch({ clearSecret: !form.clearSecret, envText: '', headersText: '' })}
              >
                {form.clearSecret ? '取消清除' : '清除凭据'}
              </Button>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11.5px] text-destructive">
              {error}
            </div>
          )}
        </fieldset>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {readOnly ? '关闭' : '取消'}
          </Button>
          {!readOnly && (
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {isEdit ? '保存' : '创建'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
