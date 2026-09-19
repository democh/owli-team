/**
 * M65-C：方案书打印视图（§7.7，轻量——零新依赖）——A4 视觉组合页 + 浏览器打印存 PDF。
 *
 * 内容源（全部只读派生，冻结口径）：设计场景（平面图 / 房间清单）+ render 卡产物 +
 * styleboard 色卡；页脚固定「示意表现」声明。打印经 @media print：仅保留 sheet。
 * 数据组装（containers → photoPaths / swatches / texture）由 StudioPanel 完成（§7.7 分工）。
 */
import * as React from 'react'
import { Printer, X } from 'lucide-react'
import type { DesignScene } from '@multi-agent/shared'
import { artifactContentUrl } from '../../lib/artifacts'
import { useSessionStore } from '../../stores/session-store'
import { roomAreaM2 } from './design-scene-model'
import { StudioPlanView } from './StudioPlanView'
import type { SwatchData } from '../chat/md-ext/remark-ext'

export interface StudioPrintSheetProps {
  scene: DesignScene
  /** render 卡产物路径（按出现序去重） */
  photoPaths: string[]
  /** 风格板色卡（最近一块） */
  swatches: SwatchData[]
  texture?: string
  onClose: () => void
}

export function StudioPrintSheet({
  scene,
  photoPaths,
  swatches,
  texture,
  onClose,
}: StudioPrintSheetProps): React.JSX.Element {
  const sessionId = useSessionStore((s) => s.currentId)
  const today = new Date().toLocaleDateString('zh-CN')

  // Esc 关闭（打印浮层语义）
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="studio-print-overlay" role="dialog" aria-label="方案书打印预览" data-studio-print>
      <div className="studio-print-bar studio-print-hide">
        <span>方案书打印预览（浏览器「打印 / 存为 PDF」）</span>
        <button type="button" className="studio-print-do" onClick={() => window.print()}>
          <Printer size={12} />
          打印 / 存为 PDF
        </button>
        <button type="button" className="studio-print-close" onClick={onClose} title="关闭（Esc）">
          <X size={12} />
          关闭
        </button>
      </div>
      <div className="studio-print-scroll">
        <div className="studio-print-sheet" data-studio-print-sheet>
          <header className="sp-cover">
            <h1>{scene.name}</h1>
            <p>家装设计方案 · {today} · 由 interior 家装设计工作室协作产出</p>
          </header>

          <section className="sp-sec">
            <h2>平面布局</h2>
            <div className="sp-plan">
              <StudioPlanView scene={scene} size={320} />
            </div>
            <table className="sp-roomtable">
              <thead>
                <tr>
                  <th>房间</th>
                  <th>面积</th>
                  <th>层高</th>
                </tr>
              </thead>
              <tbody>
                {scene.rooms.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{roomAreaM2(r.polygon)}㎡</td>
                    <td>{(r.height / 1000).toFixed(1)}m</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {photoPaths.length > 0 && sessionId ? (
            <section className="sp-sec">
              <h2>效果图（示意）</h2>
              <div className="sp-photos">
                {photoPaths.map((p, i) => (
                  <img key={i} src={artifactContentUrl(sessionId, p)} alt={`效果图 ${i + 1}`} />
                ))}
              </div>
            </section>
          ) : null}

          {swatches.length > 0 || texture ? (
            <section className="sp-sec">
              <h2>风格与材质</h2>
              <div className="sp-swatches">
                {swatches.map((s, i) => (
                  <div key={i} className="sp-swatch">
                    <span className="sp-swatch-chip" style={{ background: s.hex }} aria-hidden />
                    <span className="sp-swatch-name">{s.name}</span>
                    <span className="sp-swatch-hex">{s.hex}</span>
                    <span className="sp-swatch-usage">{s.usage}</span>
                  </div>
                ))}
              </div>
              {texture ? <p className="sp-texture">质感：{texture}</p> : null}
            </section>
          ) : null}

          <footer className="sp-foot">
            效果图为示意表现（材质 / 光照 / 色差以实物为准）；平面与三维方案以 design/*.scene.json 数据为准。
          </footer>
        </div>
      </div>
    </div>
  )
}
