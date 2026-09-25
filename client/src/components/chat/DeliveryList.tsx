/**
 * 交付展示组件族（M37-6 修订）：交付件在对话流内从「chips」升级为「明细行」——
 * 类型图标（kind 色系与交付件浏览器同源）+ 目录 + 文件名 + 体积 + 交付者头像（可选）；
 * 行点击打开交付件视图，悬停浮现「送上画布」。
 * 元数据（kind / size）经 useArtifactMeta 会话级共享缓存补齐；缺失时回退「通用图标 + 名称」。
 * M39（§97，DEV-2）：工序卡增强——交付明细行补阶段标签（development 阶段映射，ADR 0149）与
 * 悬停预览 popover（懒挂载：悬停才渲染元信息卡——完整路径 / 类型 / 体积 / 交付者与阶段）；
 * 消息内行经 DeliveryFiles 透传消息作者。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  BarChart3,
  File as FileIcon,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType2,
  Frame,
  Globe,
  Image as ImageIcon,
  Package,
  Table2,
  Video,
} from 'lucide-react'
import type { AgentDefinition, Artifact, ArtifactKind } from '@multi-agent/shared'
import { useArtifactMeta } from '../../lib/use-artifact-meta'
import { baseName, extOf } from '../../lib/artifacts'
import { stageOf } from '../../lib/stage-map'
import { humanSize } from '../../lib/time'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useCanvasStore } from '../../stores/canvas-store'
import { useUiStore } from '../../stores/ui-store'
import { AgentAvatar } from '../agents/AgentAvatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useSceneCtx } from '../scene/context'

/** 类型视觉（图标 + 底色，与交付件浏览器 / 图谱档案同色系） */
const KIND_VISUAL: Record<ArtifactKind, { icon: React.JSX.Element; tone: string }> = {
  markdown: { icon: <FileText className="size-3.5" />, tone: 'bg-blue-500/10 text-blue-600' },
  code: { icon: <FileCode2 className="size-3.5" />, tone: 'bg-emerald-500/10 text-emerald-600' },
  html: { icon: <Globe className="size-3.5" />, tone: 'bg-cyan-500/10 text-cyan-600' },
  chart: { icon: <BarChart3 className="size-3.5" />, tone: 'bg-violet-500/10 text-violet-600' },
  data: { icon: <Table2 className="size-3.5" />, tone: 'bg-amber-500/10 text-amber-600' },
  image: { icon: <ImageIcon className="size-3.5" />, tone: 'bg-pink-500/10 text-pink-600' },
  video: { icon: <Video className="size-3.5" />, tone: 'bg-rose-500/10 text-rose-600' },
  office: { icon: <FileSpreadsheet className="size-3.5" />, tone: 'bg-orange-500/10 text-orange-600' },
  pdf: { icon: <FileType2 className="size-3.5" />, tone: 'bg-red-500/10 text-red-600' },
  other: { icon: <FileIcon className="size-3.5" />, tone: 'bg-muted text-muted-foreground' },
}

/** 元数据缺失时按扩展名粗判（仅影响图标观感；真实 kind 以服务端为准） */
const EXT_KIND: Record<string, ArtifactKind> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  csv: 'data',
  tsv: 'data',
  json: 'data',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  docx: 'office',
  xlsx: 'office',
  pptx: 'office',
  doc: 'office',
  xls: 'office',
  ppt: 'office',
  pdf: 'pdf',
}

/** 类型中文名（预览 popover 用） */
const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: '文档',
  code: '代码',
  html: '网页',
  chart: '图表',
  data: '数据表',
  image: '图片',
  video: '视频',
  office: '办公文档',
  pdf: 'PDF',
  other: '文件',
}

/** 目录前缀（无目录返回 ''） */
function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i > 0 ? filePath.slice(0, i) : ''
}

function VisualMark({ kind }: { kind: ArtifactKind }): React.JSX.Element {
  const visual = KIND_VISUAL[kind]
  return (
    <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', visual.tone)}>
      {visual.icon}
    </span>
  )
}

/** 交付明细行：图标 + 目录/文件名 + 阶段 + 版本 + 交付者（可选）+ 体积 + 悬停预览与「送上画布」 */
export function ArtifactRow({
  path,
  meta,
  author,
  stage,
  version,
  trailing,
}: {
  path: string
  /** 会话交付件元数据（缺省：按扩展名粗判图标、不显示体积） */
  meta?: Artifact
  /** 交付者（收尾清单按作者归集时透传；消息内不重复渲染作者） */
  author?: AgentDefinition
  /** M39：阶段标签（development 阶段映射；未收录场景缺省不渲染） */
  stage?: string
  /** M44（AF-2）：版本徽章（版本列表就绪时透传；缺省不渲染） */
  version?: number
  /** M44（AF-4）：行尾附加槽位（如「回应了你的意见」角标） */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const requestArtifact = useUiStore((s) => s.requestArtifact)
  const name = baseName(path)
  const dir = dirOf(path)
  const kind = meta?.kind ?? EXT_KIND[extOf(path)] ?? 'other'
  const toCanvas = async (): Promise<void> => {
    const id = await useCanvasStore.getState().sendArtifact(path)
    if (id) toast.success('已送上画布 · 顶部「画布」Tab 查看')
  }
  return (
    <div
      data-delivery-row={path}
      {...(stage ? { 'data-delivery-stage': stage } : {})}
      className="group/row flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-primary/[0.05]"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => requestArtifact(path)}
            title={`打开交付件：${path}`}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <VisualMark kind={kind} />
            <span className="min-w-0 flex-1 truncate">
              {dir && <span className="mr-1 text-[10px] text-muted-foreground/60">{dir}/</span>}
              <span className="text-[12px] font-medium text-foreground/90 transition-colors group-hover/row:text-primary">
                {name}
              </span>
            </span>
            {stage ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium leading-[1.7] text-primary">
                {stage}
              </span>
            ) : null}
            {typeof version === 'number' ? (
              <span
                data-delivery-version={version}
                title={`当前版本 v${version}`}
                className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums leading-[1.7] text-muted-foreground"
              >
                v{version}
              </span>
            ) : null}
          </button>
        </TooltipTrigger>
        {/* 预览 popover（懒挂载：悬停才渲染）——路径 / 类型 / 体积 / 交付者与阶段 */}
        <TooltipContent side="top" align="start" className="max-w-80">
          <div data-delivery-preview={path} className="space-y-0.5">
            <div className="break-all font-medium">{path}</div>
            <div className="text-muted-foreground">
              {KIND_LABEL[kind]}
              {meta ? ` · ${humanSize(meta.size)}` : ''}
              {author ? ` · ${author.name}` : ''}
              {stage ? ` · ${stage}` : ''}
            </div>
            <div className="text-muted-foreground/75">点击打开交付件 · 行尾「送上画布」</div>
          </div>
        </TooltipContent>
      </Tooltip>
      {trailing}
      {author && (
        <AgentAvatar
          agent={author}
          size={16}
          animated={false}
          className="shrink-0 ring-1 ring-border"
          title={`由 ${author.name} 交付`}
        />
      )}
      {meta && <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/80">{humanSize(meta.size)}</span>}
      <button
        type="button"
        onClick={() => void toCanvas()}
        aria-label="送上画布"
        title="送上画布（作为画布素材节点）"
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary focus-visible:opacity-100 group-hover/row:opacity-100"
      >
        <Frame className="size-3" />
      </button>
    </div>
  )
}

/** 消息内交付区块：标题行（交付 · N）+ 明细行列表；M39：透传消息作者 → 阶段标签与头像 */
export function DeliveryFiles({ paths, agentId }: { paths: string[]; agentId?: string }): React.JSX.Element {
  const meta = useArtifactMeta()
  const ctx = useSceneCtx()
  const agents = useAgentStore((s) => s.agents)
  const author = agentId ? agents.find((a) => a.id === agentId) : undefined
  const stage = stageOf(ctx?.group?.id, agentId)
  return (
    <div className="mt-2 border-t border-primary/[0.08] pt-2">
      <div className="mb-1 flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground">
        <Package className="size-3.5 text-primary/70" />
        交付 · {paths.length}
      </div>
      <div className="space-y-0.5">
        {paths.map((p) => (
          <ArtifactRow key={p} path={p} meta={meta.get(p)} author={author} stage={stage} />
        ))}
      </div>
    </div>
  )
}
