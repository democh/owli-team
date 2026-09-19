/**
 * 评测运行器（M9）：让「改了 prompt / 工具变好还是变坏」可被证明。
 *
 * - 任务定义：evals/tasks/*.json（参与成员 / 提示词 / 回合上限 / 断言）；
 * - 隔离运行：每任务独立临时 DATA_DIR/WORKSPACE_DIR（绝不触碰真实 data / workspace），串行执行；
 * - mock 模式（默认）：MockProvider 零网络确定性输出，断言全部可判定 → 进 CI；
 * - --judge：用真实模型（JUDGE_MODEL ?? LLM_MODEL）按 rubric 打分（手动 / 夜间跑）；
 * - --real：任务执行也走真实模型（仅 real:true 探针任务；不参与 mock 基线；需 LLM_API_KEY）；
 * - 报告：evals/reports/<ts>.json + <ts>.md；与 evals/baseline.json 对比，回归则非零退出码；
 * - --update-baseline：以本次结果刷新基线（mock 模式）。
 *
 * 用法：
 *   npm run eval                      # mock 确定性断言（CI）
 *   npm run eval -- --tasks=full-relay-login
 *   npm run eval -- --judge           # 真实模型评分（需配置 LLM_API_KEY）
 *   npm run eval -- --real --judge --tasks=depth-report-spec --keep   # 真实模型报告规格探针
 *   npm run eval -- --update-baseline
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatMessage, MemoryKind, MemoryScope } from '@multi-agent/shared'
import { ApprovalService } from '../approval.js'
import { loadConfig, type AppConfig } from '../config.js'
import { Compressor } from '../context/compressor.js'
import { ContextService } from '../context/service.js'
import { EmbeddingManager } from '../embeddings/manager.js'
import { parseAssertions, runAssertions, type AssertionResult } from '../eval/assertions.js'
import { createProvider } from '../llm/factory.js'
import { MockProvider } from '../llm/mock.js'
import type { ChatRequest, LlmProvider } from '../llm/provider.js'
import { MemoryService } from '../memory/service.js'
import { Engine, type NotifyPort } from '../orchestration/engine.js'
import { ArtifactStore } from '../store/artifacts.js'
import { ArtifactVersionStore } from '../store/artifact-versions.js'
import { openDatabase } from '../store/db.js'
import { MemoryStore } from '../store/memory.js'
import { EmbeddingCacheStore, EmbedQueueStore, MemoryVectorStore } from '../store/memory-vectors.js'
import { ToolMetricsStore } from '../store/metrics.js'
import { ProjectStore } from '../store/projects.js'
import { PromptLibrary } from '../store/prompts.js'
import { RunEventStore } from '../store/run-events.js'
import { RunStore } from '../store/runs.js'
import { SessionStore } from '../store/sessions.js'
import { SkillLibrary } from '../store/skills.js'
import { SummaryStore } from '../store/summaries.js'
import { TaskStore } from '../store/tasks.js'
import { UsageStore } from '../store/usage.js'
import { createToolRegistry } from '../tools/builtin.js'
import { WorkspaceService } from '../workspace.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TASKS_DIR = path.join(ROOT, 'evals', 'tasks')
const REPORTS_DIR = path.join(ROOT, 'evals', 'reports')
const BASELINE_FILE = path.join(ROOT, 'evals', 'baseline.json')

interface EvalTaskFile {
  id: string
  name: string
  participants: string[]
  prompt: string
  maxTurns: number
  assertions: unknown[]
  /** 显式 serial:false 开启并行成波（缺省串行；M61 并行守卫任务用） */
  serial?: boolean
  /** M25：运行前播种的记忆（agent/session/global scope；owner 缺省按 scope 推导） */
  memorySeed?: Array<{
    scope: MemoryScope
    owner?: string
    kind: MemoryKind
    content: string
    importance?: number
  }>
  /** 工作区播种（发消息前写入会话工作区；如 BI 探针的数据集 CSV） */
  seedFiles?: Array<{ path: string; content: string }>
  /** 仅真实模型模式执行（报告规格探针：验证 prompt 遵循度；mock 全量自动跳过） */
  real?: boolean
}

interface TaskResult {
  id: string
  name: string
  ok: boolean
  durationMs: number
  endReason: string
  stats: { turns: number; promptTokens: number; completionTokens: number; costUsd: number }
  assertions: AssertionResult[]
}

interface BaselineFile {
  ts: string
  mode: 'mock' | 'judge'
  tasks: Record<string, { ok: boolean }>
}

// ---------- 隔离环境 ----------

interface TaskEnv {
  cfg: AppConfig
  sessions: SessionStore
  artifacts: ArtifactStore
  context: ContextService
  engine: Engine
  events: RunEventStore
  usage: UsageStore
  /** M25：记忆存取与向量服务（memorySeed 播种 + 召回注入） */
  memory: MemoryStore
  memories: MemoryService
  close: () => void
}

async function buildTaskEnv(rootDir: string, maxTurns: number, provider: LlmProvider): Promise<TaskEnv> {
  const base = loadConfig()
  const cfg: AppConfig = {
    ...base,
    dataDir: path.join(rootDir, 'data'),
    workspaceDir: path.join(rootDir, 'workspace'),
    worktreeDir: path.join(rootDir, 'worktrees'),
    dbFile: path.join(rootDir, 'data', 'app.db'),
    logLevel: 'silent',
    llmThinking: false,
    maxTurnsPerRun: maxTurns,
    approvalMode: 'off',
    // M25：确定性 mock 嵌入（零网络；召回注入进断言基线）
    llmMock: true,
    memoryRecallEnabled: true,
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(cfg.workspaceDir, { recursive: true })

  const prompts = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir })
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(cfg.dbFile)
  const sessions = new SessionStore(db)
  const projects = new ProjectStore(db, cfg.allowedRoots)
  const workspace = new WorkspaceService({ cfg, sessions, projects })
  const artifacts = new ArtifactStore(cfg.workspaceDir, (sid) => workspace.resolveDir(sid))
  const versions = new ArtifactVersionStore(db)
  const embedQueue = new EmbedQueueStore(db)
  const memory = new MemoryStore(db, embedQueue)
  const summaries = new SummaryStore(db)
  const tasks = new TaskStore(db)
  const runs = new RunStore(db)
  const usage = new UsageStore(db, cfg.llmPricing)
  const metrics = new ToolMetricsStore(db)
  const events = new RunEventStore(db)
  const tools = createToolRegistry(cfg)
  const notify: NotifyPort = { publish: (input) => input }
  const compressor = new Compressor({ cfg, provider, sessions, summaries, memory, usage })
  const embeddings = new EmbeddingManager({ cfg, cache: new EmbeddingCacheStore(db) })
  const memories = new MemoryService({
    cfg,
    db,
    store: memory,
    vectors: new MemoryVectorStore(db),
    queue: embedQueue,
    embeddings,
  })
  await memories.start()
  const context = new ContextService({
    cfg,
    prompts,
    skills,
    sessions,
    artifacts,
    memory,
    memories,
    summaries,
    compressor,
  })
  const approvals = new ApprovalService({ timeoutMs: cfg.approvalTimeoutMs })
  const engine = new Engine({
    cfg,
    prompts,
    skills,
    sessions,
    artifacts,
    memory,
    memories,
    context,
    provider,
    tools,
    notify,
    tasks,
    runs,
    usage,
    metrics,
    approvals,
    versions,
    events,
  })
  return {
    cfg,
    sessions,
    artifacts,
    context,
    engine,
    events,
    usage,
    memory,
    memories,
    close: () => {
      memories.stop()
      sessions.close()
      db.close()
    },
  }
}

/** 等待 Run 结束（与 tests/helpers.waitRunFinished 同构） */
async function waitRunFinished(engine: Engine, runId: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  while (engine.hasRun(runId)) {
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} 超时未结束（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ---------- judge ----------

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '0-10 分' },
    reasons: { type: 'string', description: '简要点评（≤120 字）' },
  },
  required: ['score'],
}

function makeJudge(provider: LlmProvider, model: string) {
  return async (rubric: string, transcript: string): Promise<{ score: number; reasons?: string }> => {
    const req: ChatRequest = {
      system:
        '你是严格的多 Agent 协作产出评审员。按评分标准给出 0-10 分。只输出 JSON 对象：{"score": number, "reasons": string}。',
      messages: [{ role: 'user', content: `评分标准：${rubric}\n\n团队产出：\n${transcript}` }],
      model,
      responseFormat: { type: 'json_schema', name: 'judge_result', schema: JUDGE_SCHEMA },
      meta: { agentId: 'judge', participantIds: [] },
    }
    const controller = new AbortController()
    let text = ''
    for await (const chunk of provider.chatStream(req, controller.signal)) {
      if (chunk.type === 'text') text += chunk.text
    }
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? (JSON.parse(match[0]) as { score?: unknown; reasons?: unknown }) : {}
    const score = Number(parsed.score)
    if (!Number.isFinite(score)) throw new Error(`judge 输出无法解析：${text.slice(0, 200)}`)
    return { score, reasons: typeof parsed.reasons === 'string' ? parsed.reasons : undefined }
  }
}

// ---------- 单任务执行 ----------

async function runTask(
  task: EvalTaskFile,
  opts: { judgeProvider?: LlmProvider; judgeModel: string; realProvider?: LlmProvider; keep?: boolean },
): Promise<TaskResult> {
  const started = Date.now()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ma-eval-${task.id}-`))
  const real = Boolean(opts.realProvider)
  const provider = opts.realProvider ?? new MockProvider({ delayMs: 0 })
  let env: TaskEnv | undefined
  try {
    env = await buildTaskEnv(tmp, task.maxTurns, provider)
    const session = env.sessions.create(
      task.participants,
      task.name,
      task.serial === false ? { serial: false } : undefined,
    )
    // M25：播种记忆（agent/session/global；owner 缺省按 scope 推导）→ poke 等到嵌入完成后开始 Run
    const seeds = task.memorySeed ?? []
    if (seeds.length > 0) {
      for (const seed of seeds) {
        const owner =
          seed.owner ??
          (seed.scope === 'session' ? session.id : seed.scope === 'global' ? 'global' : task.participants[0]!)
        env.memory.upsertScoped(seed.scope, owner, seed.kind, seed.content, {
          source: 'eval:seed',
          importance: seed.importance,
        })
      }
      await env.memories.poke()
    }
    // 工作区播种（报告探针的数据集等；发消息前写入会话沙箱）
    if (task.seedFiles && task.seedFiles.length > 0) {
      const dir = env.artifacts.ensureSessionDir(session.id)
      for (const seed of task.seedFiles) {
        const full = path.join(dir, seed.path)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, seed.content, 'utf8')
      }
    }
    const message = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: task.prompt,
      mentions: [],
      status: 'complete',
    })
    const { runId } = env.engine.launch(session.id, message.id)
    // 真实模型模式放宽总超时（深度报告全链 5–10 分钟量级）
    await waitRunFinished(env.engine, runId, real ? 1_800_000 : 120_000)
    env.sessions.saveNow(session.id)

    const events = env.events.listByRun(runId)
    const messages: ChatMessage[] = env.sessions.messages(session.id)
    if (process.env.DEBUG_DUMP === '1') {
      for (const m of messages) {
        if (m.role === 'agent')
          console.log(
            `[dump][${m.agentId}] mentions=${JSON.stringify(m.mentions)} :: ${m.content.slice(-140).replace(/\n/g, '⏎')}`,
          )
      }
      const tc = events.filter((e) => e.type === 'handoff:accepted' || e.type === 'schedule')
      for (const e of tc) console.log(`[dump][trace] ${e.type} ${JSON.stringify(e.payload).slice(0, 200)}`)
      for (const e of events.filter((ev) => ev.type === 'tool')) {
        console.log(
          `[dump][tool] ${String(e.payload.name)} ok=${String(e.payload.ok)} :: ${String(e.payload.summary ?? '').slice(0, 140)}`,
        )
      }
    }
    const snapshot = env.context.snapshot(session.id)
    const usage = env.usage.sumByRun(runId)
    const results = await runAssertions(parseAssertions(task.assertions), {
      rootDir: env.artifacts.ensureSessionDir(session.id),
      events,
      messages,
      context: { estimatedTokens: snapshot.estimatedTokens, budgetTokens: snapshot.budgetTokens },
      judge: opts.judgeProvider ? makeJudge(opts.judgeProvider, opts.judgeModel) : undefined,
    })
    const endEvent = [...events].reverse().find((e) => e.type === 'run:end')
    const turns = events.filter((e) => e.type === 'turn:end').length
    return {
      id: task.id,
      name: task.name,
      ok: results.every((r) => r.ok || r.skipped),
      durationMs: Date.now() - started,
      endReason: String(endEvent?.payload.reason ?? ''),
      stats: {
        turns,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: usage.costUsd,
      },
      assertions: results,
    }
  } finally {
    env?.close()
    if (opts.keep) console.log(`[keep] 工作区保留：${tmp}`)
    else fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------- 报告与基线 ----------

function renderMarkdown(report: {
  ts: string
  mode: string
  total: number
  passed: number
  failed: number
  tasks: TaskResult[]
  regressions: string[]
}): string {
  const lines: string[] = [
    `# 评测报告（${report.ts}）`,
    '',
    `模式：**${report.mode}** · 任务 ${report.total} · 通过 ${report.passed} · 失败 ${report.failed}`,
    '',
  ]
  for (const task of report.tasks) {
    lines.push(`## ${task.ok ? '✅' : '❌'} ${task.name}（${task.id}）`, '')
    lines.push(
      `- 结束原因：${task.endReason || '—'} · 回合 ${task.stats.turns} · token ${task.stats.promptTokens}+${task.stats.completionTokens} · 费用 $${task.stats.costUsd.toFixed(4)} · 耗时 ${task.durationMs}ms`,
    )
    for (const a of task.assertions) {
      const mark = a.skipped ? '⏭️' : a.ok ? '✅' : '❌'
      lines.push(`- ${mark} [${a.type}] ${a.detail}`)
    }
    lines.push('')
  }
  if (report.regressions.length > 0) {
    lines.push('## 基线回归', '')
    for (const r of report.regressions) lines.push(`- ${r}`)
    lines.push('')
  }
  return lines.join('\n')
}

function loadBaseline(): BaselineFile | undefined {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as BaselineFile
  } catch {
    return undefined
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const judgeEnabled = args.includes('--judge')
  const realEnabled = args.includes('--real')
  const keepWorkspace = args.includes('--keep')
  const updateBaseline = args.includes('--update-baseline')
  const taskFilter = args
    .find((a) => a.startsWith('--tasks='))
    ?.slice('--tasks='.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // 任务装载（fail-fast：结构错误直接抛）
  const files = fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const allTasks = files.map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as EvalTaskFile)
  // 任务选择：显式 --tasks 优先；否则按模式过滤（mock 跳过 real 探针；real 只跑 real 探针）
  const tasks = allTasks.filter((t) =>
    taskFilter ? taskFilter.includes(t.id) : realEnabled ? t.real === true : t.real !== true,
  )
  if (!realEnabled) {
    const skipped = allTasks.filter((t) => t.real === true).length
    if (skipped > 0) console.log(`（${skipped} 个真实模式探针任务已跳过：用 --real 运行）`)
  }
  if (tasks.length === 0) {
    console.error(taskFilter ? `未找到匹配任务：${taskFilter.join('、')}` : `evals/tasks 下没有任务文件`)
    process.exit(1)
  }

  // judge / real 通道（真实模型；未配置直接失败，避免静默跳过）
  const cfg = loadConfig()
  if ((judgeEnabled || realEnabled) && !cfg.llmApiKey) {
    console.error(`${realEnabled ? '--real' : '--judge'} 需要配置 LLM_API_KEY`)
    process.exit(1)
  }
  let judgeProvider: LlmProvider | undefined
  if (judgeEnabled) judgeProvider = createProvider(cfg)
  // --real：任务执行也走真实模型（默认仅 real:true 探针任务；不参与 mock 基线）
  const realProvider = realEnabled ? createProvider(cfg) : undefined
  const judgeModel = cfg.judgeModel || cfg.llmModel

  const modeLabel = realEnabled ? 'real（真实模型执行）' : judgeEnabled ? 'judge（真实模型评分）' : 'mock（确定性）'
  console.log(`评测开始：${tasks.length} 个任务 · 模式 ${modeLabel}`)
  const results: TaskResult[] = []
  for (const task of tasks) {
    const result = await runTask(task, { judgeProvider, judgeModel, realProvider, keep: keepWorkspace })
    results.push(result)
    const failed = result.assertions.filter((a) => !a.ok && !a.skipped)
    console.log(
      `${result.ok ? '✅' : '❌'} ${task.id}（${result.stats.turns} 回合 / ${result.durationMs}ms）${
        failed.length > 0 ? `\n   ${failed.map((a) => `✗ ${a.type}: ${a.detail}`).join('\n   ')}` : ''
      }`,
    )
  }

  // 报告
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const passed = results.filter((r) => r.ok).length
  const reportBase = {
    ts,
    mode: (realEnabled ? 'real' : judgeEnabled ? 'judge' : 'mock') as 'mock' | 'judge' | 'real',
    total: results.length,
    passed,
    failed: results.length - passed,
    skippedAssertions: results.reduce((n, r) => n + r.assertions.filter((a) => a.skipped).length, 0),
    tasks: results,
  }

  // 基线对比 / 更新（真实模式不参与：mock 基线保持纯净）
  const regressions: string[] = []
  const baseline = loadBaseline()
  if (realEnabled) {
    // --real：跳过基线读写
  } else if (updateBaseline || !baseline) {
    const next: BaselineFile = {
      ts,
      mode: judgeEnabled ? 'judge' : 'mock',
      tasks: Object.fromEntries(results.map((r) => [r.id, { ok: r.ok }])),
    }
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`基线已${baseline ? '更新' : '建立'}：evals/baseline.json`)
  } else {
    for (const task of results) {
      const base = baseline.tasks[task.id]
      if (base?.ok && !task.ok) regressions.push(`${task.id}：基线通过 → 当前失败`)
    }
  }

  const report = { ...reportBase, regressions }
  fs.writeFileSync(path.join(REPORTS_DIR, `${ts}.json`), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(REPORTS_DIR, `${ts}.md`), renderMarkdown(report))
  console.log(`报告：evals/reports/${ts}.json / .md`)
  console.log(
    `汇总：${passed}/${results.length} 通过${regressions.length > 0 ? ` · 回归 ${regressions.length} 项` : ''}`,
  )
  for (const r of regressions) console.error(`回归：${r}`)

  process.exit(reportBase.failed > 0 || regressions.length > 0 ? 1 : 0)
}

void main()
