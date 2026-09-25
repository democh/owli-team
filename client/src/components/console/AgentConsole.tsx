/**
 * M26：Agent 管理（列表 + 新建向导 + 编辑 / 复制 / 软删除）。
 * - 列表：按场景分组（group.order），支持搜索与场景过滤；卡片徽章 = 工具数（-1 全部）/
 *   技能数（-1 继承场景）/ 灵魂数 / 引用数；
 * - 新建向导：第 1 步选场景（或内联新建场景），第 2 步基本信息（id / name / role / 头像回退 / 正文模板）；
 * - 删除：软删除到回收站；服务端有引用时 409 + 清单 → 对话框内展示影响面，二次确认后 force 删除；
 * - 页头 ValidateBanner（资产校验聚合）；数据源 console-store（挂载时 refreshAll）。
 */
import * as React from 'react'
import { Bot, Copy, Loader2, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentCreateInput,
  AgentDefinition,
  AgentDraftPayload,
  ConsoleAgentSummary,
  GenerateDraftResult,
} from '@multi-agent/shared'
import { resolveIcon } from '../../lib/avatar-icons'
import { ApiError } from '../../lib/api'
import { useConsoleStore } from '../../stores/console-store'
import { AgentAvatar } from '../agents/AgentAvatar'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { AgentEditor } from './AgentEditor'
import { ColorPair, FieldRow, IconPicker, TextInput } from './fields'
import { ValidateBanner } from './ValidateBanner'

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/
const NEW_GROUP = '__new__'
const DEFAULT_BODY = '## 职责\n\n## 边界\n\n## 协作方式\n'

function toDefinition(a: ConsoleAgentSummary): AgentDefinition {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    title: a.title,
    description: a.description,
    capabilities: [],
    avatar: a.avatar,
    group: a.group,
    handoff: [],
  }
}

interface WizardState {
  step: 1 | 2
  group: string
  newGroupId: string
  newGroupName: string
  newGroupDescription: string
  newGroupIcon: string
  newGroupTheme: [string, string]
  newGroupObjective: string
  id: string
  name: string
  role: string
  title: string
  description: string
  icon: string
  gradient: [string, string]
  body: string
}

function initialWizard(groups: string[]): WizardState {
  return {
    step: 1,
    group: groups[0] ?? NEW_GROUP,
    newGroupId: '',
    newGroupName: '',
    newGroupDescription: '',
    newGroupIcon: 'compass',
    newGroupTheme: ['#6366f1', '#818cf8'],
    newGroupObjective: '',
    id: '',
    name: '',
    role: '',
    title: '',
    description: '',
    icon: 'user',
    gradient: ['#6366f1', '#818cf8'],
    body: DEFAULT_BODY,
  }
}

export function AgentConsole(): React.JSX.Element {
  const agents = useConsoleStore((s) => s.agents)
  const groups = useConsoleStore((s) => s.groups)
  const loading = useConsoleStore((s) => s.loading)
  const [query, setQuery] = React.useState('')
  const [groupFilter, setGroupFilter] = React.useState('')
  const [editingId, setEditingId] = React.useState<string>()
  const [wizard, setWizard] = React.useState<WizardState>()
  const [wizardError, setWizardError] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  // Agent Studio：AI 生成（描述 → 草稿 → 填入新建向导 step2）
  const [genOpen, setGenOpen] = React.useState(false)
  const [genDesc, setGenDesc] = React.useState('')
  const [genBusy, setGenBusy] = React.useState(false)
  const [genError, setGenError] = React.useState('')
  const [genResult, setGenResult] = React.useState<GenerateDraftResult<AgentDraftPayload>>()
  const [deleteTarget, setDeleteTarget] = React.useState<ConsoleAgentSummary>()
  const [deleteRefs, setDeleteRefs] = React.useState<string[]>()
  const [deleting, setDeleting] = React.useState(false)

  React.useEffect(() => {
    void useConsoleStore.getState().refreshAll()
  }, [])

  const closeEditor = React.useCallback(() => setEditingId(undefined), [])

  const keyword = query.trim().toLowerCase()
  const filtered = React.useMemo(
    () =>
      agents.filter((a) => {
        if (groupFilter && a.group !== groupFilter) return false
        if (!keyword) return true
        return [a.name, a.id, a.role, a.title, a.description].some((v) => v.toLowerCase().includes(keyword))
      }),
    [agents, groupFilter, keyword],
  )

  /** 分组展示：groups 顺序优先；防御性兜底：agents 中出现未知 group 时合成占位场景 */
  const sections = React.useMemo(() => {
    const order = new Map(groups.map((g, i) => [g.id, i]))
    const byGroup = new Map<string, ConsoleAgentSummary[]>()
    for (const a of filtered) {
      const list = byGroup.get(a.group) ?? []
      list.push(a)
      byGroup.set(a.group, list)
    }
    return [...byGroup.entries()]
      .map(([id, items]) => {
        const group = groups.find((g) => g.id === id) ?? {
          id,
          name: id,
          description: '',
          icon: 'compass',
          theme: ['#64748b', '#94a3b8'] as [string, string],
          objective: '',
          chain: [],
          defaultSkills: [],
          parallel: false,
          rounds: false,
          order: 999,
        }
        return { group, items }
      })
      .sort((a, b) => (order.get(a.group.id) ?? 999) - (order.get(b.group.id) ?? 999))
  }, [filtered, groups])

  const openWizard = (): void => {
    setWizard(initialWizard(useConsoleStore.getState().groups.map((g) => g.id)))
    setWizardError('')
  }

  const openDelete = (a: ConsoleAgentSummary): void => {
    setDeleteTarget(a)
    setDeleteRefs(undefined)
  }

  const doDuplicate = async (a: ConsoleAgentSummary): Promise<void> => {
    try {
      const created = await useConsoleStore.getState().duplicateAgent(a.id)
      toast(`已复制为「${created.name}」（${created.id}）`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doDelete = async (force: boolean): Promise<void> => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await useConsoleStore.getState().deleteAgent(deleteTarget.id, force)
      toast(
        res.deletedGroup
          ? `「${deleteTarget.name}」已移入回收站（场景已空，整组一并保留在回收站）`
          : `「${deleteTarget.name}」已移入回收站`,
      )
      setDeleteTarget(undefined)
      setDeleteRefs(undefined)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.refs) {
        setDeleteRefs(err.refs)
      } else {
        toast.error((err as Error).message)
      }
    } finally {
      setDeleting(false)
    }
  }

  const wizardNext = (): void => {
    if (!wizard) return
    if (wizard.group === NEW_GROUP) {
      if (!ID_RE.test(wizard.newGroupId.trim())) {
        setWizardError('场景 id 需小写字母开头、仅含字母 / 数字 / 连字符（≤40）')
        return
      }
      if (!wizard.newGroupName.trim()) {
        setWizardError('场景名称不能为空')
        return
      }
    }
    setWizardError('')
    setWizard({ ...wizard, step: 2 })
  }

  /** Agent Studio：调用生成器（不落盘；issues 由结果区展示） */
  const runGenerate = async (): Promise<void> => {
    const description = genDesc.trim()
    if (!description) {
      setGenError('请先描述你想要的角色（一句话即可）')
      return
    }
    setGenBusy(true)
    setGenError('')
    try {
      const result = await useConsoleStore.getState().generateAgent(description)
      setGenResult(result)
    } catch (err) {
      setGenError((err as Error).message)
    } finally {
      setGenBusy(false)
    }
  }

  /** 将生成草稿填入新建向导 step2（用户可改后提交创建） */
  const applyDraft = (): void => {
    if (!genResult) return
    const draft = genResult.draft
    const groupIds = new Set(groups.map((g) => g.id))
    setWizard({
      step: 2,
      group: groupIds.has(draft.group) ? draft.group : draft.newGroup ? NEW_GROUP : (groups[0]?.id ?? NEW_GROUP),
      newGroupId: draft.newGroup?.id ?? '',
      newGroupName: draft.newGroup?.name ?? '',
      newGroupDescription: draft.newGroup?.description ?? '',
      newGroupIcon: 'compass',
      newGroupTheme: draft.avatar.gradient ?? ['#6366f1', '#818cf8'],
      newGroupObjective: draft.newGroup?.objective ?? '',
      id: draft.id,
      name: draft.name,
      role: draft.role,
      title: draft.title,
      description: draft.description,
      icon: draft.avatar.icon,
      gradient: draft.avatar.gradient ?? ['#6366f1', '#818cf8'],
      body: draft.body,
    })
    setWizardError('')
    setGenOpen(false)
    toast('已填入新建向导——检查无误后提交创建')
  }

  const wizardSubmit = async (): Promise<void> => {
    if (!wizard) return
    if (!ID_RE.test(wizard.id.trim())) {
      setWizardError('角色 id 需小写字母开头、仅含字母 / 数字 / 连字符（≤40），且全局唯一')
      return
    }
    if (!wizard.name.trim()) {
      setWizardError('角色 name 不能为空')
      return
    }
    if (!wizard.role.trim()) {
      setWizardError('role 不能为空')
      return
    }
    const input: AgentCreateInput = {
      id: wizard.id.trim(),
      group: wizard.group,
      newGroup:
        wizard.group === NEW_GROUP
          ? {
              id: wizard.newGroupId.trim(),
              name: wizard.newGroupName.trim(),
              description: wizard.newGroupDescription.trim() || undefined,
              icon: wizard.newGroupIcon,
              theme: wizard.newGroupTheme,
              objective: wizard.newGroupObjective.trim() || undefined,
            }
          : undefined,
      name: wizard.name.trim(),
      role: wizard.role.trim(),
      title: wizard.title.trim(),
      description: wizard.description.trim(),
      capabilities: [],
      avatar: { icon: wizard.icon, gradient: wizard.gradient },
      soul: '',
      handoff: [],
      tools: null,
      skills: null,
      model: null,
      temperature: null,
      body: wizard.body,
    }
    setCreating(true)
    try {
      const created = await useConsoleStore.getState().createAgent(input)
      setWizard(undefined)
      toast(`角色「${created.name}」已创建，可继续完善人设 / 工具 / 技能`)
      setEditingId(created.id)
    } catch (err) {
      setWizardError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Bot className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold">Agent 管理</span>
        <span className="text-[11px] text-muted-foreground">
          {agents.length} 个角色 · {groups.length} 个场景
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ValidateBanner />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setGenResult(undefined)
              setGenError('')
              setGenOpen(true)
            }}
          >
            <Sparkles className="size-3.5" />
            AI 生成
          </Button>
          <Button size="sm" onClick={openWizard}>
            <Plus className="size-3.5" />
            新建 Agent
          </Button>
        </div>
      </div>

      {/* 搜索 / 过滤 */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            aria-label="搜索角色"
            placeholder="搜索名称 / id / 角色…"
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-card pl-7 pr-2 text-[12.5px] shadow-sm transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/15"
          />
        </div>
        <select
          value={groupFilter}
          aria-label="场景过滤"
          onChange={(e) => setGroupFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-card px-2 text-[12.5px] shadow-sm focus-visible:border-primary/40 focus-visible:outline-none"
        >
          <option value="">全部场景</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        {(keyword || groupFilter) && (
          <span className="text-[11px] text-muted-foreground">筛出 {filtered.length} 个角色</span>
        )}
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3">
        {loading && agents.length === 0 && (
          <div className="flex items-center justify-center py-16 text-[12px] text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在加载资产…
          </div>
        )}
        {!loading && agents.length === 0 && (
          <div className="rounded-lg border border-dashed px-4 py-16 text-center">
            <div className="text-[13px] font-medium">还没有 Agent</div>
            <p className="mt-1 text-[11.5px] text-muted-foreground">点右上角「新建 Agent」创建自定义角色。</p>
          </div>
        )}
        {sections.map(({ group, items }) => {
          const GroupIcon = resolveIcon(group.icon)
          return (
            <section key={group.id}>
              <div className="mb-2 flex items-center gap-2">
                <GroupIcon className="size-4" style={{ color: group.theme[0] }} />
                <span className="text-[12.5px] font-medium">{group.name}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground">{group.id}</span>
                <span className="text-[11px] text-muted-foreground">{items.length} 个角色</span>
              </div>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
                {items.map((a) => (
                  <article key={a.id} className="rounded-lg border bg-card p-3 transition-colors hover:border-primary/30">
                    <div className="flex items-start gap-3">
                      <AgentAvatar agent={toDefinition(a)} size={40} animated={false} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-semibold">{a.name}</span>
                          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{a.id}</span>
                        </div>
                        <div className="truncate text-[11.5px] text-muted-foreground">
                          {a.role}
                          {a.title ? ` · ${a.title}` : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => setEditingId(a.id)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" title="复制" onClick={() => void doDuplicate(a)}>
                          <Copy className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" title="删除（软删除到回收站）" onClick={() => openDelete(a)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                    {a.description && <p className="mt-2 line-clamp-2 text-[11.5px] text-muted-foreground">{a.description}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">{a.toolCount === -1 ? '工具 · 全部' : `工具 · ${a.toolCount}`}</Badge>
                      <Badge variant="outline">{a.skillCount === -1 ? '技能 · 继承场景' : `技能 · ${a.skillCount}`}</Badge>
                      {a.soulCount > 0 && <Badge variant="outline">灵魂 · {a.soulCount}</Badge>}
                      {a.refCount > 0 && <Badge variant="warning">被引用 · {a.refCount}</Badge>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )
        })}
        {!loading && agents.length > 0 && sections.length === 0 && (
          <div className="py-16 text-center text-[12px] text-muted-foreground">没有匹配的角色</div>
        )}
      </div>

      {/* Agent Studio：AI 生成（描述 → 草稿 → 填入新建向导） */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>AI 生成 Agent</DialogTitle>
            <DialogDescription>
              用一句话描述你想要的角色，AI 生成完整草稿（六段人设 / 场景 / 技能 / 头像回退），确认后填入新建向导。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3 space-y-3">
            <textarea
              value={genDesc}
              aria-label="角色描述"
              rows={3}
              placeholder="例如：一个专门拆解竞品的分析师，懂定价与功能对比；或：财务对账助理，能比对流水与发票差异"
              className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-[12.5px] shadow-sm transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/15"
              onChange={(e) => setGenDesc(e.target.value)}
            />
            {genError && <p className="text-[11.5px] text-destructive">{genError}</p>}
            {genResult && (
              <div className="rounded-md border bg-muted/30 p-2 text-[11.5px]">
                <p>
                  已生成 <span className="font-medium">{genResult.draft.name}</span>（{genResult.draft.role}）·
                  {genResult.attempts > 1 ? ` 第 ${genResult.attempts} 轮通过` : ' 一次通过'} · 场景「
                  {groups.find((g) => g.id === genResult.draft.group)?.name ??
                    genResult.draft.newGroup?.name ??
                    '待定'}
                  」
                </p>
                {genResult.issues.length > 0 && (
                  <ul className="mt-1 list-inside list-disc text-amber-600">
                    {genResult.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={genBusy} onClick={() => void runGenerate()}>
              {genBusy ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  正在生成（约 10–30 秒）…
                </>
              ) : genResult ? (
                '再生成一次'
              ) : (
                '生成'
              )}
            </Button>
            <Button size="sm" disabled={!genResult || genBusy} onClick={applyDraft}>
              填入新建向导
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 新建向导 */}
      <Dialog open={!!wizard} onOpenChange={(open) => (!open ? setWizard(undefined) : undefined)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>新建 Agent · {wizard?.step === 1 ? '选择场景' : '基本信息'}</DialogTitle>
          </DialogHeader>
          {wizard && (
            <div className="mt-3 space-y-3">
              {wizard.step === 1 ? (
                <>
                  <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1" role="radiogroup" aria-label="选择场景">
                    {groups.map((g) => {
                      const Icon = resolveIcon(g.icon)
                      const active = wizard.group === g.id
                      return (
                        <button
                          key={g.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setWizard({ ...wizard, group: g.id })}
                          className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors ${
                            active ? 'border-primary/40 bg-primary/5' : 'hover:bg-accent/60'
                          }`}
                        >
                          <Icon className="size-4 shrink-0" style={{ color: g.theme[0] }} />
                          <span className="text-[12.5px] font-medium">{g.name}</span>
                          <span className="font-mono text-[10.5px] text-muted-foreground">{g.id}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{g.description}</span>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={wizard.group === NEW_GROUP}
                      onClick={() => setWizard({ ...wizard, group: NEW_GROUP })}
                      className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors ${
                        wizard.group === NEW_GROUP ? 'border-primary/40 bg-primary/5' : 'hover:bg-accent/60'
                      }`}
                    >
                      <Plus className="size-4 shrink-0 text-emerald-600" />
                      <span className="text-[12.5px] font-medium">新建场景</span>
                    </button>
                  </div>
                  {wizard.group === NEW_GROUP && (
                    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                      <div className="grid grid-cols-2 gap-3">
                        <FieldRow label="场景 id" hint="目录名">
                          <TextInput
                            value={wizard.newGroupId}
                            mono
                            ariaLabel="场景 id"
                            placeholder="如 strategy"
                            onChange={(v) => setWizard({ ...wizard, newGroupId: v })}
                          />
                        </FieldRow>
                        <FieldRow label="场景名称">
                          <TextInput
                            value={wizard.newGroupName}
                            ariaLabel="场景名称"
                            placeholder="如 战略参谋部"
                            onChange={(v) => setWizard({ ...wizard, newGroupName: v })}
                          />
                        </FieldRow>
                      </div>
                      <FieldRow label="场景描述" hint="选填">
                        <TextInput
                          value={wizard.newGroupDescription}
                          ariaLabel="场景描述"
                          onChange={(v) => setWizard({ ...wizard, newGroupDescription: v })}
                        />
                      </FieldRow>
                      <FieldRow label="场景目标" hint="选填：objective">
                        <TextInput
                          value={wizard.newGroupObjective}
                          ariaLabel="场景目标"
                          onChange={(v) => setWizard({ ...wizard, newGroupObjective: v })}
                        />
                      </FieldRow>
                      <div className="grid grid-cols-2 gap-3">
                        <FieldRow label="场景图标">
                          <IconPicker value={wizard.newGroupIcon} onChange={(v) => setWizard({ ...wizard, newGroupIcon: v ?? 'compass' })} />
                        </FieldRow>
                        <FieldRow label="主题色">
                          <ColorPair value={wizard.newGroupTheme} onChange={(v) => setWizard({ ...wizard, newGroupTheme: v ?? ['#6366f1', '#818cf8'] })} />
                        </FieldRow>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="角色 id" hint="全局唯一，创建后不可改">
                      <TextInput
                        value={wizard.id}
                        mono
                        ariaLabel="角色 id"
                        placeholder="如 critic"
                        onChange={(v) => setWizard({ ...wizard, id: v })}
                      />
                    </FieldRow>
                    <FieldRow label="name" hint="显示名">
                      <TextInput
                        value={wizard.name}
                        ariaLabel="角色名"
                        placeholder="如 挑刺官"
                        onChange={(v) => setWizard({ ...wizard, name: v })}
                      />
                    </FieldRow>
                    <FieldRow label="role" hint="角色徽标">
                      <TextInput
                        value={wizard.role}
                        ariaLabel="角色徽标"
                        placeholder="如 质量评审"
                        onChange={(v) => setWizard({ ...wizard, role: v })}
                      />
                    </FieldRow>
                    <FieldRow label="title" hint="选填">
                      <TextInput value={wizard.title} ariaLabel="头衔" onChange={(v) => setWizard({ ...wizard, title: v })} />
                    </FieldRow>
                  </div>
                  <FieldRow label="description" hint="选填：名片描述">
                    <TextInput value={wizard.description} ariaLabel="描述" onChange={(v) => setWizard({ ...wizard, description: v })} />
                  </FieldRow>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="头像图标" hint="无 avatar.png 时的回退">
                      <IconPicker value={wizard.icon} onChange={(v) => setWizard({ ...wizard, icon: v ?? 'user' })} />
                    </FieldRow>
                    <FieldRow label="渐变配色">
                      <ColorPair value={wizard.gradient} onChange={(v) => setWizard({ ...wizard, gradient: v ?? ['#6366f1', '#818cf8'] })} />
                    </FieldRow>
                  </div>
                  <FieldRow label="人设正文（Markdown 模板）" hint="创建后可在「编辑 → 人设」细化">
                    <textarea
                      value={wizard.body}
                      rows={7}
                      aria-label="人设正文"
                      onChange={(e) => setWizard({ ...wizard, body: e.target.value })}
                      className="block w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-[12px] leading-5 outline-none placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-primary/15"
                    />
                  </FieldRow>
                </>
              )}
              {wizardError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11.5px] text-destructive">
                  {wizardError}
                </div>
              )}
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            {wizard?.step === 2 && (
              <Button variant="ghost" size="sm" onClick={() => setWizard(wizard ? { ...wizard, step: 1 } : undefined)}>
                上一步
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setWizard(undefined)}>
              取消
            </Button>
            {wizard?.step === 1 ? (
              <Button size="sm" onClick={wizardNext}>
                下一步
              </Button>
            ) : (
              <Button size="sm" disabled={creating} onClick={() => void wizardSubmit()}>
                {creating && <Loader2 className="size-3.5 animate-spin" />}
                创建
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认（软删除；409 引用清单二次确认） */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(undefined)
            setDeleteRefs(undefined)
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>删除角色「{deleteTarget?.name}」</DialogTitle>
            <DialogDescription>
              {deleteRefs
                ? `该角色被 ${deleteRefs.length} 处引用，删除后这些引用将失效（会话成员 / 交接对象 / 编制链等）。`
                : '将软删除到回收站 data/trash/assets/（无 Git 环境的安全兜底，可手动恢复文件）。'}
            </DialogDescription>
          </DialogHeader>
          {deleteRefs && deleteRefs.length > 0 && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
              <ul className="space-y-1">
                {deleteRefs.map((r) => (
                  <li key={r} className="flex gap-1.5 text-[11.5px]">
                    <span className="text-destructive">•</span>
                    <span className="min-w-0 flex-1 break-words">{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDeleteTarget(undefined)
                setDeleteRefs(undefined)
              }}
            >
              取消
            </Button>
            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void doDelete(!!deleteRefs)}>
              {deleting && <Loader2 className="size-3.5 animate-spin" />}
              {deleteRefs ? '仍要删除（引用将失效）' : '移入回收站'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 编辑器抽屉 */}
      {editingId && <AgentEditor agentId={editingId} onClose={closeEditor} />}
    </div>
  )
}
