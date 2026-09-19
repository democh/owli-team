/**
 * M26：Skill 编辑器（右侧抽屉）。
 * - front-matter 表单（description / tags）+ 正文 Markdown 编辑 / 预览（复用 chat/Markdown）；
 * - name（= skills/<name>/ 目录名）创建后不可改：改名 = 新建 + 删除；
 * - 保存走 updateSkill，写盘后服务端广播 notify:assets-changed（多标签/当前页自动刷新）。
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ConsoleSkillDetail } from '@multi-agent/shared'
import { useConsoleStore } from '../../stores/console-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { FieldRow, MarkdownField, TagInput, TextInput } from './fields'

interface SkillDraft {
  description: string
  tags: string[]
  body: string
}

export function SkillEditor({ name, onClose }: { name: string; onClose: () => void }): React.JSX.Element {
  const [detail, setDetail] = React.useState<ConsoleSkillDetail>()
  const [draft, setDraft] = React.useState<SkillDraft>()
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const d = await useConsoleStore.getState().getSkill(name)
        if (cancelled) return
        setDetail(d)
        setDraft({ description: d.description, tags: d.tags, body: d.body })
      } catch (err) {
        if (!cancelled) {
          toast.error((err as Error).message)
          onClose()
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [name, onClose])

  const patch = (p: Partial<SkillDraft>): void => setDraft((d) => (d ? { ...d, ...p } : d))

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.description.trim()) {
      toast.error('description 不能为空（说明何时使用该技能）')
      return
    }
    if (!draft.body.trim()) {
      toast.error('技能正文不能为空')
      return
    }
    setSaving(true)
    try {
      await useConsoleStore.getState().updateSkill(name, {
        description: draft.description.trim(),
        tags: draft.tags,
        body: draft.body,
      })
      toast(`技能「${name}」已保存`)
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label={`编辑技能 ${name}`}>
      <div className="min-w-0 flex-1 bg-foreground/25 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div className="flex h-full w-[720px] max-w-[94vw] flex-col border-l bg-card shadow-2xl">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="truncate text-[13px] font-semibold">编辑技能</span>
          <span className="font-mono text-[11px] text-muted-foreground">{name}</span>
          {detail && (
            <span className="ml-auto flex items-center gap-1.5">
              <Badge variant="outline">{detail.lineCount} 行</Badge>
              {detail.usedByAgents.length > 0 && <Badge variant="outline">被 {detail.usedByAgents.length} 个 Agent 预载</Badge>}
              {detail.usedByGroups.length > 0 && (
                <Badge variant="outline">{detail.usedByGroups.length} 个场景兜底引用</Badge>
              )}
            </span>
          )}
        </div>

        {loading || !draft || !detail ? (
          <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在加载技能…
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
            <FieldRow label="name（目录名）" hint="创建后不可改；改名 = 新建 + 删除">
              <span className="inline-block rounded-md border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-[12px]">
                {name}
              </span>
            </FieldRow>
            <FieldRow label="description" hint="说明「何时使用」，会进入模型工具提示">
              <TextInput
                value={draft.description}
                ariaLabel="技能描述"
                placeholder="例如：编写结构化周报时使用（触发条件 / 产出形态）"
                onChange={(v) => patch({ description: v })}
              />
            </FieldRow>
            <FieldRow label="tags" hint="回车 / 逗号提交">
              <TagInput value={draft.tags} onChange={(v) => patch({ tags: v })} placeholder="如 汇报, 写作" />
            </FieldRow>
            {(detail.usedByAgents.length > 0 || detail.usedByGroups.length > 0) && (
              <div className="rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-[11.5px] text-amber-800">
                引用影响面：
                {detail.usedByAgents.length > 0 && <> 角色 {detail.usedByAgents.join('、')} 预载本技能；</>}
                {detail.usedByGroups.length > 0 && <> 场景 {detail.usedByGroups.join('、')} 作为默认兜底；</>}
                修改正文后对正在运行的会话下一回合生效。
              </div>
            )}
            <FieldRow label="正文（Markdown）" hint="保存前做 zod / front-matter 自检，写出的文件必可被技能库加载">
              <MarkdownField
                value={draft.body}
                rows={20}
                placeholder={'# 技能名\n\n## 适用场景\n\n## 步骤\n'}
                onChange={(v) => patch({ body: v })}
              />
            </FieldRow>
          </div>
        )}

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
