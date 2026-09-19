/**
 * M26：连接管理（资产控制台视图；自右栏「连接」面板迁入）。
 * 连接是全局资源（不随会话切换），统一收进左侧 rail 菜单管理维护；
 * - 连接清单：PostgreSQL / MySQL / SQLite / SSH（密码 / 私钥 / agent + 保存并测试）+ 浏览器（CDP）+ 嵌入模型；
 *   数据库连接可直达「数据库」工作台，SSH 连接可开「终端」页签；测试连通性、会话绑定/解绑、编辑删除；
 * - 操作流：connection/db/browser/ssh 动作的实时可视化（notify:op）+ 历史回放（/api/audit）；
 * - 安全：凭据只写不读（secretSet 标记），写入走服务端 AES-256-GCM 加密存储。
 * - M56：媒体生成迁入「设置 → 媒体生成」（全局连接，不参与会话绑定）——本视图不再呈现 / 创建媒体连接；
 *   M36 的媒体表单专业化（提供方卡片 / 能力矩阵 / 工作流编辑器）随迁至 settings/MediaConnectionsSection。
 */
import * as React from 'react'
import {
  Cable,
  CheckCircle2,
  Chrome,
  Clapperboard,
  Database,
  ExternalLink,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Terminal,
  Trash2,
  Unlink,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionDefinition, ConnectionKind, ConnectionStatus } from '@multi-agent/shared'
import { useConnectionsStore } from '../../stores/connections-store'
import { useDatabaseStore } from '../../stores/database-store'
import { useSessionStore } from '../../stores/session-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useUiStore } from '../../stores/ui-store'
import { formatClock } from '../../lib/time'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const KIND_META: Record<ConnectionKind, { label: string; icon: React.ReactNode; hint: string }> = {
  postgres: { label: 'PostgreSQL', icon: <Database className="size-3.5" />, hint: 'host:5432' },
  mysql: { label: 'MySQL', icon: <Database className="size-3.5" />, hint: 'host:3306' },
  sqlite: { label: 'SQLite', icon: <Database className="size-3.5" />, hint: '本地文件' },
  chrome: { label: '浏览器', icon: <Chrome className="size-3.5" />, hint: 'CDP 接入' },
  ssh: { label: 'SSH', icon: <Terminal className="size-3.5" />, hint: 'host:22' },
  embedding: { label: '嵌入模型', icon: <Sparkles className="size-3.5" />, hint: '向量记忆' },
  // M56：媒体生成已迁「设置 → 媒体生成」（本视图不呈现 / 不创建；元数据保留以维持 ConnectionKind 完整映射）
  media: { label: '媒体生成', icon: <Clapperboard className="size-3.5" />, hint: '已迁至设置' },
}

/** 可创建的连接类型（M56：媒体生成迁入「设置」后不再在此创建） */
const CREATE_KINDS = (Object.keys(KIND_META) as ConnectionKind[]).filter((k) => k !== 'media')

const STATUS_DOT: Record<ConnectionStatus, string> = {
  idle: 'bg-slate-300',
  ok: 'bg-emerald-500',
  error: 'bg-rose-500',
}

interface FormState {
  name: string
  host: string
  port: string
  database: string
  username: string
  password: string
  path: string
  readOnly: boolean
  allowWrites: boolean
  ssl: '' | 'require' | 'no-verify'
  backend: 'managed' | 'local' | 'remote'
  executable: string
  endpoint: string
  startUrl: string
  /** 启动形态：true=无头（默认）/ false=打开可见窗口 */
  headless: boolean
  /** M23 SSH：认证方式 / 私钥路径 / 粘贴私钥 / 口令 / 允许 Agent 执行 */
  authMethod: 'password' | 'key' | 'agent'
  privateKeyPath: string
  privateKey: string
  passphrase: string
  allowExec: boolean
  /** M25 嵌入（embedding）：OpenAI 兼容端点 + 模型凭据 */
  baseUrl: string
  model: string
  apiKey: string
  dim: string
  batchSize: string
  timeoutMs: string
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '127.0.0.1',
  port: '',
  database: '',
  username: '',
  password: '',
  path: '',
  readOnly: true,
  allowWrites: false,
  ssl: '',
  backend: 'local',
  executable: '',
  endpoint: '',
  startUrl: '',
  headless: true,
  authMethod: 'password',
  privateKeyPath: '',
  privateKey: '',
  passphrase: '',
  allowExec: false,
  baseUrl: '',
  model: '',
  apiKey: '',
  dim: '',
  batchSize: '',
  timeoutMs: '',
}

function formOf(connection?: ConnectionDefinition): FormState {
  if (!connection) return { ...EMPTY_FORM }
  const c = connection.config as Record<string, unknown>
  const str = (key: string): string => (typeof c[key] === 'string' ? (c[key] as string) : '')
  return {
    ...EMPTY_FORM,
    name: connection.name,
    host: str('host') || '127.0.0.1',
    port: c.port !== undefined ? String(c.port) : '',
    database: str('database'),
    username: str('username'),
    path: str('path'),
    readOnly: c.readOnly !== false,
    allowWrites: c.allowWrites === true,
    ssl: c.ssl === true || c.ssl === 'require' ? 'require' : c.ssl === 'no-verify' ? 'no-verify' : '',
    backend: c.backend === 'managed' ? 'managed' : c.backend === 'remote' ? 'remote' : 'local',
    executable: str('executable'),
    endpoint: str('endpoint'),
    startUrl: str('startUrl'),
    headless: c.headless !== false, // 缺省 = 无头（全局 BROWSER_HEADLESS 一致）
    authMethod: c.authMethod === 'key' ? 'key' : c.authMethod === 'agent' ? 'agent' : 'password',
    privateKeyPath: str('privateKeyPath'),
    allowExec: c.allowExec === true,
    // M25 嵌入：dim / batchSize / timeoutMs 留空 = 服务端默认（dim 空 = 探测）
    baseUrl: str('baseUrl'),
    model: str('model'),
    dim: c.dim !== undefined ? String(c.dim) : '',
    batchSize: c.batchSize !== undefined ? String(c.batchSize) : '',
    timeoutMs: c.timeoutMs !== undefined ? String(c.timeoutMs) : '',
    // password / privateKey / passphrase / apiKey 凭据永不回显（加密存储），留空 = 不修改
  }
}

/** 表单值 → 服务端 config / secret（password 空串 = 不修改既有凭据） */
function payloadOf(kind: ConnectionKind, form: FormState): { config: Record<string, unknown>; secret?: Record<string, unknown> | null } {
  if (kind === 'postgres' || kind === 'mysql') {
    const config: Record<string, unknown> = {
      host: form.host.trim() || '127.0.0.1',
      port: form.port.trim() ? Number(form.port) : kind === 'postgres' ? 5432 : 3306,
      database: form.database.trim(),
      username: form.username.trim() || (kind === 'postgres' ? 'postgres' : 'root'),
      readOnly: form.readOnly,
      allowWrites: form.allowWrites,
    }
    if (form.ssl) config.ssl = form.ssl
    return {
      config,
      secret: form.password ? { password: form.password } : undefined,
    }
  }
  if (kind === 'sqlite') {
    return { config: { path: form.path.trim(), readOnly: form.readOnly, allowWrites: form.allowWrites } }
  }
  if (kind === 'chrome') {
    const config: Record<string, unknown> = { backend: form.backend, headless: form.headless }
    if (form.executable.trim()) config.executable = form.executable.trim()
    if (form.endpoint.trim()) config.endpoint = form.endpoint.trim()
    if (form.startUrl.trim()) config.startUrl = form.startUrl.trim()
    return { config }
  }
  if (kind === 'ssh') {
    const config: Record<string, unknown> = {
      host: form.host.trim() || '127.0.0.1',
      port: form.port.trim() ? Number(form.port) : 22,
      username: form.username.trim(),
      authMethod: form.authMethod,
      allowExec: form.allowExec,
    }
    if (form.authMethod === 'key' && form.privateKeyPath.trim()) config.privateKeyPath = form.privateKeyPath.trim()
    // 凭据：留空 = 不修改（服务端 secret 字段缺省即保留旧值）
    const secret: Record<string, unknown> = {}
    if (form.authMethod === 'password' && form.password) secret.password = form.password
    if (form.authMethod === 'key' && form.privateKey.trim()) secret.privateKey = form.privateKey.trim()
    if (form.authMethod === 'key' && form.passphrase) secret.passphrase = form.passphrase
    return { config, secret: Object.keys(secret).length > 0 ? secret : undefined }
  }
  if (kind === 'embedding') {
    const config: Record<string, unknown> = { model: form.model.trim() }
    if (form.baseUrl.trim()) config.baseUrl = form.baseUrl.trim()
    if (form.dim.trim()) config.dim = Number(form.dim)
    if (form.batchSize.trim()) config.batchSize = Number(form.batchSize)
    if (form.timeoutMs.trim()) config.timeoutMs = Number(form.timeoutMs)
    return { config, secret: form.apiKey ? { apiKey: form.apiKey } : undefined }
  }
  return { config: {} }
}

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        {label}
        {hint && <span className="text-muted-foreground/70">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** 新建 / 编辑表单（内联卡片，不占弹窗；窄栏适配） */
function ConnectionForm({
  kind,
  initial,
  onDone,
  onCancel,
}: {
  kind: ConnectionKind
  initial?: ConnectionDefinition
  onDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [form, setForm] = React.useState<FormState>(() => formOf(initial))
  const [saving, setSaving] = React.useState(false)
  const patch = (next: Partial<FormState>): void => setForm((f) => ({ ...f, ...next }))
  const isDb = kind === 'postgres' || kind === 'mysql'

  const save = async (testAfter = false): Promise<void> => {
    if (!form.name.trim()) {
      toast.error('请填写连接名称')
      return
    }
    if (kind === 'sqlite' && !form.path.trim()) {
      toast.error('请填写 SQLite 文件绝对路径')
      return
    }
    if (isDb && !form.database.trim()) {
      toast.error('请填写数据库名')
      return
    }
    if (kind === 'ssh') {
      if (!form.username.trim()) {
        toast.error('请填写登录用户名')
        return
      }
      if (form.authMethod === 'password' && !form.password && !initial?.secretSet) {
        toast.error('请填写登录密码')
        return
      }
      if (form.authMethod === 'key' && !form.privateKeyPath.trim() && !form.privateKey.trim() && !initial?.secretSet) {
        toast.error('私钥认证需填写文件路径，或粘贴私钥内容')
        return
      }
    }
    if (kind === 'embedding' && !form.model.trim()) {
      toast.error('请填写嵌入模型名（如 text-embedding-3-small）')
      return
    }
    setSaving(true)
    try {
      const { config, secret } = payloadOf(kind, form)
      const store = useConnectionsStore.getState()
      let savedId: string | undefined
      if (initial) {
        const saved = await store.update(initial.id, { name: form.name.trim(), config, secret: secret ?? undefined })
        savedId = saved.id
        toast('连接已更新')
      } else {
        const saved = await store.create({ name: form.name.trim(), kind, config, secret: secret ?? undefined })
        savedId = saved.id
        toast('连接已创建')
      }
      onDone()
      // 保存并测试（Navicat 习惯）：关闭表单后回显测试结果
      if (testAfter && savedId) {
        const result = await useConnectionsStore.getState().test(savedId)
        if (result.ok) {
          toast.success(`连接正常${result.latencyMs ? `（${result.latencyMs}ms）` : ''}${result.detail ? ` · ${result.detail}` : ''}`)
        } else {
          toast.error(result.error ?? result.detail ?? '连接失败')
        }
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/[0.03] p-2.5">
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
        {KIND_META[kind].icon}
        {initial ? '编辑连接' : `新建${KIND_META[kind].label}连接`}
      </div>
      <Field label="名称">
        <Input
          className="h-7 text-[12px]"
          value={form.name}
          placeholder="如：生产只读库"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      {(kind === 'postgres' || kind === 'mysql') && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <div className="col-span-2">
              <Field label="主机">
                <Input className="h-7 text-[12px]" value={form.host} onChange={(e) => patch({ host: e.target.value })} />
              </Field>
            </div>
            <Field label="端口">
              <Input
                className="h-7 text-[12px]"
                value={form.port}
                placeholder={kind === 'postgres' ? '5432' : '3306'}
                onChange={(e) => patch({ port: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="数据库">
              <Input
                className="h-7 text-[12px]"
                value={form.database}
                placeholder={initial ? undefined : 'database'}
                onChange={(e) => patch({ database: e.target.value })}
              />
            </Field>
            <Field label="用户名">
              <Input className="h-7 text-[12px]" value={form.username} onChange={(e) => patch({ username: e.target.value })} />
            </Field>
          </div>
          <Field label="密码" hint={initial?.secretSet ? '（留空 = 不修改）' : ''}>
            <Input
              className="h-7 text-[12px]"
              type="password"
              autoComplete="new-password"
              value={form.password}
              placeholder={initial?.secretSet ? '••••••••' : '数据库密码'}
              onChange={(e) => patch({ password: e.target.value })}
            />
          </Field>
          <Field label="SSL">
            <select
              className="h-7 w-full rounded-md border border-input bg-card px-2 text-[12px]"
              value={form.ssl}
              onChange={(e) => patch({ ssl: e.target.value as FormState['ssl'] })}
            >
              <option value="">不启用</option>
              <option value="require">启用（校验证书）</option>
              <option value="no-verify">启用（不校验证书）</option>
            </select>
          </Field>
        </>
      )}

      {kind === 'sqlite' && (
        <Field label="文件路径" hint="（绝对路径，不会自动建库）">
          <Input
            className="h-7 font-mono text-[11.5px]"
            value={form.path}
            placeholder="/Users/me/data/app.db"
            onChange={(e) => patch({ path: e.target.value })}
          />
        </Field>
      )}

      {kind === 'chrome' && (
        <>
          <Field label="接入方式">
            <select
              className="h-7 w-full rounded-md border border-input bg-card px-2 text-[12px]"
              value={form.backend}
              onChange={(e) => patch({ backend: e.target.value as FormState['backend'] })}
            >
              <option value="managed">managed（独立实例，临时配置）</option>
              <option value="local">local（本机 Chrome，专用配置目录）</option>
              <option value="remote">remote（接入已有调试端点）</option>
            </select>
          </Field>
          {form.backend === 'remote' ? (
            <Field label="调试端点" hint="（http://host:9222 或 ws://…）">
              <Input
                className="h-7 font-mono text-[11.5px]"
                value={form.endpoint}
                placeholder="http://127.0.0.1:9222"
                onChange={(e) => patch({ endpoint: e.target.value })}
              />
            </Field>
          ) : (
            <Field label="浏览器可执行文件" hint="（留空 = 自动发现）">
              <Input
                className="h-7 font-mono text-[11.5px]"
                value={form.executable}
                placeholder="/Applications/Google Chrome.app/…"
                onChange={(e) => patch({ executable: e.target.value })}
              />
            </Field>
          )}
          {form.backend !== 'remote' && (
            <label className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={form.headless}
                onChange={(e) => patch({ headless: e.target.checked })}
              />
              无头模式（默认；取消 = 打开可见窗口）
            </label>
          )}
          <Field label="初始地址" hint="（可选）">
            <Input
              className="h-7 font-mono text-[11.5px]"
              value={form.startUrl}
              placeholder="https://example.com"
              onChange={(e) => patch({ startUrl: e.target.value })}
            />
          </Field>
        </>
      )}

      {kind === 'ssh' && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <div className="col-span-2">
              <Field label="主机">
                <Input
                  className="h-7 font-mono text-[12px]"
                  value={form.host}
                  placeholder="10.0.0.8 或 example.com"
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </Field>
            </div>
            <Field label="端口">
              <Input
                className="h-7 text-[12px]"
                value={form.port}
                placeholder="22"
                onChange={(e) => patch({ port: e.target.value })}
              />
            </Field>
          </div>
          <Field label="用户名">
            <Input
              className="h-7 text-[12px]"
              value={form.username}
              placeholder="root / deploy"
              onChange={(e) => patch({ username: e.target.value })}
            />
          </Field>
          <Field label="认证方式">
            <select
              className="h-7 w-full rounded-md border border-input bg-card px-2 text-[12px]"
              value={form.authMethod}
              onChange={(e) => patch({ authMethod: e.target.value as FormState['authMethod'] })}
            >
              <option value="password">密码</option>
              <option value="key">私钥文件（路径 / 粘贴内容）</option>
              <option value="agent">SSH Agent（本机 ssh-agent）</option>
            </select>
          </Field>

          {form.authMethod === 'password' && (
            <Field label="密码" hint={initial?.secretSet ? '（留空 = 不修改）' : ''}>
              <Input
                className="h-7 text-[12px]"
                type="password"
                autoComplete="new-password"
                value={form.password}
                placeholder={initial?.secretSet ? '••••••••' : '登录密码'}
                onChange={(e) => patch({ password: e.target.value })}
              />
            </Field>
          )}

          {form.authMethod === 'key' && (
            <>
              <Field label="私钥文件路径" hint="（可选；~ 展开为用户主目录，由服务端读取）">
                <Input
                  className="h-7 font-mono text-[11.5px]"
                  value={form.privateKeyPath}
                  placeholder="~/.ssh/id_ed25519"
                  onChange={(e) => patch({ privateKeyPath: e.target.value })}
                />
              </Field>
              <Field label="私钥内容" hint={initial?.secretSet ? '（粘贴优先于路径；留空 = 不修改）' : '（粘贴 PEM，存为加密凭据）'}>
                <textarea
                  className="h-16 w-full resize-y rounded-md border border-input bg-card px-2 py-1 font-mono text-[10.5px] leading-4"
                  value={form.privateKey}
                  spellCheck={false}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  onChange={(e) => patch({ privateKey: e.target.value })}
                />
              </Field>
              <Field label="密钥口令 Passphrase" hint={initial?.secretSet ? '（留空 = 不修改）' : '（可选）'}>
                <Input
                  className="h-7 text-[12px]"
                  type="password"
                  autoComplete="new-password"
                  value={form.passphrase}
                  placeholder={initial?.secretSet ? '••••••••' : '无口令可留空'}
                  onChange={(e) => patch({ passphrase: e.target.value })}
                />
              </Field>
            </>
          )}

          <label className="flex items-start gap-1.5 pt-0.5 text-[11px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.allowExec}
              onChange={(e) => patch({ allowExec: e.target.checked })}
            />
            <span>允许 Agent 执行命令（ssh_exec）</span>
          </label>
        </>
      )}

      {kind === 'embedding' && (
        <>
          <Field label="API 地址" hint="（OpenAI 兼容；留空 = 官方 OpenAI）">
            <Input
              className="h-7 font-mono text-[11.5px]"
              value={form.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="模型">
              <Input
                className="h-7 font-mono text-[11.5px]"
                value={form.model}
                placeholder="text-embedding-3-small"
                onChange={(e) => patch({ model: e.target.value })}
              />
            </Field>
            <Field label="维度" hint="（留空 = 探测）">
              <Input
                className="h-7 text-[12px]"
                value={form.dim}
                placeholder="自动"
                onChange={(e) => patch({ dim: e.target.value })}
              />
            </Field>
          </div>
          <Field label="API Key" hint={initial?.secretSet ? '（留空 = 不修改）' : '（加密存储，不回显）'}>
            <Input
              className="h-7 text-[12px]"
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              placeholder={initial?.secretSet ? '••••••••' : 'sk-…（Ollama 等本地端点可留空）'}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="批量大小" hint="（可选）">
              <Input
                className="h-7 text-[12px]"
                value={form.batchSize}
                placeholder="16"
                onChange={(e) => patch({ batchSize: e.target.value })}
              />
            </Field>
            <Field label="超时 ms" hint="（可选）">
              <Input
                className="h-7 text-[12px]"
                value={form.timeoutMs}
                placeholder="15000"
                onChange={(e) => patch({ timeoutMs: e.target.value })}
              />
            </Field>
          </div>
          <p className="rounded-md border border-dashed px-2 py-1.5 text-[10.5px] text-muted-foreground">
            供「向量记忆」语义召回使用，不参与会话绑定。「保存并测试」会真实调用端点探测模型与维度，随后在「设置 → 向量记忆」中选中启用。
          </p>
        </>
      )}

      {kind !== 'chrome' && kind !== 'ssh' && kind !== 'embedding' && (
        <div className="space-y-1 pt-0.5">
          <label className="flex items-center gap-1.5 text-[11px]">
            <input type="checkbox" checked={form.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })} />
            只读模式（默认；查询走只读事务）
          </label>
          <label className="flex items-center gap-1.5 text-[11px]">
            <input type="checkbox" checked={form.allowWrites} onChange={(e) => patch({ allowWrites: e.target.checked })} />
            允许写操作（需审批；仅 db_execute 生效）
          </label>
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-0.5">
        <Button size="xs" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
          保存
        </Button>
        <Button size="xs" variant="secondary" disabled={saving} title="保存后立即测试连通性" onClick={() => void save(true)}>
          <Play className="mr-1 size-3" />
          保存并测试
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  )
}

function ConnectionCard({
  connection,
  bound,
  busy,
  hasSession,
  onEdit,
}: {
  connection: ConnectionDefinition
  bound: boolean
  busy: boolean
  hasSession: boolean
  onEdit: () => void
}): React.JSX.Element {
  const meta = KIND_META[connection.kind]
  const [testing, setTesting] = React.useState(false)
  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await useConnectionsStore.getState().test(connection.id)
      if (result.ok) toast.success(`连接正常${result.latencyMs ? `（${result.latencyMs}ms）` : ''}${result.detail ? ` · ${result.detail}` : ''}`)
      else toast.error(result.error ?? result.detail ?? '连接失败')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setTesting(false)
    }
  }
  const toggleBind = async (): Promise<void> => {
    try {
      if (bound) await useConnectionsStore.getState().unbind(connection.id)
      else await useConnectionsStore.getState().bind(connection.id)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-2.5 shadow-soft">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{meta.icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{connection.name}</span>
        <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[connection.status])} title={connection.lastError ?? connection.status} />
        <span className="shrink-0 rounded-full border px-1.5 py-px text-[9.5px] text-muted-foreground">{meta.label}</span>
        {connection.secretSet && (
          <span className="shrink-0 text-muted-foreground" title="已保存加密凭据">
            <Lock className="size-3" />
          </span>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
        {connection.kind === 'postgres' || connection.kind === 'mysql' ? (
          <span className="font-mono">
            {String(connection.config.host ?? '127.0.0.1')}:{String(connection.config.port ?? '')}/{String(connection.config.database ?? '')}
          </span>
        ) : connection.kind === 'sqlite' ? (
          <span className="max-w-full truncate font-mono">{String(connection.config.path ?? '')}</span>
        ) : connection.kind === 'chrome' ? (
          <span className="font-mono">
            {String(connection.config.backend ?? 'local')}
            {connection.config.endpoint ? ` · ${String(connection.config.endpoint)}` : ''}
          </span>
        ) : connection.kind === 'ssh' ? (
          <span className="max-w-full truncate font-mono">
            {connection.config.username ? `${String(connection.config.username)}@` : ''}
            {String(connection.config.host ?? '127.0.0.1')}:{String(connection.config.port ?? 22)}
          </span>
        ) : connection.kind === 'embedding' ? (
          <span className="max-w-full truncate font-mono">
            {String(connection.config.model ?? '')}
            {connection.config.dim ? ` · ${String(connection.config.dim)}d` : ''}
          </span>
        ) : null}
        {connection.config.allowWrites === true && <span className="text-amber-600">允许写入</span>}
        {connection.kind === 'chrome' && connection.config.backend !== 'remote' && connection.config.headless === false && (
          <span className="text-amber-600">打开窗口</span>
        )}
        {connection.kind === 'ssh' && connection.config.allowExec === true && <span className="text-amber-600">允许执行命令</span>}
        {!connection.enabled && <span className="text-rose-600">已禁用</span>}
      </div>

      {connection.lastError && (
        <p className="mt-1 line-clamp-2 rounded-md bg-rose-50 px-1.5 py-1 text-[10.5px] text-rose-700">{connection.lastError}</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Button size="xs" variant="outline" disabled={testing || busy} onClick={() => void test()}>
          {testing ? <Loader2 className="size-3 animate-spin" /> : '测试'}
        </Button>
        {(connection.kind === 'postgres' || connection.kind === 'mysql' || connection.kind === 'sqlite') && (
          <Button
            size="xs"
            variant="outline"
            title="在「数据库」工作台打开"
            onClick={() => {
              useDatabaseStore.getState().select(connection.id)
              useUiStore.getState().expandWorkspace('database')
            }}
          >
            <ExternalLink className="size-3" />
            打开
          </Button>
        )}
        {connection.kind === 'ssh' && (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            title="打开 SSH 终端（新会话）"
            onClick={() => {
              useUiStore.getState().expandWorkspace('terminal')
              void useTerminalStore.getState().open(connection)
            }}
          >
            <Terminal className="size-3" />
            终端
          </Button>
        )}
        {hasSession && connection.kind !== 'embedding' && connection.kind !== 'media' && (
          <Button size="xs" variant={bound ? 'secondary' : 'outline'} disabled={busy} title={bound ? '解绑：该会话将不可用此连接' : '绑定到当前会话（Agent 工具可见）'} onClick={() => void toggleBind()}>
            {bound ? <Unlink className="size-3" /> : <Link2 className="size-3" />}
            {bound ? '解绑' : '绑定'}
          </Button>
        )}
        <Button size="xs" variant="ghost" disabled={busy} onClick={onEdit} title="编辑">
          <Pencil className="size-3" />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto text-rose-600 hover:text-rose-700"
          disabled={busy}
          title="删除连接（凭据同时清除）"
          onClick={() => {
            if (!window.confirm(`删除连接「${connection.name}」？其凭据将一并清除。`)) return
            void useConnectionsStore
              .getState()
              .remove(connection.id)
              .then(() => toast('连接已删除'))
              .catch((err: Error) => toast.error(err.message))
          }}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  )
}

function OpFeed(): React.JSX.Element {
  const ops = useConnectionsStore((s) => s.ops)
  const sessionId = useConnectionsStore((s) => s.sessionId)
  const refresh = (): void => {
    if (sessionId) void useConnectionsStore.getState().loadForSession(sessionId)
  }
  return (
    <div className="space-y-1 p-2">
      <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        <span>最近操作（连接 / 数据库 / 浏览器）</span>
        <Button size="xs" variant="ghost" className="ml-auto" title="刷新" onClick={refresh}>
          <RefreshCw className="size-3" />
        </Button>
      </div>
      {ops.length === 0 && <p className="px-1 py-6 text-center text-[11.5px] text-muted-foreground">暂无操作记录</p>}
      {ops.map((op) => (
        <div key={op.id} className="flex items-start gap-1.5 rounded-lg border bg-card px-2 py-1.5">
          <span className="mt-px shrink-0">
            {op.status === 'running' ? (
              <Loader2 className="size-3 animate-spin text-amber-500" />
            ) : op.status === 'ok' ? (
              <CheckCircle2 className="size-3 text-emerald-600" />
            ) : (
              <XCircle className="size-3 text-rose-600" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11.5px]">
              <span className="font-mono text-[10.5px] text-muted-foreground">{formatClock(op.ts)}</span>
              <span className="shrink-0 rounded-full border px-1.5 text-[9.5px] text-muted-foreground">
                {op.actor === 'user' ? '你' : op.actor}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{op.action}</span>
              {op.durationMs !== undefined && (
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                  {op.durationMs >= 1000 ? `${(op.durationMs / 1000).toFixed(1)}s` : `${op.durationMs}ms`}
                </span>
              )}
            </div>
            {(op.summary || op.target) && (
              <p className="mt-0.5 line-clamp-2 break-all text-[10.5px] text-muted-foreground">
                {op.summary ?? op.target}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ConnectionsConsole(): React.JSX.Element {
  const sessionId = useSessionStore((s) => s.currentId)
  const connections = useConnectionsStore((s) => s.connections)
  const bindings = useConnectionsStore((s) => s.bindings)
  const busyId = useConnectionsStore((s) => s.busyId)
  const [tab, setTab] = React.useState<'list' | 'ops'>('list')
  const [creating, setCreating] = React.useState<ConnectionKind | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const store = useConnectionsStore.getState()
    if (sessionId) void store.loadForSession(sessionId)
    else void store.load()
  }, [sessionId])

  // M56：媒体连接的「直达编辑」消费已随表单迁至「设置 → 媒体生成」（settings/MediaConnectionsSection）。

  const boundIds = React.useMemo(() => new Set(bindings.map((b) => b.connection.id)), [bindings])
  // M56：媒体生成连接（kind = 'media'）在「设置 → 媒体生成」维护，本视图不呈现
  const sorted = React.useMemo(
    () =>
      [...connections]
        .filter((c) => c.kind !== 'media')
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    [connections],
  )
  const editing = editingId ? sorted.find((c) => c.id === editingId) : undefined

  const openCreate = (): void => {
    setTab('list')
    setEditingId(null)
    setCreating('postgres')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Cable className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold">连接管理</span>
        <span className="text-[11px] text-muted-foreground">{sorted.length} 个连接</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" title="新建连接" onClick={openCreate}>
            <Plus className="size-3.5" />
            新建连接
          </Button>
        </div>
      </div>

      {/* 分段：连接清单 / 操作流水 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
        {(['list', 'ops'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              tab === key ? 'border-primary/40 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-accent/70',
            )}
            onClick={() => setTab(key)}
          >
            {key === 'list' ? `连接（${sorted.length}）` : '操作'}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === 'ops' ? (
          <div className="mx-auto max-w-3xl">
            <OpFeed />
          </div>
        ) : (
          <div className="space-y-3">
            {creating && (
              <div className="max-w-3xl space-y-1.5">
                <div className="flex flex-wrap items-center gap-1">
                  {CREATE_KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={cn(
                        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] transition-colors',
                        creating === k ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/70',
                      )}
                      onClick={() => setCreating(k)}
                    >
                      {KIND_META[k].icon}
                      {KIND_META[k].label}
                    </button>
                  ))}
                </div>
                <ConnectionForm kind={creating} onDone={() => setCreating(null)} onCancel={() => setCreating(null)} />
              </div>
            )}

            {!creating && editing && (
              <div className="max-w-3xl">
                <ConnectionForm
                  kind={editing.kind}
                  initial={editing}
                  onDone={() => setEditingId(null)}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            )}

            {sorted.length === 0 && !creating && (
              <div className="rounded-lg border border-dashed px-4 py-16 text-center text-[12px] text-muted-foreground">
                <Database className="float-soft mx-auto mb-2 size-6 text-primary/40" />
                还没有连接
              </div>
            )}

            {sorted.length > 0 && (
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
                {sorted.map((connection) => (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    bound={boundIds.has(connection.id)}
                    busy={busyId === connection.id}
                    hasSession={!!sessionId}
                    onEdit={() => {
                      setCreating(null)
                      setEditingId(connection.id)
                    }}
                  />
                ))}
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  )
}
