/**
 * M65-C：设计容器族测试（layout / styleboard / render）。
 * - 渲染：房间表 / 方案源 / 色块（含非法降级）/ 元信息 / 无图提示 / 空容器 children 兜底；
 * - 交互：房间行回填（insertToComposer）/「在 3D 工作台打开」（STUDIO_OPEN_EVENT）/
 *   「再生成一版」（seed 回填）/「按此板调整方案」；
 * - 纯函数：parseLayoutItems / parseSwatches / renderProductPath / ds-templates（含 seed 提取）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Markdown } from '../src/components/chat/Markdown'
import { buildLayoutText, parseLayoutItems } from '../src/components/chat/md-ext/LayoutCard'
import { renderProductPath } from '../src/components/chat/md-ext/RenderCard'
import { parseSwatches } from '../src/components/chat/md-ext/StyleBoardCard'
import { seedOfParams, tplAdjustRoom, tplApplyStyleboard, tplRegenRender, tplSnapshotToRender } from '../src/lib/ds-templates'
import { STUDIO_OPEN_EVENT } from '../src/components/studio/studio-open'
import { useUiStore } from '../src/stores/ui-store'

const LAYOUT = [
  '::: layout 三室两厅 · 方案 A',
  '- 客厅 | 22.5㎡ | 南向，沙发墙居中',
  '- 主卧 | 15.2㎡ | 东南，衣柜北墙',
  '方案源：design/plan-a.scene.json',
  ':::',
].join('\n')

const STYLE = [
  '::: styleboard 原木日式 · 基调',
  '- 主色 | #E8E0D4 | 墙面大面',
  '- 辅色 | #A67B5B | 木作',
  '- 存疑 | 不是色值 | 待定',
  '质感：哑光木纹 · 低饱和',
  ':::',
].join('\n')

const RENDER = [
  '::: render 客餐厅效果图 · v1',
  '- 视角 | 南向沙发墙 45°',
  '- 风格 | 原木日式',
  '- 参数 | seed 12345 · 1024×768',
  '- 来源 | design/snap.png → design/render-1.png',
  ':::',
].join('\n')

let insertSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  insertSpy = vi.fn()
  useUiStore.setState({ insertToComposer: insertSpy as unknown as (text: string) => void })
})

describe('M65-C：设计容器族', () => {
  it('layout：房间表三段 + 方案源 chip + 打开按钮可用', () => {
    const { container } = render(<Markdown content={LAYOUT} />)
    expect(container.querySelector('[data-layout]')).toBeTruthy()
    expect(screen.getByText('客厅')).toBeTruthy()
    expect(screen.getByText('22.5㎡')).toBeTruthy()
    expect(screen.getByText('design/plan-a.scene.json')).toBeTruthy()
    expect(screen.getByTitle(/在 3D 工作台打开/)).toBeTruthy()
  })

  it('layout：点击「在 3D 工作台打开」→ STUDIO_OPEN_EVENT 携带方案源', () => {
    const handler = vi.fn()
    window.addEventListener(STUDIO_OPEN_EVENT, handler)
    try {
      render(<Markdown content={LAYOUT} />)
      fireEvent.click(screen.getByTitle(/在 3D 工作台打开/))
      expect(handler).toHaveBeenCalledTimes(1)
      expect((handler.mock.calls[0]![0] as CustomEvent<string>).detail).toBe('design/plan-a.scene.json')
    } finally {
      window.removeEventListener(STUDIO_OPEN_EVENT, handler)
    }
  })

  it('layout：房间行点击回填调整草稿（含房间 / 面积 / 要点）', () => {
    render(<Markdown content={LAYOUT} />)
    fireEvent.click(screen.getAllByTitle('点击回填调整草稿')[0]!)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    const text = insertSpy.mock.calls[0]![0] as string
    expect(text).toContain('@规方 想调整「客厅」')
    expect(text).toContain('面积 22.5㎡')
  })

  it('layout：无条目且无方案源 → children 原文兜底（不空卡）', () => {
    const { container } = render(<Markdown content={'::: layout\n（待补）\n:::'} />)
    expect(container.querySelector('[data-layout]')).toBeTruthy()
    expect(container.textContent).toContain('（待补）')
  })

  it('styleboard：色块（含非法降级）+ 质感行 + 按板调整回填（主/辅色）', () => {
    const { container } = render(<Markdown content={STYLE} />)
    expect(container.querySelectorAll('.md-sb-chip').length).toBe(3)
    expect(container.querySelectorAll('.md-sb-chip-invalid').length).toBe(1)
    expect(screen.getByText(/质感：哑光木纹/)).toBeTruthy()
    fireEvent.click(screen.getByTitle('回填「按此风格板调整方案」草稿'))
    const text = insertSpy.mock.calls[0]![0] as string
    expect(text).toContain('按「原木日式 · 基调」风格板调整方案')
    expect(text).toContain('主色 #E8E0D4 墙面')
    expect(text).toContain('辅色 #A67B5B 木作')
  })

  it('render：元信息行 + 无 session 提示 + 再生成回填（seed 提取）', () => {
    render(<Markdown content={RENDER} />)
    expect(screen.getByText('南向沙发墙 45°')).toBeTruthy()
    expect(screen.getByText(/seed 12345/)).toBeTruthy()
    expect(screen.getByText('产物未就位（生成中或路径不可用）')).toBeTruthy()
    fireEvent.click(screen.getByTitle('回填「再生成一版」草稿'))
    const text = insertSpy.mock.calls[0]![0] as string
    expect(text).toContain('再生成一版「客餐厅效果图 · v1」')
    expect(text).toContain('seed 沿用 12345')
  })

  it('纯函数：parseLayoutItems / parseSwatches / renderProductPath / seedOfParams', () => {
    expect(parseLayoutItems('[{"room":"客厅","area":"22.5㎡","note":"南向"}]')).toEqual([
      { room: '客厅', area: '22.5㎡', note: '南向' },
    ])
    expect(parseLayoutItems('not-json')).toEqual([])
    expect(parseLayoutItems('[{"area":"x"}]')).toEqual([]) // 缺 room 过滤
    expect(parseSwatches('[{"name":"主色","hex":"#fff","usage":"墙"}]')).toHaveLength(1)
    expect(parseSwatches('[{}]')).toEqual([])
    expect(renderProductPath('a.png → b/c.png')).toBe('b/c.png')
    expect(renderProductPath('单一.png')).toBe('单一.png')
    expect(renderProductPath('not-image.txt')).toBeUndefined()
    expect(renderProductPath(undefined)).toBeUndefined()
    expect(seedOfParams('seed 42 · 1024×768 · 步数 28')).toBe('42')
    expect(seedOfParams('无')).toBeUndefined()
  })

  it('纯函数：模板输出（layout 文本 / 快照 / 调整 / 再生成）', () => {
    expect(buildLayoutText('方案 A', [{ room: '客厅', area: '22.5㎡', note: '南向' }], 'design/a.scene.json')).toContain(
      '方案源：design/a.scene.json',
    )
    expect(tplSnapshotToRender({ snapshot: 'canvas/media/s.png', style: '原木日式', seed: '42' })).toBe(
      '基于 canvas/media/s.png 走图生图出效果图，风格 原木日式；参数 seed 沿用 42；',
    )
    expect(tplAdjustRoom({ room: '客厅' })).toContain('想调整「客厅」')
    expect(tplRegenRender({ title: '效果图' })).toContain('seed 换新')
    expect(tplApplyStyleboard({ theme: '原木日式' })).toContain('保持现有布局不动')
  })
})
