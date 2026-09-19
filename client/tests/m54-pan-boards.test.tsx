/**
 * M54-A t6 / M54-B：盘面组件测试（设计 §7.8 组件层）——PanCard 视图切换 + 四盘板。
 *
 * 覆盖：默认盘面渲染（懒加载落定）、柱详情开关、大运 scrub（点击 / 键盘 / 回当前 / 流年空态 + 补算）、
 * 请教版 → composerInsert 草稿（柱 / 大运 / 流年 / 宫 / 星 / 相位）、紫微 data-branch 定位与三方四正 class 断言、
 * 四化定位、大限巡游、视图切换记忆（ma:pn:view:*）、坏 JSON / 旧形状 / 流式 → 表格回退（零回归）、
 * 卦盘（爻列 / 变卦剧场 / 错综预览 / 重放时序 / 无动爻禁用）、星盘（轮盘 / 弦高亮 / 筛选 / 矩阵互跳）。
 * 摇卦台（TsToss）属 M54-C，不在本批次。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { PanCard } from '../src/components/chat/md-ext/PanCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { StreamingContext } from '../src/components/chat/md-ext/streaming'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  useUiStore.setState({ composerInsert: undefined })
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// fixture 助手：附录 A 实测原文 → PanCard props（与 remark 结构化同构拆 fields / items）
// ---------------------------------------------------------------------------

interface PanProps {
  kind: string
  title: string
  fields: string
  items: string
}

function panProps(text: string, override: Partial<PanProps> = {}): PanProps {
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
  return {
    kind: head[1]!,
    title: (head[2] ?? '').trim(),
    fields: JSON.stringify(fields),
    items: JSON.stringify(items),
    ...override,
  }
}

/** 渲染并等待盘面（嵌套懒加载）落定 */
async function renderBoard(fx: PanProps, info?: { messageId: string; sessionId: string }): Promise<HTMLElement> {
  const { container } = render(
    <MessageContext.Provider value={info ?? null}>
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
// 附录 A 实测样本原文（A.1 八字 / A.2 紫微；与 m54-pan-derive.test.ts 同源）
// ---------------------------------------------------------------------------

const A1_BAZI = `
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
命造：乾造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八
四柱：庚午 辛巳 丁丑 丁未
十神：正财 偏财 日主 比肩
藏干：午(丁己) 巳(丙庚戊) 丑(己癸辛) 未(己丁乙)
纳音：路旁土 ｜ 白蜡金 ｜ 涧下水 ｜ 天河水
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
空亡：年戌亥 月申酉 日申酉 时寅卯
地势：年临官 月帝旺 日墓 时冠带
胎元：壬申（剑锋金） ｜ 胎息：壬子（桑柘木）
命宫：辛巳（白蜡金） ｜ 身宫：己丑（霹雳火）
起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行
- 大运 壬午 | 9-18 岁 ｜ 1998-2007
- 大运 癸未 | 19-28 岁 ｜ 2008-2017
- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运
- 大运 乙酉 | 39-48 岁 ｜ 2028-2037
- 大运 丙戌 | 49-58 岁 ｜ 2038-2047
- 大运 丁亥 | 59-68 岁 ｜ 2048-2057
- 大运 戊子 | 69-78 岁 ｜ 2058-2067
- 大运 己丑 | 79-88 岁 ｜ 2068-2077
- 流年 2018 戊戌 | 29 岁
- 流年 2019 己亥 | 30 岁
- 流年 2020 庚子 | 31 岁
- 流年 2021 辛丑 | 32 岁
- 流年 2022 壬寅 | 33 岁
- 流年 2023 癸卯 | 34 岁
- 流年 2024 甲辰 | 35 岁
- 流年 2025 乙巳 | 36 岁
- 流年 2026 丙午 | 37 岁 · 当前
- 流年 2027 丁未 | 38 岁
:::
`

const A2_ZIWEI = `
::: pan ziwei 紫微 土五局 ｜ 命宫 丙戌
命造：乾造 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八 ｜ 未时（13:00~15:00）
四柱：庚午 辛巳 丁丑 丁未 ｜ 生肖 马 ｜ 星座 金牛座
五行局：土五局 ｜ 命主 禄存 ｜ 身主 火星
命身宫：命宫 丙戌 ｜ 身宫 福德 戊子
来因宫：迁移 庚辰
生年四化：禄 太阳 ｜ 权 武曲 ｜ 科 太阴 ｜ 忌 天同
- 官禄 戊寅 | 天同(利)忌 天梁(庙) ｜ 杂 八座 天厨 天月 蜚廉 ｜ 长生 病 ｜ 大限 45-54
- 仆役 己卯 | 武曲(利)权 七杀(旺) ｜ 文昌(利) ｜ 杂 天喜 咸池 天贵 天德 天伤 ｜ 长生 死 ｜ 大限 55-64
- 迁移 庚辰 | 太阳(旺)禄 ｜ 地空 ｜ 杂 天姚 凤阁 天才 寡宿 年解 ｜ 长生 墓 ｜ 大限 65-74
- 疾厄 辛巳 | （空宫） ｜ 杂 破碎 天使 ｜ 长生 绝 ｜ 大限 75-84
- 财帛 壬午 | 天机(庙) ｜ 地劫 ｜ 杂 天寿 天福 截路 ｜ 长生 胎 ｜ 大限 85-94
- 子女 癸未 | 紫微(庙) 破军(旺) ｜ 左辅 右弼 天钺 陀罗(庙) ｜ 杂 恩光 天空 空亡 ｜ 长生 养 ｜ 大限 95-104
- 夫妻 甲申 | （空宫） ｜ 禄存 天马 火星(陷) ｜ 杂 孤辰 阴煞 ｜ 长生 长生 ｜ 大限 105-114
- 兄弟 乙酉 | 天府(旺) ｜ 擎羊(陷) ｜ 杂 红鸾 封诰 ｜ 长生 沐浴 ｜ 大限 115-124
- 命宫 丙戌 | 太阴(旺)科 ｜ 铃星(庙) ｜ 杂 解神 龙池 华盖 旬空 ｜ 长生 冠带 ｜ 大限 5-14
- 父母 丁亥 | 廉贞(陷) 贪狼(陷) ｜ 文曲(旺) ｜ 杂 天巫 天官 月德 ｜ 长生 临官 ｜ 大限 15-24
- 福德 戊子 身宫 | 巨门(旺) ｜ 杂 三台 天刑 天哭 天虚 ｜ 长生 帝旺 ｜ 大限 25-34
- 田宅 己丑 | 天相(庙) ｜ 天魁 ｜ 杂 台辅 ｜ 长生 衰 ｜ 大限 35-44 · 当前
:::
`

/** 旧形状（M51 时代简化卡）：严格派生 → null → 表格（零回归断言与 m51-md-pan.test.tsx 同源） */
const OLD_BAZI = `
::: pan bazi
四柱：庚子 戊寅 壬午 辛亥（男）
十神：偏印 七杀 日主 正印
五行：火1 土2 金2 水2 木1
大运：辛巳 壬午 癸未 甲申
:::
`

/** 附录 A.3：本命盘（10 行星 / 5 逆行 / 12 宫头 / 16 相位；与 m54-pan-derive.test.ts 同源） */
const A3_NATAL = `
::: pan natal 本命盘 1990-05-12 14:30
出生：公历 1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E ｜ UTC 1990-05-12 05:30
宫制：Placidus ｜ 四轴：ASC 处女 16.0° ｜ MC 双子 15.0° ｜ DSC 双鱼 16.0° ｜ IC 射手 15.0°
元素：火2 土5 风0 水3 ｜ 模式：基本5 固定3 变动2
- 太阳 | 金牛 21.2°（51.24°）｜ 9 宫
- 月亮 | 射手 17.6°（257.62°）｜ 4 宫
- 水星 | 金牛 8.8°（38.79°）｜ 8 宫 ｜ 逆行
- 金星 | 白羊 9.1°（9.10°）｜ 7 宫
- 火星 | 双鱼 15.9°（345.90°）｜ 6 宫
- 木星 | 巨蟹 8.9°（98.93°）｜ 10 宫
- 土星 | 摩羯 25.3°（295.30°）｜ 5 宫 ｜ 逆行
- 天王星 | 摩羯 9.3°（279.26°）｜ 4 宫 ｜ 逆行
- 海王星 | 摩羯 14.4°（284.40°）｜ 4 宫 ｜ 逆行
- 冥王星 | 天蝎 16.3°（226.26°）｜ 3 宫 ｜ 逆行
- 宫头 1 | 处女 16.0°
- 宫头 2 | 天秤 12.7°
- 宫头 3 | 天蝎 12.9°
- 宫头 4 | 射手 15.0°
- 宫头 5 | 摩羯 17.1°
- 宫头 6 | 水瓶 17.7°
- 宫头 7 | 双鱼 16.0°
- 宫头 8 | 白羊 12.7°
- 宫头 9 | 金牛 12.9°
- 宫头 10 | 双子 15.0°
- 宫头 11 | 巨蟹 17.1°
- 宫头 12 | 狮子 17.7°
- 太阳-土星 | 拱相 4.1°
- 太阳-冥王星 | 对分 5.0°
- 月亮-火星 | 刑相 1.7°
- 水星-木星 | 六合 0.1°
- 水星-天王星 | 拱相 0.5°
- 水星-海王星 | 拱相 5.6°
- 水星-冥王星 | 对分 7.5°
- 金星-木星 | 刑相 0.2°
- 金星-天王星 | 刑相 0.2°
- 金星-海王星 | 刑相 5.3°
- 火星-海王星 | 六合 1.5°
- 火星-冥王星 | 拱相 0.4°
- 木星-天王星 | 对分 0.3°
- 木星-海王星 | 对分 5.5°
- 天王星-海王星 | 合相 5.1°
- 海王星-冥王星 | 六合 1.9°
:::
`

/** 附录 A.4：数字起卦（单动爻六三，世4应1；空亡九五） */
const A4_GUA_NUMBER = `
::: pan gua 天雷无妄 → 天火同人
起卦：数字起卦（梅花） ｜ 2026-01-01 ｜ 数字 17、28
所问：测试占问
卦气：乙巳年 戊子月 乙亥日 丙子时 ｜ 日旬空 申酉 ｜ 二〇二五年冬月十三
本卦：天雷无妄 ｜ 巽宫木 ｜ 世4应1
卦体：上卦 乾（天·金） ｜ 下卦 震（雷·木）
互卦：风山渐（上巽下艮） ｜ 变卦：天火同人（上乾下离）
错卦：地风升（六爻全变） ｜ 综卦：山天大畜（六爻颠倒）
动爻：六三（第 3 爻）
体用：体乾（金） ｜ 用震（木） ｜ 体克用 · 我制于彼，事可成但需主动
- 上九 | 玄武 妻财 壬戌 土
- 九五 | 白虎 官鬼 壬申 金 空亡
- 九四（世） | 腾蛇 子孙 壬午 火
- 六三 动 | 勾陈 妻财 庚辰 土 → 己亥 水 父母
- 六二 | 朱雀 兄弟 庚寅 木
- 初九（应） | 青龙 父母 庚子 水
:::
`

/** 附录 A.5：摇卦（双动爻九五/上六；六爻数专有） */
const A5_GUA_COIN = `
::: pan gua 水雷屯 → 山雷颐
起卦：摇卦（三枚铜钱） ｜ 2026-01-01 ｜ 种子 12345
卦气：乙巳年 戊子月 乙亥日 丙子时 ｜ 日旬空 申酉 ｜ 二〇二五年冬月十三
本卦：水雷屯 ｜ 坎宫水 ｜ 世2应5
卦体：上卦 坎（水·水） ｜ 下卦 震（雷·木）
互卦：山地剥（上艮下坤） ｜ 变卦：山雷颐（上艮下震）
错卦：火风鼎（六爻全变） ｜ 综卦：山水蒙（六爻颠倒）
动爻：九五（第 5 爻）、上六（第 6 爻）
六爻数：初7 二8 三8 四8 五9 上6
- 上六 动 | 玄武 兄弟 戊子 水 → 丙寅 木 子孙
- 九五（应） 动 | 白虎 官鬼 戊戌 土 → 丙子 水 兄弟
- 六四 | 腾蛇 父母 戊申 金 空亡
- 六三 | 勾陈 官鬼 庚辰 土
- 六二（世） | 朱雀 子孙 庚寅 木
- 初九 | 青龙 兄弟 庚子 水
:::
`

/** 无动爻变体（A.4 去「六三 动」后缀与动爻字段）→ 剧场禁用路径 */
const A4_NODONG = A4_GUA_NUMBER.replace('- 六三 动 | 勾陈 妻财 庚辰 土 → 己亥 水 父母', '- 六三 | 勾陈 妻财 庚辰 土').replace('动爻：六三（第 3 爻）\n', '')

// ---------------------------------------------------------------------------
// PanCard：视图切换与回退（§7.2）
// ---------------------------------------------------------------------------

describe('PanCard 视图切换与回退', () => {
  it('可派生卡：默认盘面 + 切换钮（盘面 / 表格 aria-pressed）', async () => {
    const container = await renderBoard(panProps(A1_BAZI))
    expect(container.querySelector('.md-pan.md-pan-board')).not.toBeNull()
    const btns = Array.from(container.querySelectorAll('.md-pan-viewbtn'))
    expect(btns.map((b) => b.textContent)).toEqual(['盘面', '表格'])
    expect(btns[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(btns[1]!.getAttribute('aria-pressed')).toBe('false')
  })

  it('切「表格」→ M51 静态表完整可见；切回「盘面」→ 盘面回来（信息不丢）', async () => {
    const container = await renderBoard(panProps(A1_BAZI))
    fireEvent.click(btnByText(container, '表格'))
    expect(container.querySelector('.pn-board')).toBeNull()
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(11)
    expect(container.querySelectorAll('.md-pan-item')).toHaveLength(18)
    fireEvent.click(btnByText(container, '盘面'))
    await waitFor(() => expect(container.querySelector('.pn-board')).not.toBeNull())
  })

  it('切换记忆 ma:pn:view:<sid>:<mid>（sessionStorage；重挂载读回）', async () => {
    const fx = panProps(A1_BAZI)
    const info = { messageId: 'm1', sessionId: 's1' }
    const first = render(
      <MessageContext.Provider value={info}>
        <PanCard {...fx} />
      </MessageContext.Provider>,
    )
    await waitFor(() => expect(first.container.querySelector('.pn-board')).not.toBeNull())
    fireEvent.click(btnByText(first.container, '表格'))
    expect(sessionStorage.getItem('ma:pn:view:s1:m1')).toBe('"table"')
    first.unmount()
    const second = render(
      <MessageContext.Provider value={info}>
        <PanCard {...fx} />
      </MessageContext.Provider>,
    )
    expect(second.container.querySelector('.pn-board')).toBeNull()
    expect(second.container.querySelectorAll('.md-pan-row')).toHaveLength(11)
  })

  it('坏 JSON：items 非法 → 表格兜底（不崩、无切换钮）', () => {
    const fx = panProps(A1_BAZI, { items: '{oops' })
    const { container } = render(<PanCard {...fx} />)
    expect(container.querySelector('.pn-board')).toBeNull()
    expect(container.querySelector('.md-pan-viewtoggle')).toBeNull()
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(11)
  })

  it('旧形状卡（不可派生）→ 表格表格行数与既有断言一致（零回归）', () => {
    const { container } = render(<PanCard {...panProps(OLD_BAZI)} />)
    expect(container.querySelector('.pn-board')).toBeNull()
    expect(container.querySelector('.md-pan-viewtoggle')).toBeNull()
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(4)
  })

  it('流式期间：强制表格（不出切换钮、不挂盘面）', () => {
    const { container } = render(
      <StreamingContext.Provider value={true}>
        <PanCard {...panProps(A1_BAZI)} />
      </StreamingContext.Provider>,
    )
    expect(container.querySelector('.pn-board')).toBeNull()
    expect(container.querySelector('.md-pan-viewtoggle')).toBeNull()
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(11)
  })
})

// ---------------------------------------------------------------------------
// BaziBoard（§4.2）
// ---------------------------------------------------------------------------

describe('BaziBoard 八字板', () => {
  it('四柱 / 五行能量 / 大运轨道 / 流年条渲染（当前大运甲申、当前流年 2026）', async () => {
    const container = await renderBoard(panProps(A1_BAZI))
    const pillars = container.querySelectorAll('.pn-pillar')
    expect(pillars).toHaveLength(4)
    expect(pillars[0]!.textContent).toContain('庚午')
    expect(pillars[0]!.textContent).toContain('年柱')
    expect(container.querySelectorAll('.pn-wx-row')).toHaveLength(5)
    const segs = container.querySelectorAll('.pn-dyseg')
    expect(segs).toHaveLength(8)
    const cur = container.querySelector('.pn-dyseg.is-current')!
    expect(cur.textContent).toContain('甲申')
    expect(cur.textContent).toContain('29-38')
    const chips = container.querySelectorAll('.pn-lnchip')
    expect(chips).toHaveLength(10)
    expect(container.querySelector('.pn-lnchip.is-current')?.textContent).toContain('2026 丙午')
  })

  it('点柱 → 详情（十神 / 藏干 / 纳音 / 空亡 / 地势）；再点取消', async () => {
    const container = await renderBoard(panProps(A1_BAZI))
    const day = container.querySelectorAll('.pn-pillar')[2]!
    fireEvent.click(day)
    const detail = container.querySelector('.pn-detail')!
    expect(detail.textContent).toContain('日柱 丁丑')
    expect(detail.textContent).toContain('十神 日主')
    expect(detail.textContent).toContain('藏干 丑(己癸辛)')
    expect(detail.textContent).toContain('纳音 涧下水')
    expect(detail.textContent).toContain('空亡 申酉')
    expect(detail.textContent).toContain('地势 墓')
    expect(day.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(day)
    expect(container.querySelector('.pn-detail')).toBeNull()
  })

  it('大运 scrub：点击 / 键盘 → 非当前大运空态 + 补算草稿；回当前还原流年', async () => {
    const container = await renderBoard(panProps(A1_BAZI))
    // 点击第 6 步（丁亥）→ 空态 + 补算按钮
    fireEvent.click(container.querySelector('.pn-dyseg[data-idx="5"]')!)
    expect(container.querySelector('.pn-dyseg.is-on')!.textContent).toContain('丁亥')
    expect(container.querySelector('.pn-ln-row')).toBeNull()
    expect(container.querySelector('.pn-ln-empty')?.textContent).toContain('该步流年未随盘计算')
    fireEvent.click(btnByText(container, '请研习师补算该步流年'))
    expect(draft()).toContain('补算丁亥大运')
    // 键盘 → 第一步（壬午）
    fireEvent.keyDown(container.querySelector('.pn-dy-rail')!, { key: 'ArrowLeft' })
    fireEvent.keyDown(container.querySelector('.pn-dy-rail')!, { key: 'ArrowLeft' })
    fireEvent.keyDown(container.querySelector('.pn-dy-rail')!, { key: 'ArrowLeft' })
    fireEvent.keyDown(container.querySelector('.pn-dy-rail')!, { key: 'ArrowLeft' })
    fireEvent.keyDown(container.querySelector('.pn-dy-rail')!, { key: 'ArrowLeft' })
    expect(container.querySelector('.pn-dyseg.is-on')!.textContent).toContain('壬午')
    // 回当前 → 流年条还原
    fireEvent.click(btnByText(container, '回当前'))
    expect(container.querySelector('.pn-dyseg.is-on')!.textContent).toContain('甲申')
    expect(container.querySelectorAll('.pn-lnchip')).toHaveLength(10)
  })

  it('请教草稿：柱 / 大运 / 流年（选中流年才出现流年条目）', async () => {
    const container = await renderBoard(panProps(A1_BAZI))
    // 柱
    fireEvent.click(container.querySelectorAll('.pn-pillar')[2]!)
    fireEvent.click(btnByText(container, '请教日柱'))
    expect(draft()).toContain('日柱 丁丑')
    // 大运（当前步）
    fireEvent.click(btnByText(container, '请教大运 甲申'))
    expect(draft()).toContain('甲申大运（29-38 岁，2018-2027）')
    // 流年：先选中 2026 → 才出现「请教流年 2026」
    expect(Array.from(container.querySelectorAll('.pn-ask-btn')).some((b) => b.textContent?.includes('请教流年'))).toBe(false)
    const chip = Array.from(container.querySelectorAll('.pn-lnchip')).find((c) => c.textContent?.includes('2026'))!
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(btnByText(container, '请教流年 2026'))
    expect(draft()).toContain('流年 2026 丙午（37 岁，甲申 大运中）')
  })
})

// ---------------------------------------------------------------------------
// ZiweiBoard（§4.3）
// ---------------------------------------------------------------------------

describe('ZiweiBoard 紫微板', () => {
  it('12 宫 data-branch 定位（命宫丙戌 / 身宫角标 / 当前大限田宅丑）', async () => {
    const container = await renderBoard(panProps(A2_ZIWEI))
    expect(container.querySelectorAll('.pn-palace')).toHaveLength(12)
    const ming = container.querySelector('.pn-palace[data-branch="戌"]')!
    expect(ming.textContent).toContain('命宫')
    expect(ming.textContent).toContain('丙戌')
    expect(ming.textContent).toContain('太阴')
    const shen = container.querySelector('.pn-palace[data-branch="子"]')!
    expect(shen.querySelector('.pn-palace-tag.is-hollow')?.textContent).toBe('身')
    const cur = container.querySelectorAll('.pn-palace.is-current')
    expect(cur).toHaveLength(1)
    expect(cur[0]!.getAttribute('data-branch')).toBe('丑')
  })

  it('点宫 → 三方四正 class 断言（戌 → 寅 / 午 / 辰：三合 ±4 + 对宫）；再点取消', async () => {
    const container = await renderBoard(panProps(A2_ZIWEI))
    const ming = container.querySelector('.pn-palace[data-branch="戌"]')!
    fireEvent.click(ming)
    expect(ming.classList.contains('is-on')).toBe(true)
    const rel = Array.from(container.querySelectorAll('.pn-palace.is-rel'))
    expect(rel.map((el) => el.getAttribute('data-branch')).sort()).toEqual(['午', '寅', '辰'].sort())
    fireEvent.click(ming)
    expect(container.querySelectorAll('.pn-palace.is-rel')).toHaveLength(0)
  })

  it('四化定位：点「科 太阴」→ 太阴所在宫（命宫戌）is-mu；再点清除', async () => {
    const container = await renderBoard(panProps(A2_ZIWEI))
    const keBtn = Array.from(container.querySelectorAll('.pn-mu-btn')).find((b) => b.textContent?.includes('太阴'))!
    fireEvent.click(keBtn)
    expect(keBtn.getAttribute('aria-pressed')).toBe('true')
    const mu = container.querySelectorAll('.pn-palace.is-mu')
    expect(mu).toHaveLength(1)
    expect(mu[0]!.getAttribute('data-branch')).toBe('戌')
    fireEvent.click(keBtn)
    expect(container.querySelectorAll('.pn-palace.is-mu')).toHaveLength(0)
  })

  it('大限巡游：初始为本限（35-44 田宅）；下一限 → 官禄寅 is-xun；回本限还原', async () => {
    const container = await renderBoard(panProps(A2_ZIWEI))
    expect(container.querySelector('.pn-center-xun')?.textContent).toContain('大限 35-44')
    fireEvent.click(btnByText(container, '下一限'))
    expect(container.querySelector('.pn-center-xun')?.textContent).toContain('官禄')
    expect(container.querySelector('.pn-palace[data-branch="寅"]')!.classList.contains('is-xun')).toBe(true)
    fireEvent.click(btnByText(container, '回本限'))
    expect(container.querySelector('.pn-center-xun')?.textContent).toContain('田宅')
    expect(container.querySelectorAll('.pn-palace.is-xun')).toHaveLength(0)
    // 点宫 + 请教草稿（宫名去尾「宫」）
    fireEvent.click(container.querySelector('.pn-palace[data-branch="戌"]')!)
    expect(container.querySelector('.pn-detail')?.textContent).toContain('命宫 丙戌')
    fireEvent.click(btnByText(container, '请教命宫'))
    expect(draft()).toContain('命宫（丙戌）')
  })

  it('方向键导航：戌 ↑ → 酉（4×4 方向键 + 焦点移动）', async () => {
    const container = await renderBoard(panProps(A2_ZIWEI))
    const ming = container.querySelector<HTMLButtonElement>('.pn-palace[data-branch="戌"]')!
    ming.focus()
    fireEvent.keyDown(ming, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(container.querySelector('.pn-palace[data-branch="酉"]'))
  })
})

// ---------------------------------------------------------------------------
// GuaBoard（§4.1）
// ---------------------------------------------------------------------------

describe('GuaBoard 卦盘', () => {
  it('六爻列：data-pos 全 6 / 默认选中动爻（六三）/ 世●应○ / 空亡', async () => {
    const container = await renderBoard(panProps(A4_GUA_NUMBER))
    expect(container.querySelectorAll('.pn-yao')).toHaveLength(6)
    const sel = container.querySelector('.pn-yao[data-pos="3"]')!
    expect(sel.classList.contains('is-on')).toBe(true)
    expect(sel.getAttribute('aria-pressed')).toBe('true')
    expect(sel.textContent).toContain('六三')
    expect(container.querySelector('.pn-yao[data-pos="5"]')!.classList.contains('is-kong')).toBe(true)
    expect(container.querySelector('.pn-yao[data-pos="4"] .pn-mark')?.textContent).toBe('●')
    expect(container.querySelector('.pn-yao[data-pos="1"] .pn-mark')?.textContent).toBe('○')
    expect(container.querySelectorAll('.pn-yao-digit')).toHaveLength(0)
  })

  it('摇卦卡：六爻数逐爻显示（初7…上6，DOM 自上而下）', async () => {
    const container = await renderBoard(panProps(A5_GUA_COIN))
    const digits = Array.from(container.querySelectorAll('.pn-yao')).map((y) => y.querySelector('.pn-yao-digit')?.textContent)
    expect(digits).toEqual(['6', '9', '8', '8', '8', '7'])
  })

  it('点击爻行 → 详情切换（六神·六亲 / 干支·五行 / 动爻「变：」）', async () => {
    const container = await renderBoard(panProps(A4_GUA_NUMBER))
    fireEvent.click(container.querySelector('.pn-yao[data-pos="1"]')!)
    const detail = container.querySelector('.pn-yao-detail')!
    expect(detail.textContent).toContain('初九 · 应爻')
    expect(detail.textContent).toContain('六神 青龙 · 六亲 父母')
    expect(detail.textContent).toContain('干支 庚子 · 五行 水')
    fireEvent.click(container.querySelector('.pn-yao[data-pos="3"]')!)
    expect(detail.textContent).toContain('六三 · 动爻')
    expect(detail.textContent).toContain('变：己亥 水 父母')
  })

  it('变卦剧场：双动爻（九五/上六）展开变爻；未开时仅选中动爻行显示', async () => {
    const container = await renderBoard(panProps(A5_GUA_COIN))
    expect(container.querySelector('.pn-yao[data-pos="5"] .pn-yao-bian')?.textContent).toContain('变 丙子 水 兄弟')
    expect(container.querySelector('.pn-yao[data-pos="6"] .pn-yao-bian')).toBeNull()
    fireEvent.click(btnByText(container, '变卦剧场'))
    expect(btnByText(container, '变卦剧场').getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.pn-yao[data-pos="6"] .pn-yao-bian')?.textContent).toContain('变 丙寅 木 子孙')
  })

  it('无动爻：剧场按钮禁用 + 「无动爻」提示；默认选中初爻', async () => {
    const container = await renderBoard(panProps(A4_NODONG))
    const btn = btnByText(container, '变卦剧场')
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toBe('无动爻')
    expect(container.querySelector('.pn-gua-nodong')?.textContent).toBe('无动爻')
    expect(container.querySelector('.pn-yao[data-pos="1"]')!.classList.contains('is-on')).toBe(true)
  })

  it('错 / 综预览：弹层小六爻图 + 名称 / 说明取自卡字段；可关闭', async () => {
    const container = await renderBoard(panProps(A4_GUA_NUMBER))
    fireEvent.click(btnByText(container, '错卦'))
    expect(container.querySelector('.pn-pop-title')?.textContent).toContain('错卦 地风升')
    expect(container.querySelectorAll('.pn-pop .pn-mini-yao')).toHaveLength(6)
    expect(container.querySelector('.pn-pop-note')?.textContent).toBe('六爻全变')
    fireEvent.click(btnByText(container, '综卦'))
    expect(container.querySelector('.pn-pop-title')?.textContent).toContain('综卦 山天大畜')
    expect(container.querySelector('.pn-pop-note')?.textContent).toBe('六爻颠倒')
    fireEvent.click(btnByText(container, '综卦'))
    expect(container.querySelector('.pn-pop')).toBeNull()
  })

  it('重放装卦：300ms/爻逐爻点亮、可中途停、终态 6 爻全亮', async () => {
    const container = await renderBoard(panProps(A5_GUA_COIN))
    vi.useFakeTimers()
    try {
      fireEvent.click(btnByText(container, '重放装卦'))
      expect(btnByText(container, '停止重放')).toBeTruthy()
      expect(container.querySelectorAll('.pn-yao.is-lit')).toHaveLength(0)
      expect(container.querySelectorAll('.pn-yao.is-unlit')).toHaveLength(6)
      act(() => vi.advanceTimersByTime(300))
      expect(container.querySelectorAll('.pn-yao.is-lit')).toHaveLength(1)
      act(() => vi.advanceTimersByTime(600))
      expect(container.querySelectorAll('.pn-yao.is-lit')).toHaveLength(3)
      // 中途停：进度冻结
      fireEvent.click(btnByText(container, '停止重放'))
      act(() => vi.advanceTimersByTime(3000))
      expect(container.querySelectorAll('.pn-yao.is-lit')).toHaveLength(3)
      expect(btnByText(container, '重放装卦')).toBeTruthy()
      // 重新重放 → 直出终态
      fireEvent.click(btnByText(container, '重放装卦'))
      act(() => vi.advanceTimersByTime(1800))
      expect(container.querySelectorAll('.pn-yao.is-lit')).toHaveLength(6)
      expect(container.querySelectorAll('.pn-yao.is-unlit')).toHaveLength(0)
      expect(btnByText(container, '重放装卦')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reduced-motion：重放直出终态（无逐爻推进）', async () => {
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      const container = await renderBoard(panProps(A5_GUA_COIN))
      fireEvent.click(btnByText(container, '重放装卦'))
      expect(container.querySelectorAll('.pn-yao.is-lit')).toHaveLength(6)
      expect(btnByText(container, '重放装卦')).toBeTruthy()
    } finally {
      window.matchMedia = original
    }
  })
})

// ---------------------------------------------------------------------------
// NatalWheel（§4.4）
// ---------------------------------------------------------------------------

describe('NatalWheel 星盘', () => {
  it('轮盘渲染：10 行星（5 逆行）/ 16 弦 / ASC·MC 轴 / 12 宫序号 / viewBox', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    expect(container.querySelectorAll('.pn-planet')).toHaveLength(10)
    expect(container.querySelectorAll('.pn-planet.is-retro')).toHaveLength(5)
    expect(container.querySelector('.pn-planet[data-name="水星"]')!.classList.contains('is-retro')).toBe(true)
    expect(container.querySelectorAll('.pn-aspect')).toHaveLength(16)
    expect(container.querySelectorAll('.pn-house-num')).toHaveLength(12)
    expect(container.querySelectorAll('.pn-zodiac-name')).toHaveLength(12)
    const labels = Array.from(container.querySelectorAll('.pn-axis-label')).map((t) => t.textContent)
    expect(labels).toContain('ASC')
    expect(labels).toContain('MC')
    expect(container.querySelector('.pn-wheel')!.getAttribute('viewBox')).toBe('0 0 320 320')
    expect(container.querySelector('.pn-natal-meta')?.textContent).toContain('火2 土5 风0 水3')
  })

  it('悬停行星：其弦 is-hot + 其余弦 is-faded + 同宫同星座 is-kin；移出复原', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    const sun = container.querySelector('.pn-planet[data-name="太阳"]')!
    fireEvent.mouseEnter(sun)
    const hot = Array.from(container.querySelectorAll('.pn-aspect.is-hot')).map((el) => el.getAttribute('data-b'))
    expect(hot.sort()).toEqual(['土星', '冥王星'].sort())
    expect(container.querySelectorAll('.pn-aspect.is-faded')).toHaveLength(14)
    const kin = container.querySelectorAll('.pn-planet.is-kin')
    expect(kin).toHaveLength(1)
    expect(kin[0]!.getAttribute('data-name')).toBe('水星')
    fireEvent.mouseLeave(sun)
    expect(container.querySelectorAll('.pn-aspect.is-hot')).toHaveLength(0)
    expect(container.querySelectorAll('.pn-aspect.is-faded')).toHaveLength(0)
  })

  it('悬停相位弦 → 中点浮标（太阳-土星 拱相 4.1°）', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    const hit = container.querySelector('.pn-aspect-hit[data-a="太阳"][data-b="土星"]')!
    fireEvent.mouseEnter(hit)
    expect(container.querySelector('.pn-aspect-tip')?.textContent).toBe('太阳-土星 拱相 4.1°')
    fireEvent.mouseLeave(hit)
    expect(container.querySelector('.pn-aspect-tip')).toBeNull()
  })

  it('悬停行星 → 浮标（名称 / 星座度数 / 落宫；逆行加段）；移出消失', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    const sun = container.querySelector('.pn-planet[data-name="太阳"]')!
    fireEvent.mouseEnter(sun)
    expect(container.querySelector('.pn-planet-tip')?.textContent).toBe('太阳 金牛21.2° · 9 宫')
    fireEvent.mouseLeave(sun)
    expect(container.querySelector('.pn-planet-tip')).toBeNull()
    fireEvent.mouseEnter(container.querySelector('.pn-planet[data-name="水星"]')!)
    expect(container.querySelector('.pn-planet-tip')?.textContent).toBe('水星 金牛8.8° · 8 宫 · 逆行')
  })

  it('点击行星 → 详情条（度数 / 落宫 / 逆行）+ 相位清单逐条可点', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    fireEvent.click(container.querySelector('.pn-planet[data-name="水星"]')!)
    const detail = container.querySelector('.pn-planet-detail')!
    expect(detail.textContent).toContain('水星 · 逆行')
    expect(detail.textContent).toContain('金牛 8.8°')
    expect(detail.textContent).toContain('第 8 宫')
    const items = container.querySelectorAll('.pn-asp-item')
    expect(items).toHaveLength(4)
    fireEvent.click(items[0]!)
    expect(items[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelectorAll('.pn-aspect.is-hot')).toHaveLength(1)
  })

  it('键盘：行星 Enter 打开详情', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    fireEvent.keyDown(container.querySelector('.pn-planet[data-name="太阳"]')!, { key: 'Enter' })
    expect(container.querySelector('.pn-planet-detail')?.textContent).toContain('太阳')
  })

  it('相位筛选：关「刑相」→ 弦 16→12；chip aria-pressed 切换', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    expect(container.querySelectorAll('.pn-aspect')).toHaveLength(16)
    const chip = container.querySelector('.pn-asp-chip[data-type="刑相"]')!
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelectorAll('.pn-aspect')).toHaveLength(12)
    fireEvent.click(chip)
    expect(container.querySelectorAll('.pn-aspect')).toHaveLength(16)
  })

  it('矩阵互跳：点格 → 切回轮盘且对应弦 is-hot；格 aria-label 完整', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    fireEvent.click(btnByText(container, '矩阵'))
    expect(container.querySelectorAll('.pn-mrow')).toHaveLength(11)
    const cell = container.querySelector('.pn-mcell-btn[data-a="太阳"][data-b="土星"]')!
    expect(cell.getAttribute('aria-label')).toBe('太阳-土星 拱相 4.1°')
    fireEvent.click(cell)
    expect(container.querySelector('.pn-mtable')).toBeNull()
    expect(container.querySelector('.pn-wheel')).not.toBeNull()
    expect(container.querySelector('.pn-aspect[data-a="太阳"][data-b="土星"]')!.classList.contains('is-hot')).toBe(true)
  })

  it('矩阵方向键：↓ 移动到同列下一相位格（金星-海王星 → 火星-海王星）', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    fireEvent.click(btnByText(container, '矩阵'))
    const from = container.querySelector<HTMLButtonElement>('.pn-mcell-btn[data-a="金星"][data-b="海王星"]')!
    // focus() 会触发 onFocus → roving tabindex 状态更新，须包在 act 内（否则 jsdom 警告）
    act(() => {
      from.focus()
    })
    fireEvent.keyDown(from, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(container.querySelector('.pn-mcell-btn[data-a="火星"][data-b="海王星"]'))
  })

  it('请教草稿：此星（模板 8）/ 此相位（模板 9）', async () => {
    const container = await renderBoard(panProps(A3_NATAL))
    fireEvent.click(container.querySelector('.pn-planet[data-name="太阳"]')!)
    fireEvent.click(btnByText(container, '请教太阳'))
    expect(draft()).toContain('请解读本命盘中太阳（金牛21.2°，9 宫）')
    fireEvent.click(container.querySelector('.pn-aspect-hit[data-a="太阳"][data-b="土星"]')!)
    fireEvent.click(btnByText(container, '请教此相位'))
    expect(draft()).toContain('请解读太阳-土星 拱相 4.1° 相位')
  })
})
