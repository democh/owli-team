/**
 * M66-B：罗盘盘面（::: pan luopan）派生 + 渲染 + 交互测试。
 * - deriveLuopan：字段 / 条目 → 模型（坐向 / 宅卦 / 八宫 / 运盘 / 飞布 / 等级）；缺坐向 → null（回退表格）；
 * - LuopanBoard：默认八宅盘（九宫格游年星）+ 宫位点击详情（参考语）+ 请教回填；
 * - 双盘与叠图 tab：流年飞星星号显示 / 无图空态引导；
 * - 端到端（Markdown 路由）：::: pan luopan → .md-pan-luopan 壳 + 板懒加载异步渲染。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Markdown } from '../src/components/chat/Markdown'
import { clearMarkdownCaches } from '../src/lib/md-cache'
import { LuopanBoard } from '../src/components/chat/md-ext/pan/LuopanBoard'
import { deriveLuopan, splitDegrees } from '../src/components/chat/md-ext/pan/luopan-model'
import { useSessionStore } from '../src/stores/session-store'
import type { PanRowData } from '../src/components/chat/md-ext/pan/model'

const FIELDS: PanRowData[] = [
  { label: '坐向', value: '坐 壬山 向 丙山 ｜ 周天 345.0° → 165.0°' },
  { label: '宅卦', value: '坎宅（东四宅）｜ 八宅·坐山派' },
  { label: '吉方', value: '伏位 坎（北） ｜ 天医 震（东） ｜ 生气 巽（东南） ｜ 延年 离（南）' },
  { label: '慎用', value: '祸害 兑（西） ｜ 六煞 乾（西北） ｜ 五鬼 艮（东北） ｜ 绝命 坤（西南）' },
  { label: '运盘', value: '九运（2024–2043）中宫 九' },
  { label: '流年', value: '2026 一白入中 ｜ 飞布：中1 乾2 兑3 艮4 离5 坎6 坤7 震8 巽9' },
  { label: '数据等级', value: 'B' },
]
const ITEMS: PanRowData[] = [
  { label: '口径声明', value: '八宅·坐山派；玄空·下卦（兼向替卦不做）' },
  { label: '精度声明', value: '手机指南针（±5°–10°），方向性参考' },
]

const CARD = [
  '::: pan luopan 自宅 · 三室两厅',
  '坐向：坐 壬山 向 丙山 ｜ 周天 345.0° → 165.0°',
  '宅卦：坎宅（东四宅）｜ 八宅·坐山派',
  '吉方：伏位 坎（北） ｜ 天医 震（东） ｜ 生气 巽（东南） ｜ 延年 离（南）',
  '慎用：祸害 兑（西） ｜ 六煞 乾（西北） ｜ 五鬼 艮（东北） ｜ 绝命 坤（西南）',
  '运盘：九运（2024–2043）中宫 九',
  '流年：2026 一白入中 ｜ 飞布：中1 乾2 兑3 艮4 离5 坎6 坤7 震8 巽9',
  '数据等级：B',
  '- 口径声明 | 八宅·坐山派；玄空·下卦（兼向替卦不做）',
  '- 精度声明 | 手机指南针（±5°–10°），方向性参考',
  ':::',
].join('\n')

beforeEach(() => {
  clearMarkdownCaches()
})

describe('M66-B：罗盘盘面', () => {
  it('deriveLuopan：字段解析（坐向 / 宅卦 / 八宫 / 运盘 / 飞布 / 等级）；缺坐向 → null', () => {
    const m = deriveLuopan(FIELDS, ITEMS)
    expect(m).not.toBeNull()
    expect(m!.kind).toBe('luopan')
    expect(m!.sitting).toBe('壬山')
    expect(m!.facing).toBe('丙山')
    expect(m!.house).toBe('坎宅')
    expect(m!.group).toBe('东四宅')
    expect(m!.lucky).toHaveLength(4)
    expect(m!.lucky[0]).toEqual({ star: '伏位', gua: '坎', dir: '北' })
    expect(m!.cautious).toHaveLength(4)
    expect(m!.year).toBe('2026')
    expect(m!.yearStar).toBe('一白')
    expect(m!.fly).toHaveLength(9)
    expect(m!.fly[0]).toEqual({ palace: '中', star: 1 })
    expect(m!.quality).toBe('B')
    expect(m!.notes).toHaveLength(2)

    expect(deriveLuopan([{ label: '宅卦', value: '坎宅（东四宅）' }], [])).toBeNull()
    expect(splitDegrees('345.0° → 165.0°')).toEqual([345, 165])
    expect(splitDegrees('')).toBeUndefined()
  })

  it('LuopanBoard：默认八宅盘（九宫格游年星）+ 宫位点击详情（参考语）+ 请教回填 + 点宫足迹上报', () => {
    const m = deriveLuopan(FIELDS, ITEMS)!
    const ask = vi.fn()
    const onPalace = vi.fn()
    const { container } = render(<LuopanBoard model={m} onAsk={ask} onPalace={onPalace} />)
    expect(screen.getByText('壬山 向 丙山')).toBeTruthy()
    expect(screen.getByText(/坎宅（东四宅）/)).toBeTruthy()

    const kan = container.querySelector('[data-lp-cell="坎"]')!
    expect(kan.textContent).toContain('伏位')

    fireEvent.click(container.querySelector('[data-lp-cell="坤"]')!)
    expect(onPalace).toHaveBeenCalledWith('坤')
    const detail = container.querySelector('[data-lp-detail]')!
    expect(detail.textContent).toContain('绝命')
    expect(detail.textContent).toContain('传统观点列为慎用方位')

    fireEvent.click(screen.getByText(/深入「坤宫/))
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0] as string).toContain('@司南')
  })

  it('LuopanBoard：流年飞星 tab（星号）+ 叠图 tab（无图空态）', () => {
    const m = deriveLuopan(FIELDS, ITEMS)!
    const { container } = render(<LuopanBoard model={m} onAsk={() => {}} />)
    fireEvent.click(container.querySelector('[data-lp-tab="feixing"]')!)
    expect(container.querySelector('[data-lp-cell="中"]')!.textContent).toContain('一白')
    fireEvent.click(container.querySelector('[data-lp-tab="overlay"]')!)
    expect(container.querySelector('[data-lp-overlay]')).toBeTruthy()
    expect(container.textContent).toContain('上传户型图后可用')
  })

  it('GridOverlay（叠图旋转对齐）：有附件渲染底图 + 网格；滑条旋转与复位', () => {
    useSessionStore.setState({
      currentId: 's-lp-ov',
      byId: new Map([
        ['m-ov', { id: 'm-ov', attachments: [{ kind: 'image', path: 'media/plan.png', name: '户型图.png' }] }],
      ]) as never,
      order: ['m-ov'],
    } as never)
    const m = deriveLuopan(FIELDS, ITEMS)!
    const { container } = render(<LuopanBoard model={m} onAsk={() => {}} />)
    fireEvent.click(container.querySelector('[data-lp-tab="overlay"]')!)
    expect(container.querySelector('[data-lp-overlay] img')).toBeTruthy()
    const g = (): Element => container.querySelector('[data-lp-ov-rotg]')!
    expect(g().getAttribute('transform')).toBeNull()
    fireEvent.change(container.querySelector('[data-lp-ov-rot]')!, { target: { value: '90' } })
    expect(g().getAttribute('transform')).toBe('rotate(90 50 50)')
    expect(container.querySelector('.pn-lp-ov-rot-val')!.textContent).toBe('90°')
    fireEvent.click(container.querySelector('[data-lp-ov-reset]')!)
    expect(g().getAttribute('transform')).toBeNull()
    // 清理（避免影响后续用例）
    useSessionStore.setState({ currentId: null } as never)
  })

  it('GridOverlay（v3 自动找正）：指北模式点击 → 角度计算 + 滑条联动 + 提示', () => {
    useSessionStore.setState({
      currentId: 's-lp-ov2',
      byId: new Map([
        ['m-ov2', { id: 'm-ov2', attachments: [{ kind: 'image', path: 'media/plan2.png', name: '户型图2.png' }] }],
      ]) as never,
      order: ['m-ov2'],
    } as never)
    const m = deriveLuopan(FIELDS, ITEMS)!
    const { container } = render(<LuopanBoard model={m} onAsk={() => {}} />)
    fireEvent.click(container.querySelector('[data-lp-tab="overlay"]')!)
    const stage = container.querySelector('[data-lp-ov-stage]') as HTMLDivElement
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    // 进入指北模式（提示出现）
    fireEvent.click(container.querySelector('[data-lp-ov-point]')!)
    expect(container.querySelector('.pn-lp-ov-hint')).toBeTruthy()
    // 点击右中点（东 → 90°）
    fireEvent.click(stage, { clientX: 200, clientY: 100 })
    expect(container.querySelector('[data-lp-ov-rotg]')!.getAttribute('transform')).toBe('rotate(90 50 50)')
    expect((container.querySelector('[data-lp-ov-rot]') as HTMLInputElement).value).toBe('90')
    expect(container.querySelector('.pn-lp-ov-hint')).toBeNull()
    // 再指北：点击上方中点（北 → 0°）
    fireEvent.click(container.querySelector('[data-lp-ov-point]')!)
    fireEvent.click(stage, { clientX: 100, clientY: 0 })
    expect(container.querySelector('[data-lp-ov-rotg]')!.getAttribute('transform')).toBeNull()
    expect((container.querySelector('[data-lp-ov-rot]') as HTMLInputElement).value).toBe('0')
    useSessionStore.setState({ currentId: null } as never)
  })

  it('GridOverlay（v3 快照识别）：design/snapshot-* 提示「已按北向上」', () => {
    useSessionStore.setState({
      currentId: 's-lp-ov3',
      byId: new Map([
        ['m-ov3', { id: 'm-ov3', attachments: [{ kind: 'image', path: 'design/snapshot-demo.png', name: '快照.png' }] }],
      ]) as never,
      order: ['m-ov3'],
    } as never)
    const m = deriveLuopan(FIELDS, ITEMS)!
    const { container } = render(<LuopanBoard model={m} onAsk={() => {}} />)
    fireEvent.click(container.querySelector('[data-lp-tab="overlay"]')!)
    expect(container.querySelector('[data-lp-ov-note]')!.textContent).toContain('工作台快照（已按北向上）')
    useSessionStore.setState({ currentId: null } as never)
  })

  it('端到端：::: pan luopan 经 Markdown 路由 → 盘卡容器（lazy 板异步渲染）', async () => {
    const { container } = render(<Markdown content={CARD} />)
    expect(container.querySelector('.md-pan.md-pan-luopan')).not.toBeNull()
    expect(await screen.findByText('壬山 向 丙山')).toBeTruthy()
  })
})
