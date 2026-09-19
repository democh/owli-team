/**
 * M51-E（E6）：::: pan 盘面卡渲染测试。
 * - 四类型（bazi / ziwei / natal / gua）：字段行（`键：值`）→ data-fields、条目行（`- 键 | 值`）→ data-items；
 * - 降级链：未知类型 → 通用「盘面」徽标；无结构化行 → raw / children 兜底；未闭合 → 内容展开为原文；
 * - 轻结构容器流式期间直接渲染（与 verdict 同档）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from '../src/components/chat/Markdown'
import { clearMarkdownCaches } from '../src/lib/md-cache'

beforeEach(() => {
  clearMarkdownCaches()
})

// ---------- fixtures（对齐 pan.ts 盘面卡模板） ----------

const BAZI = [
  '::: pan bazi',
  '四柱：庚子 戊寅 壬午 辛亥（男）',
  '十神：偏印 七杀 日主 正印',
  '五行：火1 土2 金2 水2 木1',
  '大运：辛巳 壬午 癸未 甲申',
  ':::',
].join('\n')

const ZIWEI = [
  '::: pan ziwei',
  '基本信息：金四局 ｜ 命主 巨门 ｜ 身主 天梁 ｜ 农历庚子年正月十五 子时',
  '- 命宫 | 丙戌 紫微 天相 ｜ 大限 6-15',
  '- 兄弟 | 丁亥 天机 ｜ 大限 16-25',
  ':::',
].join('\n')

const NATAL = [
  '::: pan natal',
  '出生：1996-03-15 14:30（Asia/Shanghai）@ 31.23,121.47',
  '宫制：Placidus ｜ ASC 巨蟹 12°34′ ｜ MC 双鱼 20°11′',
  '- 太阳 | 双鱼 25°10′ ｜ 9 宫',
  '- 月亮 | 天蝎 03°22′ ｜ 5 宫 ｜ 逆行',
  ':::',
].join('\n')

const GUA = [
  '::: pan gua',
  '起卦：数字起卦 ｜ 2026-09-19',
  '本卦：天雷无妄 ｜ 互卦：风山渐 ｜ 变卦：天火同人',
  '动爻：六三',
  '- 上九 | 白虎 兄弟 壬戌 世',
  '- 六三 | 朱雀 妻财 庚午 应 动 → 己亥',
  ':::',
].join('\n')

// ---------- 四类型基础渲染 ----------

describe('::: pan 盘面卡（Markdown 路由）', () => {
  it('八字：类型类 + 徽标，字段行结构化（四柱 / 十神 / 五行 / 大运）', () => {
    const { container } = render(<Markdown content={BAZI} />)
    const pan = container.querySelector('.md-pan.md-pan-bazi')
    expect(pan).not.toBeNull()
    expect(container.querySelector('.md-pan-badge')?.textContent).toBe('八字')
    const rows = container.querySelectorAll('.md-pan-row')
    expect(rows).toHaveLength(4)
    expect(rows[0]!.querySelector('.md-pan-label')?.textContent).toBe('四柱')
    expect(rows[0]!.querySelector('.md-pan-value')?.textContent).toBe('庚子 戊寅 壬午 辛亥（男）')
    expect(rows[1]!.querySelector('.md-pan-value')?.textContent).toBe('偏印 七杀 日主 正印')
  })

  it('紫微：字段 + 宫位条目（`- 键 | 值` 首个 | 拆键值，值内全角 ｜ 保留）', () => {
    const { container } = render(<Markdown content={ZIWEI} />)
    expect(container.querySelector('.md-pan.md-pan-ziwei')).not.toBeNull()
    expect(container.querySelector('.md-pan-badge')?.textContent).toBe('紫微')
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(1)
    const items = container.querySelectorAll('.md-pan-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.querySelector('.md-pan-item-label')?.textContent).toBe('命宫')
    expect(items[0]!.querySelector('.md-pan-item-value')?.textContent).toBe('丙戌 紫微 天相 ｜ 大限 6-15')
  })

  it('星盘：出生 / 宫制字段 + 行星条目（逆行标注保留）', () => {
    const { container } = render(<Markdown content={NATAL} />)
    expect(container.querySelector('.md-pan.md-pan-natal')).not.toBeNull()
    expect(container.querySelector('.md-pan-badge')?.textContent).toBe('星盘')
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(2)
    const items = container.querySelectorAll('.md-pan-item')
    expect(items).toHaveLength(2)
    expect(items[1]!.querySelector('.md-pan-item-value')?.textContent).toBe('天蝎 03°22′ ｜ 5 宫 ｜ 逆行')
  })

  it('卦：起卦 / 本卦 / 动爻字段 + 爻题条目（世应 / 动变保留）', () => {
    const { container } = render(<Markdown content={GUA} />)
    expect(container.querySelector('.md-pan.md-pan-gua')).not.toBeNull()
    expect(container.querySelector('.md-pan-badge')?.textContent).toBe('卦')
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(3)
    const items = container.querySelectorAll('.md-pan-item')
    expect(items).toHaveLength(2)
    expect(items[1]!.querySelector('.md-pan-item-label')?.textContent).toBe('六三')
    expect(items[1]!.querySelector('.md-pan-item-value')?.textContent).toBe('朱雀 妻财 庚午 应 动 → 己亥')
  })
})

// ---------- 降级链 ----------

describe('::: pan 降级链', () => {
  it('未知类型词：降级通用「盘面」徽标（保留标题）', () => {
    const { container } = render(<Markdown content={'::: pan qimen 奇门局示例\n门：开门\n:::'} />)
    const pan = container.querySelector('.md-pan')
    expect(pan).not.toBeNull()
    expect(pan!.classList.contains('md-pan-qimen')).toBe(false)
    expect(container.querySelector('.md-pan-badge')?.textContent).toBe('盘面')
    expect(container.querySelector('.md-pan-title')?.textContent).toBe('奇门局示例')
    expect(container.querySelector('.md-pan-value')?.textContent).toBe('开门')
  })

  it('解析失败 = 原文：无结构化行（含普通文本）时仍可读，不丢内容', () => {
    const { container } = render(<Markdown content={'::: pan gua\n一段非结构化的盘面说明文字\n:::'} />)
    expect(container.querySelector('.md-pan')).not.toBeNull()
    expect(container.querySelector('.md-pan-badge')).toBeNull()
    expect(container.textContent).toContain('一段非结构化的盘面说明文字')
  })

  it('混合内容：字段行结构化 + 未命中行保留原段落（如告警）', () => {
    const { container } = render(
      <Markdown content={'::: pan natal\n出生：1996-03-15 14:30（Asia/Shanghai）\n⚠ 高纬降级：等宫制\n:::'} />,
    )
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(1)
    expect(container.querySelector('.md-pan-value')?.textContent).toBe('1996-03-15 14:30（Asia/Shanghai）')
    expect(container.textContent).toContain('⚠ 高纬降级：等宫制')
  })

  it('未闭合容器：fail-safe 展开为原文（无盘面卡壳）', () => {
    const { container } = render(<Markdown content={'::: pan bazi\n四柱：庚子 戊寅 壬午 辛亥（男）'} />)
    expect(container.querySelector('.md-pan')).toBeNull()
    expect(container.textContent).toContain('四柱：庚子 戊寅 壬午 辛亥（男）')
  })

  it('先盘后论：容器与解读共存（卡在前、解读在后）', () => {
    const { container } = render(<Markdown content={BAZI + '\n\n日主壬水生于寅月，参考区间为身弱喜印比。'} />)
    expect(container.querySelector('.md-pan')).not.toBeNull()
    expect(container.textContent).toContain('日主壬水生于寅月')
  })

  it('流式期间：轻结构容器直接渲染（与 verdict 同档）', () => {
    const { container } = render(<Markdown content={BAZI} streaming />)
    expect(container.querySelector('.md-pan.md-pan-bazi')).not.toBeNull()
    expect(container.querySelectorAll('.md-pan-row')).toHaveLength(4)
  })
})
