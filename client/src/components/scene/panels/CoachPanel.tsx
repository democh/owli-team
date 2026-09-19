/**
 * M52-A 面板 · coach 陪跑面板（§7.4）：进度环 + 打卡格 + 交付件——
 * 数据源：最近的 `::: checklist` 容器 + sessionStorage 勾选覆盖（`ma:sc:checks:*`，打卡点亮不落库）。
 */
import * as React from 'react'
import { CalendarCheck } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { useSceneCtx } from '../context'
import { artifactsOf, checklistItemsOf } from '../derive'
import { loadChecks, saveChecks } from '../persist'
import { CheckGrid, DeliveryPanel, ProgressRing, type CheckCell } from '../parts'
import { useSceneContainers, useSceneMessages } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

interface CoachChecklist {
  /** 容器稳定键（messageId:seq）——勾选覆盖以它为前缀，清单更替即换新覆盖组 */
  key: string
  title: string
  cells: CheckCell[]
}

/** 逐场景空态文案（与 board 同模式：7 场景语汇各异，未收录场景用中性默认兜底） */
interface CoachCopy {
  emptyText: string
  emptyHint: string
}

const COACH_COPY: Record<string, CoachCopy> = {
  // 健康生活：三轨打卡格 + 周计划
  health: { emptyText: '打卡与周计划将在这里显示', emptyHint: '教练给出计划后即可在此打卡，点亮进度实时同步' },
  // 学习成长：学习路径 + 打卡
  learning: { emptyText: '学习路径与打卡将在这里显示', emptyHint: '教练规划路径后即可按节点打卡，进度实时同步' },
  // 出行旅行：行程表 + 预算条
  travel: { emptyText: '行程与预算将在这里显示', emptyHint: '教练排好行程后即可逐日查看，预算与日程实时同步' },
  // 财富管理：预算环 + 目标进度
  wealth: { emptyText: '预算与目标进度将在这里显示', emptyHint: '教练定下目标后即可在此跟进，储蓄进度实时同步' },
  // 个人管理：事务清单 + 习惯打卡
  personal: { emptyText: '事务清单与提醒将在这里显示', emptyHint: '教练梳理事务后即可逐项跟进，提醒与打卡实时同步' },
  // 职业发展：求职进度环 + 产出物清单
  career: { emptyText: '求职进度与产出物将在这里显示', emptyHint: '教练规划阶段后即可在此跟进，产出物清单实时同步' },
  // 照护助手：排班表 + 就医 / 康养清单
  care: { emptyText: '照护排班与清单将在这里显示', emptyHint: '教练排出班次后即可逐项勾选，清单进度实时同步' },
}

const COACH_COPY_DEFAULT: CoachCopy = {
  emptyText: '清单与进度将在这里显示',
  emptyHint: '教练给出清单后，进度与产出会自动跟进',
}

/** checklist 容器无标题时的兜底（场景语汇「XX 清单」；未收录场景用中性默认） */
const COACH_TITLES: Record<string, string> = {
  health: '打卡清单',
  learning: '学习清单',
  travel: '行程清单',
  wealth: '目标清单',
  personal: '事务清单',
  career: '求职清单',
  care: '照护清单',
}

const COACH_TITLE_DEFAULT = '清单'

export function CoachPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const sessionId = ctx?.sessionId ?? ''
  const containers = useSceneContainers()
  const messages = useSceneMessages()

  // 最近的 checklist 容器（多份清单时以最新为准）
  const checklist = React.useMemo((): CoachChecklist | undefined => {
    for (let i = containers.length - 1; i >= 0; i--) {
      const c = containers[i]!
      if (c.name !== 'checklist') continue
      return {
        key: `${c.messageId}:${c.seq}`,
        title: c.arg || '',
        cells: checklistItemsOf(c.lines).map((it) => ({ id: it.id, label: it.label, checked: it.checked })),
      }
    }
    return undefined
  }, [containers])

  const [overrides, setOverrides] = React.useState<Map<string, boolean>>(() => loadChecks(sessionId))
  React.useEffect(() => {
    setOverrides(loadChecks(sessionId))
  }, [sessionId])

  const cells = React.useMemo(() => {
    if (!checklist) return []
    return checklist.cells.map((c) => ({
      ...c,
      checked: overrides.get(`${checklist.key}:${c.id}`) ?? c.checked,
    }))
  }, [checklist, overrides])

  const done = cells.filter((c) => c.checked).length
  const pct = cells.length === 0 ? 0 : Math.round((done / cells.length) * 100)

  const onToggle = (id: string, next: boolean): void => {
    if (!checklist) return
    setOverrides((prev) => {
      const m = new Map(prev)
      m.set(`${checklist.key}:${id}`, next)
      saveChecks(sessionId, m)
      return m
    })
  }

  const deliveries = React.useMemo(() => artifactsOf(messages), [messages])

  const groupId = ctx?.group?.id ?? ''
  const copy = COACH_COPY[groupId] ?? COACH_COPY_DEFAULT
  const listTitle = COACH_TITLES[groupId] ?? COACH_TITLE_DEFAULT

  if (!checklist) {
    return (
      <PanelShell title="陪跑面板" icon={CalendarCheck}>
        <PanelEmpty icon={CalendarCheck} text={copy.emptyText} hint={copy.emptyHint} />
      </PanelShell>
    )
  }

  return (
    <PanelShell title="陪跑面板" icon={CalendarCheck}>
      <div className="scene-coach">
        <div className="scene-coach-top">
          <ProgressRing value={pct} size={72} label="完成" sublabel={`${done}/${cells.length}`} />
          <div className="scene-coach-meta">
            <div className="scene-coach-title">{checklist.title || listTitle}</div>
            <button
              type="button"
              className="scene-coach-report"
              onClick={() => ctx?.insert(`当前清单已完成 ${done}/${cells.length} 项，请确认进度并给出下一步建议。`)}
            >
              汇报进度
            </button>
          </div>
        </div>
        <CheckGrid items={cells} onToggle={onToggle} />
        {deliveries.length > 0 ? (
          <section className="scene-board-sec">
            <div className="scene-board-cap">产出物</div>
            <DeliveryPanel
              items={deliveries.map((path) => ({ path }))}
              onOpen={(path) => useUiStore.getState().requestArtifact(path)}
            />
          </section>
        ) : null}
      </div>
    </PanelShell>
  )
}
