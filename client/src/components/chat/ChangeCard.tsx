/**
 * M44（AF-2 / AF-4）：变更卡——消息产出交付件且伴随写类工具调用（write_file / apply_patch / edit_file）
 * 时，交付明细行升级为「变更」语义（与 DEV-2 同卡族，ArtifactRow 复用）：
 * - 每行：vN 徽章（版本列表懒加载，useArtifactVersions）+ 阶段 + 作者 + 悬停预览；
 * - 回应角标（AF-4）：闭合配对成立（本消息 = 其后同作者同文件变更）时，在对应文件行尾给
 *   「回应了你的意见」角标（title 携意见摘要）；
 * - 点击行 → 打开交付件（完整 Diff 在交付件工作台；ADR 0079：聊天流只做摘要与跳转）；
 * - 降级：版本列表未就绪 → 仅文件与作者（不阻塞渲染）。
 */
import * as React from 'react'
import { History } from 'lucide-react'
import type { ChatMessage } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useArtifactMeta } from '../../lib/use-artifact-meta'
import { useArtifactVersions } from '../../lib/artifact-versions'
import { artifactsOf } from '../scene/derive'
import { useSceneMessages } from '../scene/use-scene-data'
import { useSceneCtx } from '../scene/context'
import { closureOf, type OpinionRef } from '../../lib/focus-artifact'
import { stageOf } from '../../lib/stage-map'
import { ArtifactRow } from './DeliveryList'

/** 写类工具（变更语义判定依据；edit_file 亦为文件级写） */
export const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'edit_file'])

/** 该消息是否呈变更语义（产出交付件 + 伴随写类工具调用） */
export function isChangeMessage(message: ChatMessage): boolean {
  if (!message.artifacts || message.artifacts.length === 0) return false
  return (message.toolCalls ?? []).some((c) => WRITE_TOOLS.has(c.name))
}

function ChangeRow({
  path,
  authorId,
  responded,
  opinion,
}: {
  path: string
  authorId?: string
  responded: boolean
  opinion?: OpinionRef
}): React.JSX.Element {
  const meta = useArtifactMeta()
  const agents = useAgentStore((s) => s.agents)
  const ctx = useSceneCtx()
  const versions = useArtifactVersions(path)
  const latest = versions && versions.length > 0 ? versions[0] : undefined
  const author = authorId ? agents.find((a) => a.id === authorId) : undefined
  return (
    <ArtifactRow
      path={path}
      meta={meta.get(path)}
      author={author}
      stage={stageOf(ctx?.group?.id, authorId)}
      {...(latest ? { version: latest.version } : {})}
      {...(responded ? { trailing: <ResponseBadge opinion={opinion} /> } : {})}
    />
  )
}

/** AF-4 角标：回应了你的意见（title 携意见摘要） */
function ResponseBadge({ opinion }: { opinion?: OpinionRef }): React.JSX.Element {
  return (
    <span
      data-change-response=""
      title={opinion ? `回应意见：${opinion.excerpt}` : '回应了你的意见'}
      className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 text-[10px] font-medium leading-[1.7] text-emerald-600"
    >
      回应了你的意见
    </span>
  )
}

export function ChangeCard({ message }: { message: ChatMessage }): React.JSX.Element {
  const messages = useSceneMessages()
  const paths = message.artifacts ?? []
  // 会话级闭环（AF-4）：意见配对只在会话序内推导；本卡只取「本消息是否被配对为回应」
  const response = React.useMemo(() => {
    const all = artifactsOf(messages)
    return closureOf(messages, all).responseOf.get(message.id)
  }, [messages, message.id])

  return (
    <div className="mt-2 border-t border-primary/[0.08] pt-2" data-change-card="">
      <div className="mb-1 flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground">
        <History className="size-3.5 text-primary/70" />
        变更 · {paths.length}
      </div>
      <div className="space-y-0.5">
        {paths.map((p) => (
          <ChangeRow
            key={p}
            path={p}
            authorId={message.agentId}
            responded={response?.targetPath === p}
            {...(response ? { opinion: response } : {})}
          />
        ))}
      </div>
    </div>
  )
}
