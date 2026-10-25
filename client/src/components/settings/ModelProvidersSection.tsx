/**
 * 多 Provider：设置 · 模型与生成 → 模型服务（llm 连接专属配置区）。
 *
 * 背景：openai 协议（DeepSeek / OpenAI / 各类兼容网关）；Agent 按「名称/模型名」路由——
 * front-matter `model` 写 `deepseek/deepseek-flash` 形式（名称 = 本区块的连接名），或写清单裸名。
 * - 在本区块创建 / 编辑 / 启用（仅 admin；全局连接，不参与会话绑定）；
 * - 未配置 / 未命中时全部角色使用系统默认（env DeepSeek）；
 * - 凭据经连接中心 SecretVault 加密落库、永不回显；「测试」调 GET /models 探活；
 * - 名称不得含「/」（即模型名前缀）；同名裸名被多服务声明时以创建序先者为准。
 */
import * as React from 'react'
import { CheckCircle2, Cpu, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionDefinition, ConnectionStatus } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { useUnsavedChanges } from '../../lib/unsaved-changes'
import { useConnectionsStore } from '../../stores/connections-store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../console/fields'

/** 预设模板（仅填接入地址与建议模型清单；名称 / Key 由用户填写） */
const PRESETS: Array<{ id: string; label: string; hint: string; baseUrl: string; models: string }> = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    hint: 'api.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    models: 'deepseek-flash',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    hint: 'api.openai.com',
    baseUrl: 'https://api.openai.com/v1',
    models: 'gpt-4o, gpt-4o-mini',
  },
  { id: 'custom', label: '自定义', hint: '任意 OpenAI 兼容端点', baseUrl: '', models: '' },
]

const STATUS_DOT: Record<ConnectionStatus, string> = {
  idle: 'bg-slate-300',
  ok: 'bg-emerald-500',
  error: 'bg-rose-500',
}

/** llm 连接表单模型（config：baseUrl / models；secret：apiKey） */
interface ProviderForm {
  name: string
  baseUrl: string
  apiKey: string
  models: string
}

const EMPTY_FORM: ProviderForm = { name: '', baseUrl: '', apiKey: '', models: '' }

function formOf(connection: ConnectionDefinition): ProviderForm {
  const c = connection.config as Record<string, unknown>
  return {
    name: connection.name,
    baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '',
    // 凭据永不回显：留空 = 不修改
    apiKey: '',
    models: Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string').join(', ') : '',
  }
}

/** 解析模型清单文本（逗号 / 换行分隔；宽容去重） */
function parseModels(text: string): string[] {
  return [...new Set(text.split(/[\n,，]/).map((m) => m.trim()).filter(Boolean))]
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): React.JSX.Element {
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

/** 模型服务表单（新建 / 编辑；保存后可选立即探活） */
function ProviderForm({
  initial,
  onDone,
  onCancel,
  onDirtyChange,
}: {
  initial?: ConnectionDefinition
  onDone: () => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
}): React.JSX.Element {
  const [form, setForm] = React.useState<ProviderForm>(() => (initial ? formOf(initial) : EMPTY_FORM))
  const [saving, setSaving] = React.useState(false)
  const baseline = React.useRef(JSON.stringify(form)).current
  const dirty = JSON.stringify(form) !== baseline
  const confirmDiscard = useUnsavedChanges(dirty)
  React.useLayoutEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const patch = (p: Partial<ProviderForm>): void => setForm((f) => ({ ...f, ...p }))

  const applyPreset = (preset: (typeof PRESETS)[number]): void => {
    patch({
      baseUrl: preset.baseUrl,
      models: preset.models || form.models,
      name: form.name || preset.label,
    })
  }

  const save = async (testAfter = false): Promise<void> => {
    if (!form.name.trim()) {
      toast.error('请填写名称（作为模型名前缀，建议简短英文，如 deepseek）')
      return
    }
    if (!/^https?:\/\//i.test(form.baseUrl.trim())) {
      toast.error('接入地址需为 http(s):// 开头的合法 URL')
      return
    }
    const config: Record<string, unknown> = { baseUrl: form.baseUrl.trim() }
    const models = parseModels(form.models)
    if (models.length > 0) config.models = models
    const secret = form.apiKey ? { apiKey: form.apiKey } : undefined
    setSaving(true)
    try {
      const store = useConnectionsStore.getState()
      let savedId: string
      if (initial) {
        const saved = await store.update(initial.id, { name: form.name.trim(), config, ...(secret ? { secret } : {}) })
        savedId = saved.id
        toast('模型服务已更新')
      } else {
        const saved = await store.create({ name: form.name.trim(), kind: 'llm', config, secret })
        savedId = saved.id
        toast('模型服务已创建并启用')
      }
      onDone()
      if (testAfter) {
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
        <Cpu className="size-3.5" />
        {initial ? '编辑模型服务' : '新建模型服务'}
      </div>

      <Field label="名称" hint="（作为模型名前缀；如 deepseek）">
        <Input
          className="h-7 text-[12px]"
          value={form.name}
          placeholder="如：DeepSeek 官方"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      {!initial && (
        <div className="space-y-1">
          <span className="text-[10.5px] text-muted-foreground">预设</span>
          <div className="grid grid-cols-3 gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-left transition-colors',
                  form.baseUrl === preset.baseUrl && preset.baseUrl
                    ? 'border-primary/50 bg-primary/[0.06]'
                    : 'border-border bg-card hover:border-primary/25 hover:bg-accent/60',
                )}
              >
                <span className="flex items-center gap-1 text-[11px] font-medium">
                  {form.baseUrl === preset.baseUrl && preset.baseUrl && <CheckCircle2 className="size-3 shrink-0 text-primary" />}
                  {preset.label}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">{preset.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Field label="接入地址" hint="（openai 协议；DeepSeek 默认 https://api.deepseek.com/v1）">
        <Input
          className="h-7 font-mono text-[11.5px]"
          value={form.baseUrl}
          placeholder="https://api.deepseek.com/v1"
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
      </Field>

      <Field label="API Key" hint={initial?.secretSet ? '（留空 = 不修改；加密存储，不回显）' : '（加密存储，不回显；本地免 Key 端点可留空）'}>
        <Input
          className="h-7 font-mono text-[11.5px]"
          type="password"
          autoComplete="new-password"
          value={form.apiKey}
          placeholder={initial?.secretSet ? '••••••••' : 'sk-…'}
          onChange={(e) => patch({ apiKey: e.target.value })}
        />
      </Field>

      <Field label="模型清单" hint="（逗号分隔；Agent 以「名称/模型名」或清单裸名引用）">
        <Input
          className="h-7 font-mono text-[11.5px]"
          value={form.models}
          placeholder="deepseek-flash, deepseek-v4-pro"
          onChange={(e) => patch({ models: e.target.value })}
        />
      </Field>

      <div className="flex items-center gap-1.5 pt-0.5">
        <Button size="xs" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
          保存
        </Button>
        <Button size="xs" variant="secondary" disabled={saving} title="保存后立即探活（GET /models）" onClick={() => void save(true)}>
          <Play className="mr-1 size-3" />
          保存并测试
        </Button>
        <Button size="xs" variant="ghost" disabled={saving} onClick={() => { if (confirmDiscard()) onCancel() }}>
          取消
        </Button>
      </div>
    </div>
  )
}

/** 模型服务卡片：启用开关 / 测试 / 编辑 / 删除（含角色引用提示） */
function ProviderCard({
  connection,
  busy,
  onEdit,
}: {
  connection: ConnectionDefinition
  busy: boolean
  onEdit: () => void
}): React.JSX.Element {
  const [testing, setTesting] = React.useState(false)
  const c = connection.config as Record<string, unknown>
  const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl : ''
  const models = Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string') : []

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

  const toggleEnabled = async (enabled: boolean): Promise<void> => {
    try {
      await useConnectionsStore.getState().update(connection.id, { enabled })
      toast(enabled ? '已启用（模型清单立即参与路由）' : '已停用（命中清单的模型名回退系统默认）')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`删除模型服务「${connection.name}」？其凭据将一并清除；以本服务为前缀或命中其清单的模型名将回退系统默认。`)) return
    try {
      await useConnectionsStore.getState().remove(connection.id)
      toast('模型服务已删除')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-2.5 shadow-soft">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">
          <Cpu className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{connection.name}</span>
        <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[connection.status])} title={connection.lastError ?? connection.status} />
        <span className="shrink-0 rounded-full border px-1.5 py-px text-[9.5px] text-muted-foreground">openai 协议</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
        <span className="max-w-full truncate font-mono">{baseUrl}</span>
        {models.length > 0 && <span>{models.length} 个模型</span>}
        {!connection.enabled && <span className="text-rose-600">已停用</span>}
      </div>

      {connection.lastError && (
        <p className="mt-1 line-clamp-2 rounded-md bg-rose-50 px-1.5 py-1 text-[10.5px] text-rose-700">{connection.lastError}</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch checked={connection.enabled} disabled={busy} label={`启用「${connection.name}」`} onChange={(v) => void toggleEnabled(v)} />
          {connection.enabled ? '启用' : '停用'}
        </span>
        <Button size="xs" variant="outline" disabled={testing || busy} onClick={() => void test()}>
          {testing ? <Loader2 className="size-3 animate-spin" /> : '测试'}
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onEdit} title="编辑">
          <Pencil className="size-3" />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto text-rose-600 hover:text-rose-700"
          disabled={busy}
          title="删除连接（凭据同时清除）"
          onClick={() => void remove()}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  )
}

/** 设置页「模型与生成 → 模型服务」区块主体（清单 + 新建 / 编辑） */
export function ModelProvidersSection(): React.JSX.Element {
  const connections = useConnectionsStore((s) => s.connections)
  const loading = useConnectionsStore((s) => s.loading)
  const busyId = useConnectionsStore((s) => s.busyId)
  const [creating, setCreating] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [formDirty, setFormDirty] = React.useState(false)
  const canSwitch = (): boolean => !formDirty || window.confirm('有未保存的模型服务修改，确定放弃并切换吗？')

  // 清单拉取（幂等；与「媒体生成」分组共用 store）
  React.useEffect(() => {
    void useConnectionsStore.getState().load()
  }, [])

  const providers = React.useMemo(
    () => connections.filter((c) => c.kind === 'llm').sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  )
  const editing = editingId ? providers.find((c) => c.id === editingId) : undefined

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">
          {loading && providers.length === 0
            ? '正在加载模型服务…'
            : providers.length === 0
              ? '未配置：全部角色使用系统默认（DeepSeek）'
              : `已配置 ${providers.length} 个模型服务`}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          onClick={() => {
            if (!canSwitch()) return
            setEditingId(null)
            setCreating(true)
          }}
        >
          <Plus className="size-3" />
          新建模型服务
        </Button>
      </div>

      {creating && <ProviderForm onDirtyChange={setFormDirty} onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />}
      {!creating && editing && <ProviderForm key={editing.id} initial={editing} onDirtyChange={setFormDirty} onDone={() => setEditingId((id) => id === editing.id ? null : id)} onCancel={() => setEditingId(null)} />}

      {providers.length === 0 && !creating && !(loading && providers.length === 0) && (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-[11.5px] leading-5 text-muted-foreground">
          <Cpu className="float-soft mx-auto mb-2 size-5 text-primary/40" />
          还没有模型服务。不配置时全部角色使用系统默认（DeepSeek）；
          <br />
          创建后，Agent 以「名称/模型名」（如 deepseek/deepseek-flash）引用即经由此服务调用。
        </div>
      )}

      {providers.length > 0 && (
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {providers.map((connection) => (
            <ProviderCard
              key={connection.id}
              connection={connection}
              busy={busyId === connection.id}
              onEdit={() => {
                if (editingId !== connection.id && !canSwitch()) return
                setCreating(false)
                setEditingId(connection.id)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
