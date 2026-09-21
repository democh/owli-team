/**
 * E2E · M28 MCP JSON 直配（mock 模式；独立 MCP_CONFIG_FILE = data/<PW_DATA_DIR>/mcp.json，轮询 1.5s）：
 * 1) 写入 mcp.json（stdio 指向 echo-mcp 夹具 + eagerLoad: true）→ mtime 轮询自动同步落地（验收：≤5s）；
 * 2) 管理台：JSON 状态卡（文件已就绪 / 条目）+ 服务器卡（「由 mcp.json 管理」「全部常驻」徽章）+
 *    连接完成后工具快照（6 个）与「常驻」加载列（eagerLoad 豁免延迟发现）；
 * 3) json 源只读（编辑 / 删除 / 启停禁用）；绑定当前会话（最小权限）；
 * 4) 修改文件（displayName + timeoutMs）→ 轮询自动更新；
 * 5) 坏 JSON → 整次跳过：错误可见且服务器绝不清空（防误删护栏）；
 * 6) 空 mcpServers → 文件权威删除（级联清理）；afterAll 复位文件 + 手动同步兜底。
 *
 * 清理约定：本文件固定使用 slug `e2e-json-echo`（upsert 幂等，失败重跑不累积）；
 * afterAll 将文件复位为空 mcpServers 并请求一次手动同步（best-effort，server 已停则由轮询/下次启动兜底）。
 */
import { expect, request, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { createSession, openApp } from './helpers'

const REPO_ROOT = process.cwd()
/** 与 playwright.config.ts 的 main server env 对齐（MCP_CONFIG_FILE=data/<PW_DATA_DIR>/mcp.json；轮换目录同轨） */
const DATA_SLUG = process.env.PW_DATA_DIR || 'e2e-main'
const MCP_FILE = path.join(REPO_ROOT, 'data', DATA_SLUG, 'mcp.json')
const SLUG = 'e2e-json-echo'
const DISPLAY = 'E2E JSON 回声'
/** stdio 启动参数：夹具绝对路径（与 m27-mcp.spec.ts 同一 echo-mcp.mjs，6 个工具） */
const FIXTURE_PATH = path.join(REPO_ROOT, 'server', 'tests', 'fixtures', 'echo-mcp.mjs')

/** 写入 mcp.json（生态标准 mcpServers 格式；写操作更新 mtime → 轮询自动同步） */
function writeConfig(servers: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(MCP_FILE), { recursive: true })
  fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: servers }, null, 2))
}

test.afterAll(async () => {
  // 复位为空配置（幂等兜底：下次启动同步 / 轮询将清掉本次服务器）
  try {
    writeConfig({})
  } catch {
    // 文件不可写：忽略（数据目录只读属异常环境）
  }
  // 尽力立即触发一次同步（server 仍在运行时生效；已停止则跳过）
  try {
    const api = await request.newContext()
    await api.post('http://127.0.0.1:8788/api/mcp/json-config/sync')
    await api.dispose()
  } catch {
    // server 已停止：轮询 / 下次启动清理兜底
  }
})

test('M28 · MCP JSON 直配：文件同步 → 工具快照 → 绑定 → 变更/坏文件/删除', async ({ page }) => {
  // ---------- 0) 初始写入（覆盖上次残留；mtime 变化触发 mtime 轮询） ----------
  writeConfig({
    [SLUG]: {
      command: 'node',
      args: [FIXTURE_PATH],
      displayName: DISPLAY,
      eagerLoad: true,
    },
  })

  await openApp(page)
  await createSession(page, { title: 'E2E M28 JSON 会话' })

  // ---------- 1) MCP 管理：轮询自动同步 → 服务器卡落地 ----------
  await page.getByRole('button', { name: 'MCP 管理' }).click()
  const card = page.locator('article').filter({ hasText: DISPLAY })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByText(SLUG)).toBeVisible()
  await expect(card.getByText('由 mcp.json 管理')).toBeVisible()
  await expect(card.getByText('全部常驻')).toBeVisible()
  // 同步内 connect 完成（manager 广播 notify:mcp-changed）→ 工具快照自动刷新到 6 个
  await expect(card.getByText('工具 · 6')).toBeVisible({ timeout: 15_000 })

  // JSON 状态卡：文件已就绪 + 条目列表
  const jsonCard = page.locator('article').filter({ hasText: 'JSON 配置' })
  await expect(jsonCard).toBeVisible()
  await expect(jsonCard.getByText('文件已就绪')).toBeVisible()
  await expect(jsonCard.getByText(new RegExp(`条目：${SLUG}`))).toBeVisible()

  // json 源只读保护：编辑 / 删除 / 启停禁用
  await expect(card.getByTitle('由 mcp.json 管理（只读）：请编辑配置文件后同步')).toBeDisabled()
  await expect(card.getByTitle('由 mcp.json 管理（只读）：删除 = 从配置文件移除后同步')).toBeDisabled()
  await expect(card.getByRole('switch', { name: `启用 ${SLUG}` })).toBeDisabled()

  // ---------- 2) 工具清单：eagerLoad → 「常驻」加载列（M28 延迟发现豁免） ----------
  await card.getByRole('button', { name: '工具清单' }).click()
  const table = card.getByRole('table')
  await expect(table.getByText(`mcp__${SLUG}__echo`)).toBeVisible()
  await expect(table.getByText('常驻').first()).toBeVisible()

  // ---------- 3) 绑定当前会话（最小权限） ----------
  await card.getByRole('button', { name: '绑定' }).click()
  await expect(page.getByText(`已绑定「${SLUG}」到当前会话`)).toBeVisible()
  await expect(card.getByRole('button', { name: '解绑' })).toBeVisible()

  // ---------- 4) 修改文件：displayName + timeoutMs → 轮询自动更新（验收：≤5s 落地） ----------
  writeConfig({
    [SLUG]: {
      command: 'node',
      args: [FIXTURE_PATH],
      displayName: `${DISPLAY} v2`,
      timeoutMs: 30_000,
      eagerLoad: true,
    },
  })
  await expect(page.getByText(`${DISPLAY} v2`)).toBeVisible({ timeout: 15_000 })
  await expect(card.getByText(/超时 · 30000ms/)).toBeVisible()

  // ---------- 5) 坏 JSON：整次跳过（错误可见 + 服务器绝不清空） ----------
  fs.writeFileSync(MCP_FILE, '{ "mcpServers": { broken')
  await expect(jsonCard.getByText(/JSON 解析失败/)).toBeVisible({ timeout: 15_000 })
  await expect(jsonCard.getByText(/上次已跳过/)).toBeVisible()
  await expect(card).toBeVisible() // 防误删护栏：服务器仍在

  // ---------- 6) 空 mcpServers：文件权威删除（级联清理） ----------
  writeConfig({})
  await expect(card).toHaveCount(0, { timeout: 15_000 })
  await expect(jsonCard.getByText(new RegExp(SLUG))).toHaveCount(0)
})
