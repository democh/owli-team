/**
 * E2E · M25 向量记忆（mock 模式，零网络）：
 * 1) 嵌入连接 → 设置选中 → 对话 → ContextBar 的 L1.5 分层接线
 *    （本会话无记忆：detail=「（无召回）」+「本回合无召回注入」）；
 * 2) 记忆面板：新增会话记忆 → embed 队列补账（2s 周期，轮询等待）→ 语义搜索返回混合评分。
 *
 * 说明：LLM_MOCK=true 下嵌入解析恒为确定性 Mock（EmbeddingManager.resolve 优先），
 * 因此「连接断连 / 休眠」路径无法在 e2e 触发（由 server 单测 m25-recall.test.ts 覆盖）；
 * 端点填不可达地址（127.0.0.1:9）以证明「保存并测试」全程零网络。
 */
import { expect, test, type Page } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

async function sessionIdByTitle(page: Page, title: string): Promise<string> {
  const res = await page.request.get('/api/sessions')
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> }
  const hit = body.sessions.find((s) => s.title === title)
  expect(hit, `未找到会话：${title}`).toBeTruthy()
  return hit!.id
}

test('嵌入连接 → 设置启用 → L1.5 分层随快照输出（无召回注入）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M25-上下文-${Date.now()}` })

  // 连接管理（左侧 rail 控制台）：新建「嵌入模型」连接（端点不可达；LLM_MOCK 下探测恒走 Mock）
  const connName = `E2E 嵌入端点 ${Date.now()}`
  await page.getByRole('button', { name: '连接管理', exact: true }).click()
  await page.getByTitle('新建连接').click()
  await page.getByRole('button', { name: /嵌入模型/ }).click()
  await page.getByPlaceholder('如：生产只读库').fill(connName)
  await page.getByPlaceholder('https://api.openai.com/v1').fill('http://127.0.0.1:9/v1')
  await page.getByPlaceholder('text-embedding-3-small').fill('e2e-embed')
  await page.getByRole('button', { name: '保存并测试' }).click()
  await expect(page.getByText(/连接正常.*mock-embed/)).toBeVisible()

  // 设置（rail 底部入口；M36 起为主区视图）：选中该连接并保存（热应用，无需重启）
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('嵌入连接').selectOption({ label: connName })
  await page.getByRole('button', { name: '保存并生效' }).click()
  await expect(page.getByText('设置已保存并即时生效')).toBeVisible()
  await expect(page.getByRole('heading', { name: '模型与生成' })).toBeVisible()

  // 回到工作台（连接管理是独立控制台视图，对话在主区进行）
  await page.getByRole('button', { name: '工作台', exact: true }).click()

  // 对话一回合：L1.5 层随上下文快照输出（会话记忆由 L1 承载并被 L1.5 去重）
  await sendMessage(page, '请评审发布流程要求并给出交付件。')
  await expectYourTurn(page)
  await page.getByTitle('查看上下文分层与摘要').click()
  await expect(page.getByText('语义召回（L1.5）')).toBeVisible()
  await expect(page.getByText('（无召回）')).toBeVisible()
  await expect(page.getByText('本回合无召回注入')).toBeVisible()
})

test('记忆面板：新增会话记忆 → 队列补账 → 语义搜索评分', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M25-记忆-${Date.now()}`
  await createSession(page, { title })

  // 记忆面板（右栏一级「运行」组 → 二级「记忆」）新增一条会话记忆（旧接口兼容；写入即入 embed 队列）
  const memoText = `接口错误码统一用 { code, message } 结构（E2E ${Date.now()}）`
  await page.getByRole('tab', { name: '运行' }).click()
  await page.getByRole('tab', { name: /记忆/ }).click()
  await page.getByTitle('新增记忆').click()
  await page.getByPlaceholder('例如：接口错误码统一用 { code, message } 结构').fill(memoText)
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByText(memoText)).toBeVisible()

  // embed 队列 2s 周期：轮询调试接口等待向量补账（Mock 确定性 → 可断言）
  const sessionId = await sessionIdByTitle(page, title)
  await expect
    .poll(
      async () => {
        const res = await page.request.post('/api/memories/recall', { data: { query: memoText, sessionId } })
        const body = (await res.json()) as { outcome?: { items?: unknown[] } }
        return body.outcome?.items?.length ?? 0
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThan(0)

  // 语义搜索（回车召回）：内容 + 混合评分（同文查询 sim=1 → 0.9x）
  const search = page.getByPlaceholder('语义搜索（回车召回，含评分）')
  await search.fill(memoText)
  await search.press('Enter')
  await expect(page.getByText(/记忆 \d+ 条（语义搜索）/)).toBeVisible()
  await expect(page.getByText(memoText)).toBeVisible()
  await expect(page.getByText(/^0\.9\d{2}$/).first()).toBeVisible()
})
