/**
 * Playwright E2E 配置（M10）：mock 模式（LLM_MOCK=true）下跑主链路
 * （M12 交互回复 / M14 窄屏响应式 / M16 成员·灵魂·波次·图谱 等）。
 *
 * - 双服务器：main(8788, APPROVAL_MODE=off) 与 approval(8789, APPROVAL_MODE=all)；
 *   客户端以生产形态由 server 单端口托管（先 vite build，再 tsx 启动，覆盖「单端口托管」验收）；
 * - 数据隔离：各自独立 DATA_DIR / WORKSPACE_DIR / DB_FILE / SETTINGS_FILE（data/e2e-*），绝不触碰真实数据；
 *   路径变量显式钉死——config.ts 的 dotenv 不覆盖已存在 env，仓库根 .env 里的
 *   DB_FILE / SETTINGS_FILE 会绕过 DATA_DIR 泄漏到真实数据（含 approvalMode 等运行期设置）；
 * - 串行执行（workers=1）：两条链路共享同一服务器，避免互相干扰断言。
 * - M52-D 收口：mock 节奏 20→30ms/片——整轮 mock 运行由 ~3.2s 拉长至 ~4.8s，系统性放宽
 *   「运行收束竞态」窗口（刷新重附着 / 运行中邀请 / 运行中操作类断言），机器负载决定
 *   的页面初始化耗时不再与运行时长贴身赛跑；对等待式断言无影响。
 */
import { defineConfig } from '@playwright/test'

const BUILD_CLIENT = 'npm run build -w @multi-agent/client'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `${BUILD_CLIENT} && npx tsx server/src/index.ts`,
      url: 'http://127.0.0.1:8788/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        LLM_MOCK: 'true',
        LLM_MOCK_DELAY_MS: '30',
        APPROVAL_MODE: 'off',
        MAX_TURNS_PER_RUN: '12',
        PORT: '8788',
        DATA_DIR: 'data/e2e-main',
        WORKSPACE_DIR: 'workspace/e2e-main',
        DB_FILE: 'data/e2e-main/app.db',
        SETTINGS_FILE: 'data/e2e-main/settings.json',
        WORKTREE_DIR: 'data/e2e-main/worktrees',
        LOG_DIR: 'data/e2e-main/logs',
        LOG_LEVEL: 'warn',
        // M28：mcp.json 直配走独立隔离文件（轮询加速到 1.5s，验证「≤5s 自动同步」验收）
        MCP_CONFIG_FILE: 'data/e2e-main/mcp.json',
        MCP_CONFIG_POLL_MS: '1500',
      },
    },
    {
      // 等待 main 完成 client 构建（单端口托管的静态资源由两者共享）
      command: `bash -c 'until [ -f client/dist/index.html ]; do sleep 0.3; done; exec npx tsx server/src/index.ts'`,
      url: 'http://127.0.0.1:8789/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        LLM_MOCK: 'true',
        LLM_MOCK_DELAY_MS: '30',
        APPROVAL_MODE: 'all',
        MAX_TURNS_PER_RUN: '12',
        PORT: '8789',
        DATA_DIR: 'data/e2e-approval',
        WORKSPACE_DIR: 'workspace/e2e-approval',
        DB_FILE: 'data/e2e-approval/app.db',
        SETTINGS_FILE: 'data/e2e-approval/settings.json',
        WORKTREE_DIR: 'data/e2e-approval/worktrees',
        LOG_DIR: 'data/e2e-approval/logs',
        LOG_LEVEL: 'warn',
        // M28：同样隔离（文件不存在 = 跳过同步，与本链路无干扰）
        MCP_CONFIG_FILE: 'data/e2e-approval/mcp.json',
      },
    },
  ],
  projects: [
    {
      name: 'main',
      testMatch: /(relay|interject|stop|right-panel|reload|artifact-(diff|preview)|m12-interactions|m14-responsive|markdown-ext|m16-.*|m21-.*|m22-.*|m24-.*|m25-.*|m26-.*|m27-.*|m28-.*|m31-.*|m33-.*|m34-.*|m37-.*|m42-.*|m43-.*|m48-.*|m50-.*|m52-.*|m54-.*)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:8788' },
    },
    {
      name: 'approval',
      testMatch: /approval\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:8789' },
    },
  ],
})
