/**
 * M56：设置 · 媒体生成（自「连接管理」迁入的媒体连接专属配置区）。
 *
 * 背景（M31 → M56）：媒体连接不再参与会话绑定，与主模型 / 嵌入模型同为全局能力——
 * - 在本分组创建 / 编辑 / 启用（启用即总开关；停用后画布生成面板与 Agent 工具立即不可用）；
 * - 服务端 MediaService 按「全局启用中的连接」解析（生成面板 / media_generate / media_video 共用）；
 * - M36 媒体表单专业化原样迁入：提供方卡片 / 能力矩阵 / 工作流与模板编辑器（实时校验 + 一键格式化）；
 * - 消费画布生成面板的「直达编辑」请求（pendingEditId，媒体清单就绪后打开对应连接编辑表单）。
 */
import * as React from 'react'
import { CheckCircle2, Clapperboard, Loader2, Pencil, Play, Plus, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import type {
  ConnectionDefinition,
  ConnectionStatus,
  MediaCapability,
  MediaProviderKind,
  MediaWorkflowTemplate,
  TaskApiTemplate,
} from '@multi-agent/shared'
import { CAPABILITY_LABEL } from '../../lib/media'
import { cn } from '../../lib/utils'
import { useConnectionsStore } from '../../stores/connections-store'
import { useMediaStore } from '../../stores/media-store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../console/fields'

/** 媒体连接清单变更 → 重拉全局 providers（画布能力门控与生成面板共用的判定源） */
function syncMediaProviders(): void {
  void useMediaStore.getState().refreshProviders()
}

/** M31 媒体生成：提供方注册表（与 shared MediaProviderKind / 服务端四适配器一一对应）。
 *  M36：补充提供方卡片与能力矩阵。 */
const MEDIA_PROVIDERS: Record<
  MediaProviderKind,
  { label: string; hint: string; capabilities: MediaCapability[] }
> = {
  comfyui: {
    label: 'ComfyUI',
    hint: '本地生图 / 视频 / 首尾帧',
    capabilities: ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'],
  },
  sdwebui: {
    label: 'Stable Diffusion WebUI',
    hint: '本地生图 / 图生图',
    capabilities: ['text2image', 'image2image'],
  },
  openai: {
    label: 'OpenAI 兼容图像 API',
    hint: '云端生图 / 编辑',
    capabilities: ['text2image', 'image2image'],
  },
  template: {
    label: '通用异步任务模板',
    hint: '云端视频：提交-轮询-取件',
    capabilities: ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'],
  },
}
const MEDIA_CAPS: MediaCapability[] = ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video']

/** M36：能力矩阵副文案（输入需求，与生成面板槽位渲染一致） */
const CAPABILITY_HINT: Record<MediaCapability, string> = {
  text2image: '提示词 → 图片',
  image2image: '参考图 + 提示词 → 图片',
  text2video: '提示词 → 视频',
  image2video: '首帧图 + 提示词 → 视频',
  firstlast2video: '首帧 + 尾帧 → 视频',
}

const STATUS_DOT: Record<ConnectionStatus, string> = {
  idle: 'bg-slate-300',
  ok: 'bg-emerald-500',
  error: 'bg-rose-500',
}

/** M31 媒体生成（media）：提供方 + 模型清单 + 能力声明 + 工作流 / 任务模板 JSON */
interface MediaFormState {
  name: string
  baseUrl: string
  apiKey: string
  mediaProvider: MediaProviderKind
  mediaModels: string
  mediaDefaultModel: string
  mediaCapabilities: MediaCapability[]
  mediaWorkflows: string
  mediaTemplate: string
  timeoutMs: string
}

const EMPTY_MEDIA_FORM: MediaFormState = {
  name: '',
  baseUrl: '',
  apiKey: '',
  mediaProvider: 'comfyui',
  mediaModels: '',
  mediaDefaultModel: '',
  mediaCapabilities: ['text2image', 'image2image'],
  mediaWorkflows: '',
  mediaTemplate: '',
  timeoutMs: '',
}

function formOf(connection?: ConnectionDefinition): MediaFormState {
  if (!connection) return { ...EMPTY_MEDIA_FORM }
  const c = connection.config as Record<string, unknown>
  const str = (key: string): string => (typeof c[key] === 'string' ? (c[key] as string) : '')
  return {
    ...EMPTY_MEDIA_FORM,
    name: connection.name,
    // M31 媒体生成：provider / models / capabilities / workflows / template 读回（JSON 美化便于再编辑）
    baseUrl: str('baseUrl'),
    mediaProvider: c.provider === 'sdwebui' || c.provider === 'openai' || c.provider === 'template' ? c.provider : 'comfyui',
    mediaModels: Array.isArray(c.models) ? c.models.filter((m: unknown): m is string => typeof m === 'string').join(', ') : '',
    mediaDefaultModel: str('defaultModel'),
    mediaCapabilities: Array.isArray(c.capabilities)
      ? c.capabilities.filter((cap: unknown): cap is MediaCapability => MEDIA_CAPS.includes(cap as MediaCapability))
      : ['text2image', 'image2image'],
    mediaWorkflows: Array.isArray(c.workflows) && c.workflows.length > 0 ? JSON.stringify(c.workflows, null, 2) : '',
    mediaTemplate: c.template && typeof c.template === 'object' ? JSON.stringify(c.template, null, 2) : '',
    timeoutMs: c.timeoutMs !== undefined ? String(c.timeoutMs) : '',
    // apiKey 凭据永不回显（加密存储），留空 = 不修改
  }
}

/**
 * M31 媒体生成：ComfyUI 工作流模板文本 → 模板数组（宽容归一）。
 * 支持 JSON 数组 / 单包装对象 {id?, name?, capability?, json} / 裸 API 格式工作流（整体视为 json）；
 * id / name / capability 缺省自动补全（capability 默认 text2image）。
 */
function normalizeWorkflowsText(text: string): { value?: MediaWorkflowTemplate[]; error?: string } {
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: '工作流 JSON 解析失败：请粘贴合法 JSON（ComfyUI「Save (API Format)」导出）' }
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const out: MediaWorkflowTemplate[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as { id?: unknown; name?: unknown; capability?: unknown; json?: unknown }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `工作流第 ${i + 1} 项不是对象` }
    }
    const body = item.json !== undefined ? item.json : item
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
      return { error: `工作流第 ${i + 1} 项缺少 json（应为 API 格式工作流对象）` }
    }
    const cap = MEDIA_CAPS.includes(item.capability as MediaCapability) ? (item.capability as MediaCapability) : 'text2image'
    out.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `wf-${i + 1}`,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `工作流 ${i + 1}`,
      capability: cap,
      json: body as Record<string, unknown>,
    })
  }
  return { value: out }
}

/** M31 媒体生成：任务模板文本 → TaskApiTemplate（最少三段校验：create.path / poll.path / extract） */
function normalizeTemplateText(text: string): { value?: TaskApiTemplate; error?: string } {
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: '任务模板 JSON 解析失败：请粘贴合法 JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '任务模板应为 JSON 对象（create / poll / extract 三段式）' }
  }
  const t = parsed as {
    create?: { method?: unknown; path?: unknown; headers?: unknown; body?: unknown }
    poll?: { path?: unknown }
    extract?: unknown
  }
  if (
    typeof t.create?.path !== 'string' ||
    !t.create.path.trim() ||
    typeof t.poll?.path !== 'string' ||
    !t.poll.path.trim() ||
    !t.extract ||
    typeof t.extract !== 'object'
  ) {
    return { error: '任务模板不完整：create.path / poll.path / extract 必填' }
  }
  if (t.create.headers !== undefined && (typeof t.create.headers !== 'object' || t.create.headers === null || Array.isArray(t.create.headers))) {
    return { error: '任务模板 create.headers 应为 JSON 对象' }
  }
  if (t.create.body !== undefined && (typeof t.create.body !== 'object' || Array.isArray(t.create.body))) {
    return { error: '任务模板 create.body 应为 JSON 对象（值内用 {{变量}} 占位）' }
  }
  const value = { ...(parsed as Record<string, unknown>) } as unknown as TaskApiTemplate
  value.create = {
    ...(t.create as TaskApiTemplate['create']),
    method: t.create.method === 'PUT' ? 'PUT' : 'POST',
    path: t.create.path.trim(),
    body: (t.create.body as Record<string, unknown> | undefined) ?? {},
  }
  return { value }
}

/** 表单值 → 服务端 config / secret（apiKey 空串 = 不修改既有凭据） */
function payloadOf(form: MediaFormState): { config: Record<string, unknown>; secret?: Record<string, unknown> | null } {
  const config: Record<string, unknown> = {
    provider: form.mediaProvider,
    baseUrl: form.baseUrl.trim(),
    capabilities: form.mediaCapabilities,
  }
  const models = form.mediaModels.split(/[\n,，]/).map((m) => m.trim()).filter(Boolean)
  if (models.length > 0) config.models = models
  if (form.mediaDefaultModel.trim()) config.defaultModel = form.mediaDefaultModel.trim()
  // 工作流（ComfyUI）与任务模板（template）仅随对应提供方落库，避免切换提供方后残留脏配置
  if (form.mediaProvider === 'comfyui') {
    const workflows = normalizeWorkflowsText(form.mediaWorkflows)
    if (workflows.value && workflows.value.length > 0) config.workflows = workflows.value
  }
  if (form.mediaProvider === 'template') {
    const template = normalizeTemplateText(form.mediaTemplate)
    if (template.value) config.template = template.value
  }
  if (form.timeoutMs.trim()) config.timeoutMs = Number(form.timeoutMs)
  return { config, secret: form.apiKey ? { apiKey: form.apiKey } : undefined }
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

/** 新建 / 编辑表单（内联卡片，不占弹窗；自 M36 连接表单媒体分支原样迁入） */
function MediaConnectionForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: ConnectionDefinition
  onDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [form, setForm] = React.useState<MediaFormState>(() => formOf(initial))
  const [saving, setSaving] = React.useState(false)
  const patch = (next: Partial<MediaFormState>): void => setForm((f) => ({ ...f, ...next }))
  // M36 媒体表单：提供方能力矩阵 / 工作流与模板实时校验（编辑体验专业化）
  const providerCaps = MEDIA_PROVIDERS[form.mediaProvider].capabilities
  const workflowCheck = React.useMemo(() => normalizeWorkflowsText(form.mediaWorkflows), [form.mediaWorkflows])
  const templateCheck = React.useMemo(() => normalizeTemplateText(form.mediaTemplate), [form.mediaTemplate])

  /** 切换提供方：能力自动收敛到适配器支持集（空则回退首项），避免不可执行的配置 */
  const patchProvider = (p: MediaProviderKind): void => {
    const supported = MEDIA_PROVIDERS[p].capabilities
    const caps = form.mediaCapabilities.filter((c) => supported.includes(c))
    patch({ mediaProvider: p, mediaCapabilities: caps.length > 0 ? caps : [supported[0]] })
  }

  /** 一键格式化（工作流 / 任务模板共用）：解析失败不落盘 */
  const formatJson = (key: 'mediaWorkflows' | 'mediaTemplate'): void => {
    let pretty: string
    try {
      pretty = JSON.stringify(JSON.parse(form[key]), null, 2)
    } catch {
      toast.error('JSON 解析失败，无法格式化')
      return
    }
    patch(key === 'mediaWorkflows' ? { mediaWorkflows: pretty } : { mediaTemplate: pretty })
    toast('JSON 已格式化')
  }

  const save = async (testAfter = false): Promise<void> => {
    if (!form.name.trim()) {
      toast.error('请填写连接名称')
      return
    }
    if (!form.baseUrl.trim()) {
      toast.error('请填写 API 地址（含协议与端口，如 http://127.0.0.1:8188）')
      return
    }
    if (form.mediaCapabilities.length === 0) {
      toast.error('至少勾选一项生成能力（文生图 / 图生图 / 视频…）')
      return
    }
    if (form.mediaProvider === 'comfyui') {
      const workflows = normalizeWorkflowsText(form.mediaWorkflows)
      if (workflows.error) {
        toast.error(workflows.error)
        return
      }
    }
    if (form.mediaProvider === 'template') {
      const template = normalizeTemplateText(form.mediaTemplate)
      if (template.error) {
        toast.error(template.error)
        return
      }
      if (!template.value) {
        toast.error('通用异步任务模板需填写三段式 JSON（create / poll / extract）')
        return
      }
    }
    setSaving(true)
    try {
      const { config, secret } = payloadOf(form)
      const store = useConnectionsStore.getState()
      let savedId: string | undefined
      if (initial) {
        const saved = await store.update(initial.id, { name: form.name.trim(), config, secret: secret ?? undefined })
        savedId = saved.id
        toast('连接已更新')
      } else {
        const saved = await store.create({ name: form.name.trim(), kind: 'media', config, secret: secret ?? undefined })
        savedId = saved.id
        toast('连接已创建并启用')
      }
      syncMediaProviders()
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
        <Clapperboard className="size-3.5" />
        {initial ? '编辑媒体生成连接' : '新建媒体生成连接'}
      </div>
      <Field label="名称">
        <Input
          className="h-7 text-[12px]"
          value={form.name}
          placeholder="如：本地 ComfyUI"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      {/* M36：提供方卡片（选择即收敛能力矩阵与联调方式） */}
      <div className="space-y-1 pt-0.5">
        <span className="text-[10.5px] text-muted-foreground">提供方</span>
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(MEDIA_PROVIDERS) as MediaProviderKind[]).map((p) => {
            const meta = MEDIA_PROVIDERS[p]
            const activeProvider = form.mediaProvider === p
            return (
              <button
                key={p}
                type="button"
                onClick={() => patchProvider(p)}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-left transition-colors',
                  activeProvider
                    ? 'border-primary/50 bg-primary/[0.06]'
                    : 'border-border bg-card hover:border-primary/25 hover:bg-accent/60',
                )}
              >
                <span className={cn('flex items-center gap-1 text-[11.5px] font-medium', activeProvider && 'text-primary')}>
                  {activeProvider && <CheckCircle2 className="size-3 shrink-0" />}
                  {meta.label}
                </span>
                <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{meta.hint}</span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {meta.capabilities.map((cap) => (
                    <span key={cap} className="rounded-full border px-1.5 text-[9.5px] text-muted-foreground">
                      {CAPABILITY_LABEL[cap]}
                    </span>
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <Field label="API 地址" hint="（含协议与端口；路径按提供方自动拼接）">
        <Input
          className="h-7 font-mono text-[11.5px]"
          value={form.baseUrl}
          placeholder={
            form.mediaProvider === 'comfyui'
              ? 'http://127.0.0.1:8188'
              : form.mediaProvider === 'sdwebui'
                ? 'http://127.0.0.1:7860'
                : form.mediaProvider === 'openai'
                  ? 'https://api.openai.com/v1'
                  : 'https://api.example.com'
          }
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-1.5">
        <Field label="模型清单" hint="（逗号分隔，可选）">
          <Input
            className="h-7 font-mono text-[11px]"
            value={form.mediaModels}
            placeholder="flux-dev, sdxl"
            onChange={(e) => patch({ mediaModels: e.target.value })}
          />
        </Field>
        <Field label="默认模型" hint="（可选）">
          <Input
            className="h-7 font-mono text-[11px]"
            value={form.mediaDefaultModel}
            placeholder="flux-dev"
            onChange={(e) => patch({ mediaDefaultModel: e.target.value })}
          />
        </Field>
      </div>

      <Field label="API Key" hint={initial?.secretSet ? '（留空 = 不修改）' : '（加密存储；本地端点可留空）'}>
        <Input
          className="h-7 text-[12px]"
          type="password"
          autoComplete="new-password"
          value={form.apiKey}
          placeholder={initial?.secretSet ? '••••••••' : 'sk-…'}
          onChange={(e) => patch({ apiKey: e.target.value })}
        />
      </Field>

      {/* M36：能力矩阵（不支持项禁用；一键全选适配能力） */}
      <div className="space-y-1 rounded-lg border bg-card/60 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          生成能力矩阵
          <span className="rounded-full border px-1.5 text-[9.5px]">
            已选 {form.mediaCapabilities.length} / {providerCaps.length} 项适配能力
          </span>
          <button
            type="button"
            className="ml-auto text-[10.5px] text-primary hover:underline disabled:opacity-40"
            disabled={form.mediaCapabilities.length >= providerCaps.length}
            title="勾选当前提供方适配器支持的全部能力"
            onClick={() => patch({ mediaCapabilities: [...providerCaps] })}
          >
            全选适配能力
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          {MEDIA_CAPS.map((cap) => {
            const supported = providerCaps.includes(cap)
            const checked = form.mediaCapabilities.includes(cap)
            return (
              <label
                key={cap}
                className={cn(
                  'flex items-start gap-1.5 rounded-md border px-1.5 py-1 text-[11px]',
                  supported
                    ? checked
                      ? 'border-primary/40 bg-primary/[0.05]'
                      : 'border-border'
                    : 'border-dashed opacity-45',
                )}
                title={supported ? undefined : '该提供方适配器不支持此能力'}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked}
                  disabled={!supported}
                  onChange={(e) =>
                    patch({
                      mediaCapabilities: e.target.checked
                        ? [...form.mediaCapabilities, cap]
                        : form.mediaCapabilities.filter((c) => c !== cap),
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block">{CAPABILITY_LABEL[cap]}</span>
                  <span className="block text-[9.5px] leading-4 text-muted-foreground">
                    {supported ? CAPABILITY_HINT[cap] : '该提供方不支持'}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        <p className="text-[9.5px] text-muted-foreground">生成面板与 Agent 工具（media_generate / media_video）按此裁剪入口</p>
      </div>

      {/* M36：工作流 / 模板编辑器（实时校验 + 链路预览 + 一键格式化） */}
      {form.mediaProvider === 'comfyui' && (
        <div className="space-y-1 pt-0.5">
          <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            工作流模板 JSON
            <span className="text-muted-foreground/70">（留空 = 内置文生图工作流）</span>
            <span
              className={cn(
                'ml-auto flex items-center gap-1',
                workflowCheck.error ? 'text-rose-600' : workflowCheck.value ? 'text-emerald-700' : '',
              )}
            >
              {workflowCheck.error ? (
                <XCircle className="size-3" />
              ) : workflowCheck.value ? (
                <CheckCircle2 className="size-3" />
              ) : null}
              {workflowCheck.error ? '解析失败' : workflowCheck.value ? `通过 · ${workflowCheck.value.length} 个工作流` : '未填写'}
            </span>
            <button
              type="button"
              className="text-[10.5px] text-primary hover:underline disabled:opacity-40"
              disabled={!form.mediaWorkflows.trim() || Boolean(workflowCheck.error)}
              onClick={() => formatJson('mediaWorkflows')}
            >
              格式化
            </button>
          </div>
          <textarea
            className="h-24 w-full resize-y rounded-md border border-input bg-card px-2 py-1 font-mono text-[10.5px] leading-4"
            value={form.mediaWorkflows}
            spellCheck={false}
            placeholder={'[{ "id": "t2i", "name": "文生图", "capability": "text2image", "json": { …API 格式工作流… } }]'}
            onChange={(e) => patch({ mediaWorkflows: e.target.value })}
          />
          {workflowCheck.error && <p className="text-[10.5px] text-rose-600">{workflowCheck.error}</p>}
          {workflowCheck.value && (
            <p className="text-[10.5px] leading-4 text-muted-foreground">
              已解析：{workflowCheck.value.map((w) => `${w.name}（${CAPABILITY_LABEL[w.capability]}）`).join(' · ')}
            </p>
          )}
        </div>
      )}
      {form.mediaProvider === 'template' && (
        <div className="space-y-1 pt-0.5">
          <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            任务模板 JSON
            <span className="text-muted-foreground/70">（create / poll / extract 三段式，必填）</span>
            <span
              className={cn(
                'ml-auto flex items-center gap-1',
                templateCheck.error ? 'text-rose-600' : templateCheck.value ? 'text-emerald-700' : '',
              )}
            >
              {templateCheck.error ? (
                <XCircle className="size-3" />
              ) : templateCheck.value ? (
                <CheckCircle2 className="size-3" />
              ) : null}
              {templateCheck.error ? '校验未通过' : templateCheck.value ? '模板完整' : '未填写'}
            </span>
            <button
              type="button"
              className="text-[10.5px] text-primary hover:underline disabled:opacity-40"
              disabled={!form.mediaTemplate.trim() || Boolean(templateCheck.error)}
              onClick={() => formatJson('mediaTemplate')}
            >
              格式化
            </button>
          </div>
          <textarea
            className="h-28 w-full resize-y rounded-md border border-input bg-card px-2 py-1 font-mono text-[10.5px] leading-4"
            value={form.mediaTemplate}
            spellCheck={false}
            placeholder={
              '{ "create": { "method": "POST", "path": "/v1/videos", "body": { "prompt": "{{prompt}}" } }, "poll": { "path": "/v1/videos/{id}" }, "extract": { "taskId": "id", "status": "status", "done": ["succeeded"], "outputUrl": "output.url" } }'
            }
            onChange={(e) => patch({ mediaTemplate: e.target.value })}
          />
          {templateCheck.error && <p className="text-[10.5px] text-rose-600">{templateCheck.error}</p>}
          {templateCheck.value && (
            <p className="text-[10.5px] leading-4 text-muted-foreground">
              链路：{templateCheck.value.create.method} {templateCheck.value.create.path} → {templateCheck.value.poll.method ?? 'GET'}{' '}
              {templateCheck.value.poll.path}
            </p>
          )}
        </div>
      )}

      <Field label="超时 ms" hint="（可选；视频缺省约 10min）">
        <Input
          className="h-7 text-[12px]"
          value={form.timeoutMs}
          placeholder="自动"
          onChange={(e) => patch({ timeoutMs: e.target.value })}
        />
      </Field>

      {/* M36：模板占位符参考（写模板时的字段级清单） */}
      {form.mediaProvider === 'template' && (
        <p className="rounded-md border border-dashed px-2 py-1.5 text-[10.5px] leading-4 text-muted-foreground">
          模板占位符：
          <span className="font-mono">
            {'{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{duration}} {{model}} {{image}} {{first_frame}} {{last_frame}}'}
          </span>
        </p>
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

/** 媒体连接卡片：启用开关（总开关）/ 测试 / 编辑 / 删除 */
function MediaConnectionCard({
  connection,
  busy,
  onEdit,
}: {
  connection: ConnectionDefinition
  busy: boolean
  onEdit: () => void
}): React.JSX.Element {
  const [testing, setTesting] = React.useState(false)
  const providerKey = typeof connection.config.provider === 'string' ? (connection.config.provider as MediaProviderKind) : undefined
  const providerLabel = providerKey && MEDIA_PROVIDERS[providerKey] ? MEDIA_PROVIDERS[providerKey].label : String(connection.config.provider ?? '')
  const capsCount = Array.isArray(connection.config.capabilities) ? connection.config.capabilities.length : 0

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
      syncMediaProviders()
      toast(enabled ? '已启用（画布生成面板与 Agent 工具可用）' : '已停用（生成入口暂不可用）')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-2.5 shadow-soft">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">
          <Clapperboard className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{connection.name}</span>
        <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[connection.status])} title={connection.lastError ?? connection.status} />
        <span className="shrink-0 rounded-full border px-1.5 py-px text-[9.5px] text-muted-foreground">{providerLabel}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
        <span className="max-w-full truncate font-mono">
          {String(connection.config.baseUrl ?? '')}
          {Array.isArray(connection.config.models) && typeof connection.config.models[0] === 'string'
            ? ` · ${connection.config.models[0]}`
            : ''}
          {capsCount > 0 ? ` · ${capsCount} 项能力` : ''}
        </span>
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
          onClick={() => {
            if (!window.confirm(`删除连接「${connection.name}」？其凭据将一并清除。`)) return
            void useConnectionsStore
              .getState()
              .remove(connection.id)
              .then(() => {
                syncMediaProviders()
                toast('连接已删除')
              })
              .catch((err: Error) => toast.error(err.message))
          }}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  )
}

/** 设置页「媒体生成」分组主体（清单 + 新建 / 编辑 + 直达编辑消费） */
export function MediaConnectionsSection(): React.JSX.Element {
  const connections = useConnectionsStore((s) => s.connections)
  const loading = useConnectionsStore((s) => s.loading)
  const busyId = useConnectionsStore((s) => s.busyId)
  const pendingEditId = useConnectionsStore((s) => s.pendingEditId)
  const [creating, setCreating] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)

  // 清单拉取（幂等；本 effect 先于下方「直达编辑」消费 effect 执行，保证消费时 loading 已置位）
  React.useEffect(() => {
    void useConnectionsStore.getState().load()
  }, [])

  const media = React.useMemo(
    () => connections.filter((c) => c.kind === 'media').sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  )
  const editing = editingId ? media.find((c) => c.id === editingId) : undefined

  // M36：消费画布生成面板的「直达编辑」请求（媒体清单就绪后打开编辑表单，避免空白编辑）
  React.useEffect(() => {
    if (!pendingEditId) return
    const state = useConnectionsStore.getState()
    if (state.loading) return
    const target = state.connections.find((c) => c.id === pendingEditId)
    if (target && target.kind === 'media') {
      setCreating(false)
      setEditingId(target.id)
    }
    // 已删除或非媒体目标：直接丢弃请求（画布生成面板只对媒体连接发起该请求）
    state.consumePendingEdit()
  }, [pendingEditId, connections, loading])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">
          {loading && media.length === 0 ? '正在加载连接…' : `已配置 ${media.length} 个连接`}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          onClick={() => {
            setEditingId(null)
            setCreating(true)
          }}
        >
          <Plus className="size-3" />
          新建媒体生成连接
        </Button>
      </div>

      {creating && <MediaConnectionForm onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />}
      {!creating && editing && (
        <MediaConnectionForm initial={editing} onDone={() => setEditingId(null)} onCancel={() => setEditingId(null)} />
      )}

      {media.length === 0 && !creating && !(loading && media.length === 0) && (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-[11.5px] text-muted-foreground">
          <Clapperboard className="float-soft mx-auto mb-2 size-5 text-primary/40" />
          还没有媒体生成连接。创建并启用后，画布与 Agent 工具即可用。
        </div>
      )}

      {media.length > 0 && (
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {media.map((connection) => (
            <MediaConnectionCard
              key={connection.id}
              connection={connection}
              busy={busyId === connection.id}
              onEdit={() => {
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
