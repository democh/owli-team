/**
 * M31：画布空态 —— 四模板卡片（创作台 / 脑图工坊 / 分镜台 / 素材墙）+ 快捷操作提示。
 * 卡片 hover 微动效；模板落位后节点入场动画由 .canvas-node-pop 呈现。
 * M31 修订：模板按媒体能力门控——创作台（studio）需生图、分镜台（storyboard）需生视频，
 * 未配置即不展示（脑图工坊 / 素材墙不依赖生成，恒显）。
 */
import * as React from 'react'
import { Clapperboard, Frame, Images, Lightbulb, Network, Sparkles, StickyNote, Upload, type LucideIcon } from 'lucide-react'
import { CANVAS_TEMPLATES, type CanvasTemplateId } from '../../lib/canvas-templates'
import { useMediaCapabilities } from './useMediaCapabilities'

const TEMPLATE_ICON: Record<CanvasTemplateId, LucideIcon> = {
  studio: Sparkles,
  mind: Network,
  storyboard: Clapperboard,
  wall: Images,
}

/** 模板 → 能力需求（缺省 = 任能力即可；null = 恒显） */
const TEMPLATE_GATE: Record<CanvasTemplateId, 'image' | 'video' | null> = {
  studio: 'image',
  mind: null,
  storyboard: 'video',
  wall: null,
}

export function EmptyCanvas({ onApply }: { onApply(id: CanvasTemplateId): void }): React.JSX.Element {
  const { canImage, canVideo } = useMediaCapabilities()
  const templates = React.useMemo(
    () =>
      CANVAS_TEMPLATES.filter((t) => {
        const gate = TEMPLATE_GATE[t.id]
        return gate === null || (gate === 'image' ? canImage : canVideo)
      }),
    [canImage, canVideo],
  )
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-lg rounded-2xl border bg-card/95 p-6 shadow-soft backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-muted/40">
            <Frame className="size-4 text-primary/60" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">空白画布</div>
            <p className="text-[11px] leading-4 text-muted-foreground">双击空白处放一个便签。</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {templates.map((t) => {
            const Icon = TEMPLATE_ICON[t.id]
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onApply(t.id)}
                className="group flex items-start gap-2.5 rounded-xl border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-soft"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40 transition-colors group-hover:border-primary/30 group-hover:bg-primary/10">
                  <Icon className="size-4 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium">{t.name}</span>
                  <span className="block text-[10.5px] leading-4 text-muted-foreground">{t.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-muted-foreground/80">
          <span className="flex items-center gap-1">
            <StickyNote className="size-3" aria-hidden />
            双击新建便签
          </span>
          <span className="flex items-center gap-1">
            <Upload className="size-3" aria-hidden />
            拖入图片 / 视频
          </span>
          <span className="flex items-center gap-1">
            <Lightbulb className="size-3" aria-hidden />
            画布随会话保存，切走再回来内容都在
          </span>
        </div>
      </div>
    </div>
  )
}
