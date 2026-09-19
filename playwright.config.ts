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
 * - M57 启动命令用 `exec node --import tsx`：去掉 npm/npx 包装层，Playwright 结束时
 *   能可靠 kill 真正的服务进程（包装层会导致孙进程变孤儿、端口残留，造成后续复用脏实例/EADDRINUSE）。
 * - M52-D 收口：mock 节奏 20→30ms/片——整轮 mock 运行由 ~3.2s 拉长至 ~4.8s，系统性放宽
 *   「运行收束竞态」窗口（刷新重附着 / 运行中邀请 / 运行中操作类断言），机器负载决定
 *   的页面初始化耗时不再与运行时长贴身赛跑；对等待式断言无影响。
 */
import { defineConfig } from '@playwright/test'

const BUILD_CLIENT = 'npm run build -w @multi-agent/client'

/**
 * M57 续（M40 批五启用）：main 链路的**端口与数据目录**可用环境变量隔离——
 * 并发会话常驻 8788（手工启动的 server 会因 reuseExistingServer 被后续 playwright 复用，
 * 且其进程内 mock 为旧版本）时：
 *   PW_PORT=8795 PW_DATA_DIR=e2e-<name> PW_OUTPUT_DIR=/tmp/pw-<name> npx playwright test ...
 * 默认（不设 env）行为与既有完全一致（8788 / data/e2e-main）。
 */
const MAIN_PORT = Number(process.env.PW_PORT || 8788)
const MAIN_SLUG = process.env.PW_DATA_DIR || 'e2e-main'
const MAIN_DATA = `data/${MAIN_SLUG}`

export default defineConfig({
  testDir: './e2e',
  /**
   * M57：产物目录可用 PW_OUTPUT_DIR 隔离——并发会话（同一仓库多人/多终端跑 e2e）默认共用
   * `test-results/`：后启动的会话清理该目录会导致先启动会话的 trace / 截图写入 ENOENT（假失败）。
   * 并行验证时：`PW_OUTPUT_DIR=/tmp/pw-<name> npx playwright test ...` 互不影响。
   */
  outputDir: process.env.PW_OUTPUT_DIR || 'test-results',
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
      command: `${BUILD_CLIENT} && exec node --import tsx server/src/index.ts`,
      url: `http://127.0.0.1:${MAIN_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        LLM_MOCK: 'true',
        LLM_MOCK_DELAY_MS: '30',
        APPROVAL_MODE: 'off',
        MAX_TURNS_PER_RUN: '12',
        PORT: String(MAIN_PORT),
        DATA_DIR: MAIN_DATA,
        WORKSPACE_DIR: `workspace/${MAIN_SLUG}`,
        DB_FILE: `${MAIN_DATA}/app.db`,
        SETTINGS_FILE: `${MAIN_DATA}/settings.json`,
        WORKTREE_DIR: `${MAIN_DATA}/worktrees`,
        LOG_DIR: `${MAIN_DATA}/logs`,
        LOG_LEVEL: 'warn',
        // M28：mcp.json 直配走独立隔离文件（轮询加速到 1.5s，验证「≤5s 自动同步」验收）
        MCP_CONFIG_FILE: `${MAIN_DATA}/mcp.json`,
        MCP_CONFIG_POLL_MS: '1500',
      },
    },
    {
      // 等待 main 完成 client 构建（单端口托管的静态资源由两者共享）
      command: `bash -c 'until [ -f client/dist/index.html ]; do sleep 0.3; done; exec node --import tsx server/src/index.ts'`,
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
    {
      // M57：多用户隔离链路（独立持久数据目录：首启向导 → 登录 → 跨用户隔离；spec 幂等可重跑）
      command: `bash -c 'until [ -f client/dist/index.html ]; do sleep 0.3; done; exec node --import tsx server/src/index.ts'`,
      url: 'http://127.0.0.1:8790/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        LLM_MOCK: 'true',
        LLM_MOCK_DELAY_MS: '30',
        APPROVAL_MODE: 'off',
        MAX_TURNS_PER_RUN: '12',
        PORT: '8790',
        DATA_DIR: 'data/e2e-auth',
        WORKSPACE_DIR: 'workspace/e2e-auth',
        DB_FILE: 'data/e2e-auth/app.db',
        SETTINGS_FILE: 'data/e2e-auth/settings.json',
        WORKTREE_DIR: 'data/e2e-auth/worktrees',
        LOG_DIR: 'data/e2e-auth/logs',
        LOG_LEVEL: 'warn',
        MCP_CONFIG_FILE: 'data/e2e-auth/mcp.json',
        // 登录防爆破放宽：e2e 重复跑时避免误触锁定（用例本身验证锁定在 server 单测层）
        LOGIN_LOCKOUT_THRESHOLD: '50',
        // 登录 IP 限流放宽：同一 8790 实例可能被多个并发验证会话共用（误触 429 → 登录页停住）
        LOGIN_RATE_LIMIT: '300',
      },
    },
  ],
  projects: [
    {
      name: 'main',
      testMatch: /(relay|interject|stop|right-panel|reload|artifact-(diff|preview)|m12-interactions|m14-responsive|markdown-ext|m16-.*|m21-.*|m22-.*|m24-.*|m25-.*|m26-.*|m27-.*|m28-.*|m31-.*|m33-.*|m34-.*|m37-.*|m38-.*|m39-.*|m40-.*|m41-.*|m42-.*|m43-.*|m44-.*|m45-.*|m48-.*|m50-.*|m52-.*|m54-.*|m63-.*|m65-.*|m66-.*|m69-.*|m77-.*|m78-.*|console-scenes)\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${MAIN_PORT}` },
    },
    {
      name: 'approval',
      testMatch: /approval\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:8789' },
    },
    {
      // M57：多用户（独立实例，含首启向导 / 隔离断言）
      name: 'auth',
      testMatch: /m57-auth\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:8790' },
    },
  ],
})
