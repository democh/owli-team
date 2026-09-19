/**
 * M63-A：盘面深化组件测试——神煞 chips / 柱间关系 / 小运 / 流月展开 / 紫微流年层 / 卦盘伏神·月日·回头。
 *
 * 复用 PanCard 全链（懒加载落定后断言）；旧卡（无新字段）→ 新 UI 区块不渲染（零回归）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { PanCard } from '../src/components/chat/md-ext/PanCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  useUiStore.setState({ composerInsert: undefined })
  sessionStorage.clear()
})

interface PanProps {
  kind: string
  title: string
  fields: string
  items: string
}

function panProps(text: string): PanProps {
  const lines = text.trim().split('\n')
  const head = /^::: pan (\w+)(?: (.*))?$/.exec(lines[0]!)!
  const fields: Array<{ label: string; value: string }> = []
  const items: Array<{ label: string; value: string }> = []
  for (const line of lines.slice(1)) {
    if (line.startsWith(':::') || line.trim() === '') continue
    if (line.startsWith('- ')) {
      const body = line.slice(2)
      const i = body.indexOf('|')
      items.push(i < 0 ? { label: body.trim(), value: '' } : { label: body.slice(0, i).trim(), value: body.slice(i + 1).trim() })
    } else {
      const i = line.indexOf('：')
      fields.push({ label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
    }
  }
  return { kind: head[1]!, title: (head[2] ?? '').trim(), fields: JSON.stringify(fields), items: JSON.stringify(items) }
}

async function renderBoard(fx: PanProps): Promise<HTMLElement> {
  const { container } = render(
    <MessageContext.Provider value={null}>
      <PanCard {...fx} />
    </MessageContext.Provider>,
  )
  await waitFor(() => expect(container.querySelector('.pn-board')).not.toBeNull())
  return container
}

function btnByText(container: HTMLElement, text: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  expect(el, `按钮缺失：${text}`).toBeTruthy()
  return el as HTMLButtonElement
}

function draft(): string {
  return useUiStore.getState().composerInsert?.text ?? ''
}

// ---------------------------------------------------------------------------
// fixture（与 server mock 深走查同源；八字取精简行以缩短用例）
// ---------------------------------------------------------------------------

const BAZI_DEEP = `
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
命造：乾造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八
四柱：庚午 辛巳 丁丑 丁未
十神：正财 偏财 日主 比肩
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
神煞：禄神（日干→年） ｜ 羊刃（日干→时） ｜ 桃花（日支→年） ｜ 华盖（日支→日）
柱间：地支 午丑害（年日）·午未合（年时）·丑未冲（日时）·巳午未三会火方（月年时）
运岁：大运甲申 · 甲庚冲（年）·申巳合（月） ｜ 流年丙午 · 丙辛合（月）
小运：丙子（29岁） ｜ 丁丑（30岁） ｜ 戊寅（31岁）
起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行
- 大运 壬午 | 9-18 岁 ｜ 1998-2007
- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运
- 流年 2026 丙午 | 37 岁 · 当前
- 流年 2027 丁未 | 38 岁
流月：2026 丙午
- 流月 庚寅 | 正月
- 流月 辛卯 | 二月
- 流月 壬辰 | 三月
:::
`

const BAZI_OLD = `
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
命造：乾造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八
四柱：庚午 辛巳 丁丑 丁未
十神：正财 偏财 日主 比肩
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行
- 大运 壬午 | 9-18 岁 ｜ 1998-2007
- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运
- 流年 2026 丙午 | 37 岁 · 当前
:::
`

const ZIWEI_SUI = `
::: pan ziwei 紫微 土五局 ｜ 命宫 丙戌
命造：乾造 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八 ｜ 未时（13:00~15:00）
四柱：庚午 辛巳 丁丑 丁未 ｜ 生肖 马 ｜ 星座 金牛座
五行局：土五局 ｜ 命主 禄存 ｜ 身主 火星
命身宫：命宫 丙戌 ｜ 身宫 福德 戊子
生年四化：禄 太阳 ｜ 权 武曲 ｜ 科 太阴 ｜ 忌 天同
流年：2026 丙午 ｜ 流年命宫 财帛 ｜ 流年四化 禄 天同 ｜ 权 天机 ｜ 科 文昌 ｜ 忌 廉贞
- 官禄 戊寅 | 天同(利)忌 天梁(庙) ｜ 长生 病 ｜ 大限 45-54
- 仆役 己卯 | 武曲(利)权 七杀(旺) ｜ 长生 死 ｜ 大限 55-64
- 迁移 庚辰 | 太阳(旺)禄 ｜ 长生 墓 ｜ 大限 65-74
- 疾厄 辛巳 | （空宫） ｜ 长生 绝 ｜ 大限 75-84
- 财帛 壬午 | 天机(庙) ｜ 长生 胎 ｜ 大限 85-94
- 子女 癸未 | 紫微(庙) 破军(旺) ｜ 长生 养 ｜ 大限 95-104
- 夫妻 甲申 | （空宫） ｜ 长生 长生 ｜ 大限 105-114
- 兄弟 乙酉 | 天府(旺) ｜ 长生 沐浴 ｜ 大限 115-124
- 命宫 丙戌 | 太阴(旺)科 ｜ 长生 冠带 ｜ 大限 5-14
- 父母 丁亥 | 廉贞(陷) 贪狼(陷) ｜ 长生 临官 ｜ 大限 15-24
- 福德 戊子 身宫 | 巨门(旺) ｜ 长生 帝旺 ｜ 大限 25-34
- 田宅 己丑 | 天相(庙) ｜ 长生 衰 ｜ 大限 35-44 · 当前
:::
`

const GUA_DEEP = `
::: pan gua 水火既济 → 水雷屯
起卦：数字起卦（梅花） ｜ 2026-01-01 ｜ 数字 6、3
本卦：水火既济 ｜ 坎宫水 ｜ 世3应6
互卦：火水未济（上离下坎） ｜ 变卦：水雷屯（上坎下震）
动爻：九三（第 3 爻）
- 上六（应） | 玄武 兄弟 戊子 水 ｜ 月日 旺
- 九五 | 白虎 官鬼 戊戌 土 ｜ 月日 囚
- 六四 | 腾蛇 父母 戊申 金 空亡 ｜ 月日 休
- 九三（世） 动 | 勾陈 兄弟 己亥 水 → 庚辰 土 官鬼 · 回头克 ｜ 伏神 妻财 戊午 火 ｜ 月日 旺
- 六二 | 朱雀 官鬼 己丑 土 ｜ 月日 囚
- 初九 | 青龙 子孙 己卯 木 ｜ 月日 相
:::
`

// ---------------------------------------------------------------------------
// 八字板
// ---------------------------------------------------------------------------

describe('M63-A BaziBoard：神煞 / 柱间 / 小运 / 流月', () => {
  it('① 神煞 chips 渲染并点击请教（草稿含神煞名）', async () => {
    const container = await renderBoard(panProps(BAZI_DEEP))
    const chips = container.querySelectorAll('.pn-ss-chip')
    expect(chips).toHaveLength(4)
    // 禄神命中在年柱（.pn-pillar-col 第一列）
    expect(container.querySelectorAll('.pn-pillar-col')[0]!.querySelector('.pn-ss-chip')!.textContent).toBe('禄神')
    fireEvent.click(Array.from(chips).find((c) => c.textContent === '华盖')!)
    expect(draft()).toContain('神煞「华盖」')
    expect(draft()).toContain('日柱')
  })

  it('② 柱间 chips 渲染；点击高亮两柱 + AskBar 出现请教项', async () => {
    const container = await renderBoard(panProps(BAZI_DEEP))
    const rels = container.querySelectorAll('.pn-rel-chip')
    expect(rels).toHaveLength(4)
    expect(rels[0]!.textContent).toContain('午丑害')
    expect(rels[0]!.textContent).toContain('年日')
    // 点击「午未合（年时）」→ 年 + 时两柱 is-rel
    fireEvent.click(Array.from(rels).find((c) => c.textContent?.includes('午未合'))!)
    const litPillars = container.querySelectorAll('.pn-pillar.is-rel')
    expect(litPillars).toHaveLength(2)
    // AskBar 出现「请教关系」
    const ask = btnByText(container, '请教关系 午未合')
    fireEvent.click(ask)
    expect(draft()).toContain('请解读年柱与时柱之间的「午未合」')
    // 再点取消
    fireEvent.click(Array.from(container.querySelectorAll('.pn-rel-chip')).find((c) => c.textContent?.includes('午未合'))!)
    expect(container.querySelectorAll('.pn-pillar.is-rel')).toHaveLength(0)
  })

  it('③ 小运条渲染（当前岁数高亮 = 流年当前 37 岁 → 无匹配则不亮）', async () => {
    const container = await renderBoard(panProps(BAZI_DEEP))
    const xy = container.querySelectorAll('.pn-xy-chip')
    expect(xy).toHaveLength(3)
    expect(xy[0]!.textContent).toContain('丙子')
    expect(xy[0]!.textContent).toContain('29')
  })

  it('④ 流月：选中 2026 → 展开 3 条（fixture 精简）；选中 2027 → 补算草稿', async () => {
    const container = await renderBoard(panProps(BAZI_DEEP))
    fireEvent.click(btnByText(container, '2026 丙午'))
    expect(container.querySelectorAll('.pn-lychip')).toHaveLength(3)
    const ly = container.querySelector('.pn-ly')!
    expect(ly.textContent).toContain('流月（2026 丙午 · 3 条）')
    // 切到 2027 → 该年流月未随盘计算
    fireEvent.click(btnByText(container, '2027 丁未'))
    expect(container.querySelector('.pn-lychip')).toBeNull()
    expect(container.querySelector('.pn-ly-empty')?.textContent).toContain('该年流月未随盘计算')
    fireEvent.click(btnByText(container, '请研习师补算该年流月'))
    expect(draft()).toContain('请补算 2027 丁未年的十二流月')
  })

  it('⑤ 旧卡（无新字段）→ 新 UI 零渲染（神煞 / 柱间 / 小运 / 流月区块全无）', async () => {
    const container = await renderBoard(panProps(BAZI_OLD))
    expect(container.querySelectorAll('.pn-ss-chip')).toHaveLength(0)
    expect(container.querySelector('.pn-rel-row')).toBeNull()
    expect(container.querySelector('.pn-xiaoyun')).toBeNull()
    // 选中流年（旧卡无流月）→ 出现补算入口（沿用 M63-A 行为；旧卡无 liuYueOf → 也走「未随盘计算」）
    fireEvent.click(btnByText(container, '2026 丙午'))
    expect(container.querySelector('.pn-ly-empty')?.textContent).toContain('该年流月未随盘计算')
  })
})

// ---------------------------------------------------------------------------
// 紫微板
// ---------------------------------------------------------------------------

describe('M63-A ZiweiBoard：流年层', () => {
  it('① 流年开关：开启 → 12 宫角标 + 流年命宫环标 + 流四化徽标；关闭 → 全隐藏', async () => {
    const container = await renderBoard(panProps(ZIWEI_SUI))
    expect(container.querySelectorAll('.pn-palace-sui')).toHaveLength(0)
    fireEvent.click(btnByText(container, '流年 2026 丙午'))
    // 12 宫角标（流年宫名逆布）
    expect(container.querySelectorAll('.pn-palace-sui')).toHaveLength(12)
    // 流年命宫环标 1 处（财帛 午）
    const suiSoul = container.querySelectorAll('.pn-palace.is-sui')
    expect(suiSoul).toHaveLength(1)
    expect(suiSoul[0]!.getAttribute('data-branch')).toBe('午')
    // 流四化徽标：fixture 宫内星含 天同（官禄）/天机（财帛）/廉贞（父母）→ 3 枚
    const mus = container.querySelectorAll('.pn-sui-mu')
    expect(mus).toHaveLength(3)
    expect(Array.from(mus).map((m) => m.textContent).sort()).toEqual(['流忌', '流权', '流禄'])
    // 中宫行显示流年命宫
    expect(container.querySelector('.pn-center-sui-line')?.textContent).toContain('流年命宫 财帛')
    // 关闭
    fireEvent.click(btnByText(container, '流年 2026 丙午'))
    expect(container.querySelectorAll('.pn-palace-sui')).toHaveLength(0)
    expect(container.querySelectorAll('.pn-sui-mu')).toHaveLength(0)
  })

  it('② 未开启时显示补算次年草稿按钮', async () => {
    const container = await renderBoard(panProps(ZIWEI_SUI))
    fireEvent.click(btnByText(container, '补算 2027 流年'))
    expect(draft()).toContain('请补算 2027 年的流年四化与流年命宫')
  })
})

// ---------------------------------------------------------------------------
// 卦板
// ---------------------------------------------------------------------------

describe('M63-A GuaBoard：伏神 / 月日 / 回头', () => {
  it('① 爻行月日 chips 渲染；细节面板伏神与回头标注；请教此爻草稿', async () => {
    const container = await renderBoard(panProps(GUA_DEEP))
    expect(container.querySelectorAll('.pn-yao-rel')).toHaveLength(6)
    // 默认选中动爻（九三）→ 详情含伏神与回头克
    const detail = container.querySelector('.pn-yao-detail')!
    expect(detail.textContent).toContain('伏神 妻财 戊午 火')
    expect(detail.textContent).toContain('回头克')
    expect(detail.textContent).toContain('月日 旺')
    // 点击初九 → 详情切换（无伏神）
    fireEvent.click(container.querySelector('.pn-yao[data-pos="1"]')!)
    expect(container.querySelector('.pn-yao-detail')!.textContent).toContain('月日 相')
    expect(container.querySelector('.pn-yao-detail')!.textContent).not.toContain('伏神')
    // 请教此爻
    fireEvent.click(btnByText(container, '请教此爻'))
    expect(draft()).toContain('请解读初九爻')
    expect(draft()).toContain('月日关系（相）')
  })

  it('② 变爻段回头标注显示（选中动爻时可见）', async () => {
    const container = await renderBoard(panProps(GUA_DEEP))
    const yao3 = container.querySelector('.pn-yao[data-pos="3"]')!
    expect(yao3.querySelector('.pn-yao-bian')?.textContent).toContain('回头克')
  })
})
