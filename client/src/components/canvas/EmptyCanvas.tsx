/**
 * M31：画布空态 —— 四模板卡片（创作台 / 脑图工坊 / 分镜台 / 素材墙）+ 快捷操作提示。
 * 卡片 hover 微动效；模板落位后节点入场动画由 .canvas-node-pop 呈现。
 */
import * as React from 'react'
import { Clapperboard, Frame, Images, Lightbulb, Network, Sparkles, StickyNote, Upload, type LucideIcon } from 'lucide-react'
import { CANVAS_TEMPLATES, type CanvasTemplateId } from '../../lib/canvas-templates'

const TEMPLATE_ICON: Record<CanvasTemplateId, LucideIcon> = {
  studio: Sparkles,
  mind: Network,
  storyboard: Clapperboard,
  wall: Images,
}

export function EmptyCanvas({ onApply }: { onApply(id: CanvasTemplateId): void }): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-lg rounded-2xl border bg-card/95 p-6 shadow-soft backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-muted/40">
            <Frame className="size-4 text-primary/60" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">空白画布</div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              从模板开始，或双击空白处随手放一个便签。
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {CANVAS_TEMPLATES.map((t) => {
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
