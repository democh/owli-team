/**
 * M26：Agent 编辑器（右侧抽屉）。
 * Tabs：基本 / 人设 / 灵魂 / 工具 / 技能 / 交接 / 高级。
 * - 数据源：console-store.getAgent(id)（raw front-matter + 正文 + 灵魂全文 + 引用清单）；
 * - 保存：updateAgent（id 不可改；tools / skills 传 null 恢复「未配置」三态；
 *   temperature 空串 = 清除、model 空串 = 清除、soul 空串 = 清除显式默认灵魂）；
 * - 灵魂：saveSoul / deleteSoul 写盘后服务端返回最新详情 → 本地 detail/draft 直接对齐，无需重开抽屉；
 * - 头像：PNG magic / ≤8MB 由服务端把关；上传 / 删除后 avatarBust 触发预览缓存刷新。
 */
import * as React from 'react'
import { Check, Loader2, Plus, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentAvatar, AgentDefinition, ConsoleAgentDetail, ConsoleSoulDetail } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { useConnectionsStore } from '../../stores/connections-store'
import { useConsoleStore } from '../../stores/console-store'
import { useMcpStore } from '../../stores/mcp-store'
import { AgentAvatar as AgentAvatarView } from '../agents/AgentAvatar'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { ColorPair, FieldRow, IconPicker, MarkdownField, RefMultiSelect, Switch, TagInput, TextInput } from './fields'

interface AgentDraft {
  catalog?: AgentDefinition['catalog']
  name: string
  role: string
  title: string
  description: string
  capabilities: string[]
  avatar: AgentAvatar
  handoff: string[]
  toolsMode: 'all' | 'custom'
  tools: string[]
  skillsMode: 'inherit' | 'none' | 'custom'
  skills: string[]
  model: string
  temperature: string
  soul: string
  body: string
}

interface SoulDraft {
  id: string
  name: string
  tagline: string
  icon?: string
  traits: string[]
  tone: string
  quirks: string[]
  body: string
  setDefault: boolean
  isNew: boolean
}

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/

/** front-matter → 编辑草稿（tools 空数组在运行时等价「未限制」，归一到 all；skills 三态保留） */
function buildDraft(d: ConsoleAgentDetail): AgentDraft {
  const meta = d.meta
  const autoImage = `/api/agents/${d.id}/avatar`
  return {
    name: meta.name,
    role: meta.role,
    title: meta.title ?? '',
    description: meta.description ?? '',
    capabilities: meta.capabilities ?? [],
    catalog: meta.catalog,
    avatar: { ...meta.avatar, image: meta.avatar.image === autoImage ? undefined : meta.avatar.image },
    handoff: meta.handoff ?? [],
    toolsMode: meta.tools && meta.tools.length > 0 ? 'custom' : 'all',
    tools: meta.tools ?? [],
    skillsMode: meta.skills === undefined ? 'inherit' : meta.skills.length === 0 ? 'none' : 'custom',
    skills: meta.skills ?? [],
    model: meta.model ?? '',
    temperature: meta.temperature === undefined ? '' : String(meta.temperature),
    soul: meta.soul ?? '',
    body: d.body,
  }
}

function soulToDraft(s: ConsoleSoulDetail): SoulDraft {
  return {
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    icon: s.icon,
    traits: s.traits,
    tone: s.tone,
    quirks: s.quirks,
    body: s.body,
    setDefault: s.isDefault,
    isNew: false,
  }
}

function emptySoul(): SoulDraft {
  return { id: '', name: '', tagline: '', traits: [], tone: '', quirks: [], body: '', setDefault: false, isNew: true }
}

/** 单选卡片（技能预载三态 / 工具模式等） */
function ChoiceRow({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean
  onClick: () => void
  title: string
  desc?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'w-full rounded-md border px-3 py-2 text-left transition-colors',
        active ? 'border-primary/40 bg-primary/5' : 'hover:bg-accent/60',
      )}
    >
      <div className="text-[12.5px] font-medium">{title}</div>
      {desc ? <div className="text-[11px] text-muted-foreground">{desc}</div> : null}
    </button>
  )
}

export function AgentEditor({ agentId, onClose }: { agentId: string; onClose: () => void }): React.JSX.Element {
  const agents = useConsoleStore((s) => s.agents)
  const skills = useConsoleStore((s) => s.skills)
  const tools = useConsoleStore((s) => s.tools)
  // M27：MCP 服务器组（整组勾选 = 写入 mcp__<slug>__* 通配）
  const mcpServers = useMcpStore((s) => s.servers)
  // 多 Provider：模型服务连接（provider 绑定候选与 model 下拉候选）
  const connections = useConnectionsStore((s) => s.connections)
  const [detail, setDetail] = React.useState<ConsoleAgentDetail>()
  const [draft, setDraft] = React.useState<AgentDraft>()
  const [tab, setTab] = React.useState('basic')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [soulDraft, setSoulDraft] = React.useState<SoulDraft>()
  const [soulToDelete, setSoulToDelete] = React.useState<string>()
  const [soulBusy, setSoulBusy] = React.useState(false)
  const [avatarBust, setAvatarBust] = React.useState(0)
  const fileRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const d = await useConsoleStore.getState().getAgent(agentId)
        if (cancelled) return
        setDetail(d)
        setDraft(buildDraft(d))
      } catch (err) {
        if (!cancelled) {
          toast.error((err as Error).message)
          onClose()
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    if (useConsoleStore.getState().tools.length === 0) void useConsoleStore.getState().loadTools()
    if (useMcpStore.getState().servers.length === 0) void useMcpStore.getState().refreshAll()
    void useConnectionsStore.getState().load()
    return () => {
      cancelled = true
    }
  }, [agentId, onClose])

  const patch = (p: Partial<AgentDraft>): void => setDraft((d) => (d ? { ...d, ...p } : d))

  /** 多 Provider：模型名候选（启用中的模型服务清单聚合；同名以创建序先者为准，与路由一致） */
  const modelCandidates = React.useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ provider: string; model: string }> = []
    for (const c of [...connections].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (c.kind !== 'llm' || !c.enabled) continue
      const models = Array.isArray(c.config.models) ? c.config.models.filter((m): m is string => typeof m === 'string') : []
      for (const m of models) {
        if (seen.has(m)) continue
        seen.add(m)
        out.push({ provider: c.name, model: m })
      }
    }
    return out
  }, [connections])

  const save = async (): Promise<void> => {
    if (!draft || !detail) return
    if (!draft.name.trim()) {
      toast.error('name 不能为空')
      return
    }
    if (!draft.role.trim()) {
      toast.error('role 不能为空')
      return
    }
    if (!draft.body.trim()) {
      toast.error('人设正文不能为空')
      return
    }
    if (draft.toolsMode === 'custom' && draft.tools.length === 0) {
      toast.error('工具白名单为空（运行时等价「全部工具」）：请至少选择一个工具，或切回「全部工具」')
      return
    }
    if (draft.skillsMode === 'custom' && draft.skills.length === 0) {
      toast.error('指定技能清单为空：请选择技能，或改用「不预载技能」')
      return
    }
    const tempText = draft.temperature.trim()
    let temperature: number | null = null
    if (tempText !== '') {
      const n = Number(tempText)
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        toast.error('温度需为 0–2 之间的数字（留空 = 继承全局默认）')
        return
      }
      temperature = n
    }
    setSaving(true)
    try {
      const updated = await useConsoleStore.getState().updateAgent(agentId, {
        name: draft.name.trim(),
        role: draft.role.trim(),
        title: draft.title.trim(),
        description: draft.description.trim(),
        capabilities: draft.capabilities,
        catalog: draft.catalog,
        avatar: draft.avatar,
        soul: draft.soul,
        handoff: draft.handoff,
        tools: draft.toolsMode === 'all' ? null : draft.tools,
        skills: draft.skillsMode === 'inherit' ? null : draft.skillsMode === 'none' ? [] : draft.skills,
        model: draft.model.trim() || null,
        temperature,
        body: draft.body,
      })
      setDetail(updated)
      toast(`角色「${updated.name}」已保存（下一回合生效）`)
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const saveSoul = async (): Promise<void> => {
    if (!soulDraft) return
    const id = soulDraft.id.trim()
    if (soulDraft.isNew && !ID_RE.test(id)) {
      toast.error('灵魂 id 需小写字母开头、仅含字母 / 数字 / 连字符（≤40）')
      return
    }
    if (!soulDraft.name.trim()) {
      toast.error('灵魂名称不能为空')
      return
    }
    if (!soulDraft.body.trim()) {
      toast.error('灵魂正文不能为空')
      return
    }
    setSoulBusy(true)
    try {
      const updated = await useConsoleStore.getState().saveSoul(agentId, id, {
        name: soulDraft.name.trim(),
        tagline: soulDraft.tagline.trim() || undefined,
        icon: soulDraft.icon,
        traits: soulDraft.traits,
        tone: soulDraft.tone.trim() || undefined,
        quirks: soulDraft.quirks,
        body: soulDraft.body,
        setDefault: soulDraft.setDefault,
      })
      setDetail(updated)
      setDraft((d) => (d ? { ...d, soul: updated.meta.soul ?? '' } : d))
      setSoulDraft(undefined)
      toast(`灵魂「${soulDraft.name.trim()}」已保存`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSoulBusy(false)
    }
  }

  const doDeleteSoul = async (soulId: string): Promise<void> => {
    setSoulBusy(true)
    try {
      const updated = await useConsoleStore.getState().deleteSoul(agentId, soulId)
      setDetail(updated)
      setDraft((d) => (d ? { ...d, soul: updated.meta.soul ?? '' } : d))
      if (soulDraft && !soulDraft.isNew && soulDraft.id === soulId) setSoulDraft(undefined)
      setSoulToDelete(undefined)
      toast('灵魂已删除（移入回收站）')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSoulBusy(false)
    }
  }

  const onAvatarFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.type !== 'image/png') {
      toast.error('仅支持 PNG 图片')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error('头像不得超过 8MB（PNG）')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      void (async () => {
        try {
          const updated = await useConsoleStore.getState().uploadAvatar(agentId, String(reader.result ?? ''))
          setDetail(updated)
          setAvatarBust(Date.now())
          toast('头像已更新')
        } catch (err) {
          toast.error((err as Error).message)
        }
      })()
    }
    reader.readAsDataURL(file)
  }

  const removeAvatar = async (): Promise<void> => {
    try {
      const updated = await useConsoleStore.getState().deleteAvatar(agentId)
      setDetail(updated)
      setAvatarBust(Date.now())
      toast('头像已删除（移入回收站）')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const previewImage = detail?.hasAvatar
    ? `/api/agents/${agentId}/avatar?t=${avatarBust}`
    : draft?.avatar.image
  const avatarShape: AgentDefinition | undefined = detail && draft
    ? {
        id: detail.id,
        name: draft.name || detail.id,
        role: draft.role,
        title: draft.title,
        description: draft.description,
        capabilities: draft.capabilities,
        avatar: { ...draft.avatar, image: previewImage },
        group: detail.group,
        handoff: draft.handoff,
      }
    : undefined

  const toolOptions = tools.map((t) => ({ id: t.name, label: t.name, hint: t.category }))
  const skillOptions = skills.map((s) => ({ id: s.name, label: s.name, hint: `${s.lineCount} 行` }))
  const handoffOptions = agents
    .filter((a) => a.id !== agentId)
    .map((a) => ({ id: a.id, label: a.name, hint: a.role }))

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label={`编辑角色 ${agentId}`}>
      <div className="min-w-0 flex-1 bg-foreground/25 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div className="flex h-full w-[620px] max-w-[94vw] flex-col border-l bg-card shadow-2xl">
        {/* 头部 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          {avatarShape && <AgentAvatarView agent={avatarShape} size={24} animated={false} />}
          <span className="truncate text-[13px] font-semibold">{draft?.name || agentId}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {agentId}
            {detail ? ` · ${detail.group}` : ''}
          </span>
          {detail && detail.refCount > 0 && <Badge variant="warning">被引用 {detail.refCount}</Badge>}
          <Button variant="ghost" size="icon-sm" className="ml-auto" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {loading || !draft || !detail ? (
          <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在加载角色定义…
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b px-4 py-2">
              <TabsList>
                <TabsTrigger value="basic">基本</TabsTrigger>
                <TabsTrigger value="persona">人设</TabsTrigger>
                <TabsTrigger value="souls">灵魂{detail.souls.length > 0 ? ` ${detail.souls.length}` : ''}</TabsTrigger>
                <TabsTrigger value="tools">工具</TabsTrigger>
                <TabsTrigger value="skills">技能</TabsTrigger>
                <TabsTrigger value="handoff">交接</TabsTrigger>
                <TabsTrigger value="advanced">高级</TabsTrigger>
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {/* ---------- 基本 ---------- */}
              <TabsContent value="basic" className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="shrink-0 space-y-2">
                    <AgentAvatarView agent={avatarShape} size={64} animated={false} />
                    <div className="flex flex-col gap-1">
                      <Button variant="outline" size="xs" onClick={() => fileRef.current?.click()}>
                        <Upload className="size-3" />
                        上传 PNG
                      </Button>
                      {detail.hasAvatar && (
                        <Button variant="ghost" size="xs" onClick={() => void removeAvatar()}>
                          <Trash2 className="size-3" />
                          删除头像
                        </Button>
                      )}
                    </div>
                    <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={onAvatarFile} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-3">
                    <FieldRow label="头像图标（无图时回退：渐变 + 图标）">
                      <IconPicker value={draft.avatar.icon} onChange={(v) => patch({ avatar: { ...draft.avatar, icon: v } })} />
                    </FieldRow>
                    <FieldRow label="渐变配色">
                      <ColorPair
                        value={draft.avatar.gradient}
                        onChange={(v) => patch({ avatar: { ...draft.avatar, gradient: v } })}
                      />
                    </FieldRow>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FieldRow label="name" hint="显示名">
                    <TextInput value={draft.name} ariaLabel="角色名" onChange={(v) => patch({ name: v })} />
                  </FieldRow>
                  <FieldRow label="role" hint="角色徽标">
                    <TextInput value={draft.role} ariaLabel="角色徽标" placeholder="如 产品经理" onChange={(v) => patch({ role: v })} />
                  </FieldRow>
                </div>
                <FieldRow label="title" hint="一句话头衔（选填）">
                  <TextInput value={draft.title} ariaLabel="头衔" onChange={(v) => patch({ title: v })} />
                </FieldRow>
                <FieldRow label="description" hint="选填：名片描述">
                  <TextInput value={draft.description} ariaLabel="描述" onChange={(v) => patch({ description: v })} />
                </FieldRow>
                <FieldRow label="capabilities" hint="能力标签（回车提交，展示在团队面板）">
                  <TagInput value={draft.capabilities} onChange={(v) => patch({ capabilities: v })} placeholder="如 需求拆解" />
                </FieldRow>
              </TabsContent>

              {/* ---------- 人设 ---------- */}
              <TabsContent value="persona" className="space-y-3">
                <MarkdownField value={draft.body} rows={22} onChange={(v) => patch({ body: v })} />
              </TabsContent>

              {/* ---------- 灵魂 ---------- */}
              <TabsContent value="souls" className="space-y-3">
                <div className="flex items-center justify-end">
                  <Button variant="outline" size="xs" onClick={() => setSoulDraft(emptySoul())}>
                    <Plus className="size-3" />
                    新建灵魂
                  </Button>
                </div>
                {detail.souls.length === 0 && !soulDraft && (
                  <div className="rounded-md border border-dashed px-3 py-6 text-center text-[11.5px] text-muted-foreground">
                    暂无灵魂。
                  </div>
                )}
                {detail.souls.map((s) => {
                  const editing = soulDraft && !soulDraft.isNew && soulDraft.id === s.id
                  return (
                    <div key={s.id}>
                      <div
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-3 py-2',
                          editing && 'border-primary/40 bg-primary/5',
                        )}
                      >
                        <span className="text-[12.5px] font-medium">{s.name}</span>
                        {s.isDefault && <Badge variant="warning">默认</Badge>}
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{s.tagline}</span>
                        <Button variant="outline" size="xs" onClick={() => setSoulDraft(soulToDraft(s))}>
                          编辑
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setSoulToDelete(s.id)}>
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                      {soulToDelete === s.id && (
                        <div className="mt-1 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11.5px]">
                          <span className="min-w-0 flex-1">确认删除灵魂「{s.name}」？文件将移入回收站。</span>
                          <Button variant="outline" size="xs" disabled={soulBusy} onClick={() => setSoulToDelete(undefined)}>
                            取消
                          </Button>
                          <Button variant="destructive" size="xs" disabled={soulBusy} onClick={() => void doDeleteSoul(s.id)}>
                            {soulBusy && <Loader2 className="size-3 animate-spin" />}
                            删除
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {soulDraft && (
                  <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                    <div className="text-[12px] font-medium">{soulDraft.isNew ? '新建灵魂' : `编辑灵魂：${soulDraft.id}`}</div>
                    <div className="grid grid-cols-2 gap-3">
                      <FieldRow label="id" hint={soulDraft.isNew ? '小写字母 / 数字 / 连字符' : '不可改'}>
                        <TextInput
                          value={soulDraft.id}
                          mono
                          disabled={!soulDraft.isNew}
                          ariaLabel="灵魂 id"
                          placeholder="如 advisor"
                          onChange={(v) => setSoulDraft({ ...soulDraft, id: v })}
                        />
                      </FieldRow>
                      <FieldRow label="name" hint="显示名">
                        <TextInput
                          value={soulDraft.name}
                          ariaLabel="灵魂名称"
                          placeholder="如 军师"
                          onChange={(v) => setSoulDraft({ ...soulDraft, name: v })}
                        />
                      </FieldRow>
                    </div>
                    <FieldRow label="tagline" hint="一句话画像（选填）">
                      <TextInput
                        value={soulDraft.tagline}
                        ariaLabel="灵魂简介"
                        onChange={(v) => setSoulDraft({ ...soulDraft, tagline: v })}
                      />
                    </FieldRow>
                    <FieldRow label="traits" hint="性格特质（回车提交）">
                      <TagInput value={soulDraft.traits} onChange={(v) => setSoulDraft({ ...soulDraft, traits: v })} />
                    </FieldRow>
                    <div className="grid grid-cols-2 gap-3">
                      <FieldRow label="tone" hint="语气（选填）">
                        <TextInput
                          value={soulDraft.tone}
                          ariaLabel="灵魂语气"
                          placeholder="如 沉稳、直击要害"
                          onChange={(v) => setSoulDraft({ ...soulDraft, tone: v })}
                        />
                      </FieldRow>
                      <FieldRow label="quirks" hint="口头禅 / 习惯（回车提交）">
                        <TagInput value={soulDraft.quirks} onChange={(v) => setSoulDraft({ ...soulDraft, quirks: v })} />
                      </FieldRow>
                    </div>
                    <FieldRow label="icon" hint="灵魂徽标（选填）">
                      <IconPicker value={soulDraft.icon} onChange={(v) => setSoulDraft({ ...soulDraft, icon: v })} />
                    </FieldRow>
                    <FieldRow label="正文" hint="该灵魂下的表达方式（Markdown）">
                      <MarkdownField
                        value={soulDraft.body}
                        rows={10}
                        onChange={(v) => setSoulDraft({ ...soulDraft, body: v })}
                      />
                    </FieldRow>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={soulDraft.setDefault}
                        onChange={(v) => setSoulDraft({ ...soulDraft, setDefault: v })}
                        label="设为默认灵魂"
                      />
                      <div className="ml-auto flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setSoulDraft(undefined)}>
                          取消
                        </Button>
                        <Button size="sm" disabled={soulBusy} onClick={() => void saveSoul()}>
                          {soulBusy && <Loader2 className="size-3.5 animate-spin" />}
                          保存灵魂
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* ---------- 工具 ---------- */}
              <TabsContent value="tools" className="space-y-3">
                <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <Switch
                    checked={draft.toolsMode === 'custom'}
                    onChange={(v) => patch({ toolsMode: v ? 'custom' : 'all' })}
                    label="限制工具白名单"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium">
                      {draft.toolsMode === 'custom' ? '指定工具白名单' : '全部工具（未限制）'}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {draft.toolsMode === 'custom'
                        ? `该角色仅可用勾选的 ${draft.tools.length} 个工具（未勾选 = 工具清单不落盘）`
                        : '不写 tools 字段：该角色可使用全部已注册工具'}
                    </div>
                  </div>
                </div>
                {draft.toolsMode === 'custom' ? (
                  <div className="space-y-3">
                    {mcpServers.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[12px] font-medium">MCP 服务器组（整组通配）</span>
                          <span className="text-[11px] text-muted-foreground">
                            勾选 = 写入 mcp__&lt;name&gt;__*（服务器后续新增工具自动纳入）
                          </span>
                        </div>
                        <div className="rounded-md border border-input bg-card p-1">
                          {mcpServers.map((server) => {
                            const wildcard = `mcp__${server.name}__*`
                            const checked = draft.tools.includes(wildcard)
                            return (
                              <button
                                key={server.id}
                                type="button"
                                aria-pressed={checked}
                                title={`授权该角色使用服务器「${server.name}」的全部工具`}
                                onClick={() =>
                                  patch({
                                    tools: checked
                                      ? draft.tools.filter((t) => t !== wildcard)
                                      : [...draft.tools, wildcard],
                                  })
                                }
                                className={cn(
                                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-accent/70',
                                  checked && 'bg-primary/5',
                                )}
                              >
                                <span
                                  className={cn(
                                    'flex size-3.5 shrink-0 items-center justify-center rounded border',
                                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                                  )}
                                >
                                  {checked && <Check className="size-2.5" />}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{server.displayName || server.name}</span>
                                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{wildcard}</span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">{server.tools.length} 工具</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    <RefMultiSelect
                      options={toolOptions}
                      value={draft.tools}
                      onChange={(v) => patch({ tools: v })}
                      emptyText="工具清单加载中…"
                      heightClass="max-h-80"
                    />
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-6 text-center text-[11.5px] text-muted-foreground">
                    如需最小权限（如只读分析角色），打开上方开关并勾选需要的工具。
                  </div>
                )}
              </TabsContent>

              {/* ---------- 技能 ---------- */}
              <TabsContent value="skills" className="space-y-3">
                <div className="space-y-1.5" role="radiogroup" aria-label="技能预载模式">
                  <ChoiceRow
                    active={draft.skillsMode === 'inherit'}
                    onClick={() => patch({ skillsMode: 'inherit' })}
                    title="继承场景默认"
                  />
                  <ChoiceRow
                    active={draft.skillsMode === 'none'}
                    onClick={() => patch({ skillsMode: 'none' })}
                    title="不预载技能"
                  />
                  <ChoiceRow
                    active={draft.skillsMode === 'custom'}
                    onClick={() => patch({ skillsMode: 'custom' })}
                    title="指定技能清单"
                  />
                </div>
                {draft.skillsMode === 'custom' && (
                  <RefMultiSelect
                    options={skillOptions}
                    value={draft.skills}
                    onChange={(v) => patch({ skills: v })}
                    emptyText="技能库为空（先在 Skill 管理创建）"
                    heightClass="max-h-72"
                  />
                )}
              </TabsContent>

              {/* ---------- 交接 ---------- */}
              <TabsContent value="handoff" className="space-y-3">
                <RefMultiSelect
                  options={handoffOptions}
                  value={draft.handoff}
                  onChange={(v) => patch({ handoff: v })}
                  emptyText="暂无其它角色"
                  heightClass="max-h-72"
                />
              </TabsContent>

              {/* ---------- 高级 ---------- */}
              <TabsContent value="advanced" className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <FieldRow label="model" hint="服务名/模型名（如 deepseek/deepseek-flash）经对应服务调用；留空 = 系统默认">
                    <TextInput
                      value={draft.model}
                      mono
                      ariaLabel="模型"
                      list="llm-model-candidates"
                      placeholder="如 deepseek/deepseek-flash"
                      onChange={(v) => patch({ model: v })}
                    />
                    <datalist id="llm-model-candidates">
                      {modelCandidates.map((c) => (
                        <option key={`${c.provider}/${c.model}`} value={`${c.provider}/${c.model}`}>
                          {c.provider}
                        </option>
                      ))}
                    </datalist>
                  </FieldRow>
                  <FieldRow label="temperature" hint="0–2；留空 = 继承全局（设置面板「统一温度」开启时被忽略）">
                    <TextInput value={draft.temperature} mono ariaLabel="温度" placeholder="如 0.3" onChange={(v) => patch({ temperature: v })} />
                  </FieldRow>
                </div>
                <FieldRow label="默认灵魂" hint="front-matter soul 字段（显式指定）">
                  <select
                    value={draft.soul}
                    aria-label="默认灵魂"
                    onChange={(e) => patch({ soul: e.target.value })}
                    className="h-8 w-full rounded-md border border-input bg-card px-2.5 text-[12.5px] shadow-sm focus-visible:border-primary/40 focus-visible:outline-none"
                  >
                    <option value="">（未显式指定，取 souls/default.md）</option>
                    {detail.souls.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}（{s.id}）
                      </option>
                    ))}
                  </select>
                </FieldRow>
                <div className="space-y-1.5 rounded-md border bg-muted/20 px-3 py-2 text-[11.5px]">
                  <div className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted-foreground">角色 id</span>
                    <span className="font-mono">{detail.id}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted-foreground">所属场景</span>
                    <span className="font-mono">{detail.group}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted-foreground">引用影响面</span>
                    <span className="min-w-0 flex-1">
                      {detail.refs.items.length === 0 ? '无（可安全删除）' : detail.refs.items.join('；')}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted-foreground">资产路径</span>
                    <span className="min-w-0 flex-1 break-all font-mono">agents/{detail.group}/{detail.id}/AGENT.md</span>
                  </div>
                </div>
              </TabsContent>
            </div>
          </Tabs>
        )}

        {/* 底部操作 */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving || loading || !draft} onClick={() => void save()}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            保存
          </Button>
        </div>
      </div>
    </div>
  )
}
