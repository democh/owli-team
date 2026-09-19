/**
 * M14：Markdown 扩展的真实浏览器验收（懒加载 chunk 的实际加载路径 + 渲染产物）。
 * 用户消息发送后立即渲染（不依赖 LLM 输出）：mermaid（5.5MB 单文件 bundle 挂 globalThis）/
 * echarts（按需 chunk 懒加载）真实初始化；分栏 / 代码块工具条 / 行高亮 / 表格包裹 / 裁决卡（::: verdict）/ 盘面卡（::: pan）；
 * TurnCard：mock 运行完成后 agent 卡带组色主题条与角色、波次徽章。
 *
 * 与单测（mock 渲染库）互补：这里验证 lib/mermaid、lib/chart 在真实浏览器可加载可用。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('Markdown 扩展：mermaid / chart / 分栏 / 代码块工具条真实渲染', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `md-ext-${Date.now()}` })

  const content = [
    '```mermaid',
    'graph TD',
    '  A[需求] --> B[设计]',
    '  B --> C[开发]',
    '```',
    '',
    '```chart',
    '{"type":"bar","title":"各端预算","labels":["Web","iOS"],"series":[{"name":"预算","data":[12,8]}]}',
    '```',
    '',
    '::: cols 2',
    '::: col 前端',
    '页面与状态管理',
    ':::',
    '::: col 后端',
    '接口与数据模型',
    ':::',
    ':::',
    '',
    '```ts title="app.ts" {1}',
    'const a = 1',
    'const b = 2',
    '```',
  ].join('\n')

  await sendMessage(page, content)

  // mock 接力会立即涌入 agent 消息，把用户消息顶出虚拟列表视口（DOM 卸载）：
  // 轮询中强制回滚到顶部（程序化滚动会触发 onScroll → 解除 sticky 跟随），
  // 等待 mermaid 单文件 bundle 懒加载完成 → SVG 真实挂载
  const log = page.locator('[role="log"]')
  await expect
    .poll(
      async () => {
        await log.evaluate((el) => {
          el.scrollTop = 0
        })
        return page.locator('.md-mermaid-canvas svg').count()
      },
      { timeout: 30_000, intervals: [300, 600, 1000] },
    )
    .toBeGreaterThan(0)

  // mermaid：单文件 bundle 懒加载 → SVG 渲染（含 5.5MB chunk 的真实加载）
  await expect(page.locator('.md-mermaid-canvas svg').first()).toBeVisible()
  await expect(page.locator('.md-mermaid .md-block-lang').first()).toHaveText('mermaid')

  // chart：echarts 按需 chunk 懒加载 → canvas 就绪
  await expect(page.locator('.md-chart-canvas[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.md-chart-canvas canvas').first()).toBeVisible()

  // 分栏：两列网格 + 列标题（::before 伪元素取 data-title）
  const cols = page.locator('.md-cols').first()
  await expect(cols).toBeVisible()
  await expect(cols.locator('.md-col')).toHaveCount(2)
  await expect(cols.locator('.md-col').first()).toHaveAttribute('data-title', '前端')

  // 代码块工具条：文件名 + 语言 + 行高亮（限定 .md-codeblock，避开 mermaid/chart 工具条）
  await expect(page.locator('.md-codeblock .md-block-title').first()).toHaveText('app.ts')
  await expect(page.locator('.md-codeblock .md-shiki .hl-line').first()).toBeVisible()
})

test('TurnCard：组色主题条与波次徽章（agent 消息）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `turncard-${Date.now()}` })
  await sendMessage(page, '简单介绍一下这个项目的结构')

  // mock 运行收束后，agent 消息出现组色主题条（研发团队 theme[0] = #3b82f6）
  await expectYourTurn(page)
  const accent = page.locator('[data-turn-accent]').first()
  await expect(accent).toBeVisible()
  await expect(accent).toHaveAttribute('data-turn-accent', '#3b82f6')
  await expect(page.locator('.turn-role').first()).toBeVisible()
  // 波次徽章：虚拟列表收起于运行中段时首条 agent 消息不在渲染窗口——先滚回顶部（M37 同口径）
  const log = page.getByRole('log', { name: '消息流' })
  await log.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.locator('.turn-wave').first()).toContainText('第 1 波')
  // 运行结束后流式进度线全部移除
  await expect(page.locator('.turn-progress')).toHaveCount(0)
})

test('裁决卡：::: verdict 容器真实渲染（徽章 / 标题 / 条目）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `verdict-${Date.now()}` })

  const content = [
    '::: verdict 多方 发布前裁决',
    '- 置信度 | 高',
    '- 核心依据 | 回归全绿且核心路径压测达标',
    '- 翻盘条件 | 出现阻塞级缺陷 → 裁决翻转',
    ':::',
  ].join('\n')
  await sendMessage(page, content)

  // mock 接力涌入会把用户消息顶出视口（虚拟列表卸载）：轮询回滚到顶部等卡片渲染
  const log = page.locator('[role="log"]')
  await expect
    .poll(
      async () => {
        await log.evaluate((el) => {
          el.scrollTop = 0
        })
        return page.locator('.md-verdict').count()
      },
      { timeout: 20_000, intervals: [200, 500, 1000] },
    )
    .toBeGreaterThan(0)

  const card = page.locator('.md-verdict').first()
  await expect(card.locator('.md-verdict-badge')).toHaveText('多方')
  await expect(card.locator('.md-verdict-title')).toHaveText('发布前裁决')
  await expect(card.locator('.md-verdict-row')).toHaveCount(3)
  await expect(card.locator('.md-verdict-label').first()).toHaveText('置信度')
  await expect(card.locator('.md-verdict-value').last()).toContainText('出现阻塞级缺陷')
})

test('盘面卡：::: pan 容器真实渲染（类型徽标 / 字段行 / 条目行）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `pan-${Date.now()}` })

  const content = [
    '::: pan gua 无妄卦解',
    '起卦：数字起卦 ｜ 2026-09-19',
    '本卦：天雷无妄 ｜ 互卦：风山渐 ｜ 变卦：天火同人',
    '- 上九 | 白虎 兄弟 壬戌 世',
    '- 六三 | 朱雀 妻财 庚午 应 动 → 己亥',
    ':::',
  ].join('\n')
  await sendMessage(page, content)

  // mock 接力涌入会把用户消息顶出视口（虚拟列表卸载）：轮询回滚到顶部等卡片渲染
  const log = page.locator('[role="log"]')
  await expect
    .poll(
      async () => {
        await log.evaluate((el) => {
          el.scrollTop = 0
        })
        return page.locator('.md-pan').count()
      },
      { timeout: 20_000, intervals: [200, 500, 1000] },
    )
    .toBeGreaterThan(0)

  const card = page.locator('.md-pan').first()
  await expect(card.locator('.md-pan-badge')).toHaveText('卦')
  await expect(card.locator('.md-pan-title')).toHaveText('无妄卦解')
  await expect(card.locator('.md-pan-row')).toHaveCount(2)
  await expect(card.locator('.md-pan-label').first()).toHaveText('起卦')
  await expect(card.locator('.md-pan-item')).toHaveCount(2)
  await expect(card.locator('.md-pan-item-value').last()).toContainText('动 → 己亥')
})
