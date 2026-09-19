/**
 * M26：Skill 管理（卡片网格 + 引用统计 + 新建 / 复制 / 软删除）。
 * - 卡片：名称 / 行数 / 标签 + 说明（2 行截断）+ 引用统计（被 X 个 Agent 预载、Y 个场景兜底引用）；
 * - 新建：name（= skills/<name>/ 目录名，全局唯一）+ description → 创建后直接进入编辑器；
 * - 复制：读详情后以 <name>-copy 系列命名创建（name 冲突自动递增后缀）；
 * - 删除：软删除到回收站；有引用时 409 + 清单 → 二次确认后 force。
 */
import * as React from 'react'
import { BookOpen, Copy, Loader2, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ConsoleSkillSummary } from '@multi-agent/shared'
import { ApiError } from '../../lib/api'
import { useConsoleStore } from '../../stores/console-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { FieldRow, TextInput } from './fields'
import { SkillEditor } from './SkillEditor'
import { ValidateBanner } from './ValidateBanner'

const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/

export function SkillConsole(): React.JSX.Element {
  const skills = useConsoleStore((s) => s.skills)
  const loading = useConsoleStore((s) => s.loading)
  const [query, setQuery] = React.useState('')
  const [editingName, setEditingName] = React.useState<string>()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createName, setCreateName] = React.useState('')
  const [createDescription, setCreateDescription] = React.useState('')
  const [createError, setCreateError] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<ConsoleSkillSummary>()
  const [deleteRefs, setDeleteRefs] = React.useState<string[]>()
  const [deleting, setDeleting] = React.useState(false)
  const [copying, setCopying] = React.useState<string>()

  React.useEffect(() => {
    void useConsoleStore.getState().refreshAll()
  }, [])

  const closeEditor = React.useCallback(() => setEditingName(undefined), [])

  const keyword = query.trim().toLowerCase()
  const filtered = React.useMemo(
    () =>
      skills.filter((s) => {
        if (!keyword) return true
        return (
          s.name.toLowerCase().includes(keyword) ||
          s.description.toLowerCase().includes(keyword) ||
          s.tags.some((t) => t.toLowerCase().includes(keyword))
        )
      }),
    [skills, keyword],
  )

  const openCreate = (): void => {
    setCreateName('')
    setCreateDescription('')
    setCreateError('')
    setCreateOpen(true)
  }

  const submitCreate = async (): Promise<void> => {
    const name = createName.trim()
    if (!SKILL_NAME_RE.test(name)) {
      setCreateError('name 需小写字母开头、仅含字母 / 数字 / 连字符（≤40）——name 即目录名，全局唯一')
      return
    }
    if (!createDescription.trim()) {
      setCreateError('description 不能为空（说明何时使用该技能）')
      return
    }
    setCreating(true)
    try {
      await useConsoleStore.getState().createSkill(name, {
        description: createDescription.trim(),
        tags: [],
        body: `# ${name}\n\n（在此编写技能正文：适用场景 / 步骤 / 输出规范）\n`,
      })
      setCreateOpen(false)
      toast(`技能「${name}」已创建，请在编辑器中完善正文`)
      setEditingName(name)
    } catch (err) {
      setCreateError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  /** 复制：读详情 → 以 <name>-copy 系列命名创建（suffix 冲突自动递增） */
  const doCopy = async (s: ConsoleSkillSummary): Promise<void> => {
    setCopying(s.name)
    try {
      const detail = await useConsoleStore.getState().getSkill(s.name)
      for (const suffix of ['-copy', '-copy-2', '-copy-3', '-copy-4']) {
        const candidate = s.name.slice(0, Math.max(1, 40 - suffix.length)) + suffix
        try {
          await useConsoleStore.getState().createSkill(candidate, {
            description: detail.description,
            tags: detail.tags,
            body: detail.body,
          })
          toast(`已复制为「${candidate}」`)
          return
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) continue
          throw err
        }
      }
      toast.error('复制失败：-copy 系列名称均已占用')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setCopying(undefined)
    }
  }

  const doDelete = async (force: boolean): Promise<void> => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await useConsoleStore.getState().deleteSkill(deleteTarget.name, force)
      toast(`技能「${deleteTarget.name}」已移入回收站`)
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Sparkles className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold">Skill 管理</span>
        <span className="text-[11px] text-muted-foreground">{skills.length} 个技能</span>
        <div className="ml-auto flex items-center gap-2">
          <ValidateBanner />
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-3.5" />
            新建 Skill
          </Button>
        </div>
      </div>

      {/* 搜索 */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            aria-label="搜索技能"
            placeholder="搜索名称 / 说明 / 标签…"
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-card pl-7 pr-2 text-[12.5px] shadow-sm transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/15"
          />
        </div>
        {keyword && <span className="text-[11px] text-muted-foreground">筛出 {filtered.length} 个技能</span>}
      </div>

      {/* 列表（卡片网格） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && skills.length === 0 && (
          <div className="flex items-center justify-center py-16 text-[12px] text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在加载技能库…
          </div>
        )}
        {!loading && skills.length === 0 && (
          <div className="rounded-lg border border-dashed px-4 py-16 text-center">
            <div className="text-[13px] font-medium">还没有 Skill</div>
          </div>
        )}
        {filtered.length > 0 && (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
            {filtered.map((s) => (
              <article
                key={s.name}
                className="flex flex-col rounded-lg border bg-card p-3 transition-colors hover:border-primary/30"
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
                    <BookOpen className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[12.5px] font-semibold">{s.name}</span>
                      <span className="shrink-0 text-[10.5px] text-muted-foreground">{s.lineCount} 行</span>
                    </div>
                    {s.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.tags.slice(0, 4).map((t) => (
                          <span key={t} className="rounded-full bg-accent px-1.5 text-[10.5px] text-accent-foreground">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => setEditingName(s.name)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="复制"
                      disabled={copying === s.name}
                      onClick={() => void doCopy(s)}
                    >
                      {copying === s.name ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除（软删除到回收站）"
                      onClick={() => {
                        setDeleteTarget(s)
                        setDeleteRefs(undefined)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 min-w-0 text-[11.5px] text-muted-foreground">{s.description}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
                  {s.usedByAgents.length > 0 && <Badge variant="outline">角色 · {s.usedByAgents.length}</Badge>}
                  {s.usedByGroups.length > 0 && <Badge variant="outline">场景 · {s.usedByGroups.length}</Badge>}
                  {s.usedByAgents.length === 0 && s.usedByGroups.length === 0 && <Badge variant="outline">未引用</Badge>}
                </div>
              </article>
            ))}
          </div>
        )}
        {!loading && skills.length > 0 && filtered.length === 0 && (
          <div className="py-16 text-center text-[12px] text-muted-foreground">没有匹配的技能</div>
        )}
      </div>

      {/* 新建 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建 Skill</DialogTitle>
          </DialogHeader>
          <div className="mt-3 space-y-3">
            <FieldRow label="name" hint="小写字母 / 数字 / 连字符">
              <TextInput
                value={createName}
                mono
                ariaLabel="技能名"
                placeholder="如 weekly-report"
                onChange={setCreateName}
              />
            </FieldRow>
            <FieldRow label="description" hint="说明「何时使用」，会进入模型工具提示">
              <TextInput
                value={createDescription}
                ariaLabel="技能说明"
                placeholder="如：编写结构化周报时使用"
                onChange={setCreateDescription}
              />
            </FieldRow>
            {createError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11.5px] text-destructive">
                {createError}
              </div>
            )}
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button size="sm" disabled={creating} onClick={() => void submitCreate()}>
              {creating && <Loader2 className="size-3.5 animate-spin" />}
              创建并编辑
            </Button>
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
            <DialogTitle>删除技能「{deleteTarget?.name}」</DialogTitle>
            <DialogDescription>
              {deleteRefs
                ? `该技能被 ${deleteRefs.length} 处引用，删除后这些引用将失效（角色预载 / 场景兜底）。`
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
      {editingName && <SkillEditor name={editingName} onClose={closeEditor} />}
    </div>
  )
}
