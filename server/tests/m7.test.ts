/**
 * M7 测试：审批链路（risky / all / off、批准 / 拒绝回灌 / 超时 / 停止取消）、
 * request_approval 工具、鉴权 / CORS / Origin 校验 / 限流中间件、config 前置校验与 zod schema。
 *
 * 验收对照（计划 M7）：git_commit / 覆盖写触发审批；拒绝后模型收到反馈并改方案；
 * 超时自动拒绝；BIND_ALL=true 时未带 token 的请求 401。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import { WebSocket as WsClient } from 'ws'
import { describe, expect, it } from 'vitest'
import { ApprovalService } from '../src/approval.js'
import { AuthService } from '../src/auth/service.js'
import { loadConfig, type AppConfig } from '../src/config.js'
import { textOfContent } from '../src/llm/content.js'
import { abortError, type ChatRequest, type LlmChunk } from '../src/llm/provider.js'
import {
  createAuthMiddleware,
  createCorsOptions,
  createMessageLimiter,
  createOriginGuard,
  createTokenEntryMiddleware,
} from '../src/middleware.js'
import { approvalDecisionSchema, sendMessageSchema } from '../src/routes/schemas.js'
import { ApiKeyStore, AuthSessionStore } from '../src/store/auth-sessions.js'
import { openDatabase } from '../src/store/db.js'
import { UserStore } from '../src/store/users.js'
import { NotifyHub } from '../src/ws.js'
import { makeEnv, makeTmpDir, routePassThrough, waitRunFinished } from './helpers.js'

/** M57：测试用认证服务（内存库；无账号 → 单用户兼容模式） */
function makeAuthService(cfg: AppConfig): AuthService {
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  return new AuthService({
    cfg,
    users: new UserStore(db),
    authSessions: new AuthSessionStore(db),
    apiKeys: new ApiKeyStore(db),
  })
}

type Env = ReturnType<typeof makeEnv>

/** 覆写 provider 剧本：round 从 0 递增（每回合一次 chatStream 调用）；aborted 时抛 abortError */
function scriptProvider(env: Env, script: (req: ChatRequest, round: number) => LlmChunk[]): void {
  let round = 0
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req, signal) {
    // M48：平台路由请求直通（不占 round）
    const route = routePassThrough(req)
    if (route) {
      for (const chunk of route) yield chunk
      return
    }
    const chunks = script(req, round++)
    for (const chunk of chunks) {
      if (signal.aborted) throw abortError()
      yield chunk
    }
  }
}

function toolCall(name: string, args: Record<string, unknown>, id = 'c1'): LlmChunk {
  return { type: 'tool_calls', calls: [{ id, name, arguments: JSON.stringify(args) }] }
}

const done: LlmChunk = { type: 'done' }
const handoffUser: LlmChunk = { type: 'text', text: '完成。\n@用户' }

/** 轮询等待 Run 出现挂起审批 */
async function waitApproval(env: Env, runId: string, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    const pending = env.approvals.pendingOf(runId)
    if (pending.length > 0) return pending[0]
    if (Date.now() - start > timeoutMs) throw new Error('审批未在预期时间内出现')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function newSession(env: Env): { sessionId: string; root: string } {
  const session = env.sessions.create(['backend'], 'M7 会话')
  return { sessionId: session.id, root: env.artifacts.ensureSessionDir(session.id) }
}

function sendMessage(env: Env, sessionId: string, content: string): string {
  const message = env.sessions.appendMessage({
    sessionId,
    role: 'user',
    content,
    mentions: [],
    status: 'complete',
  })
  const { runId } = env.engine.launch(sessionId, message.id)
  return runId
}

// ---------- ApprovalService ----------

describe('M7：ApprovalService', () => {
  it('decide：批准后 resolve；重复决定 / 未知审批返回 null', async () => {
    const svc = new ApprovalService({ timeoutMs: 5000 })
    const approval = svc.create({ runId: 'r1', sessionId: 's1', action: '安装依赖', detail: 'npm i lodash' })
    expect(approval.status).toBe('pending')
    const waiting = svc.wait(approval.id)
    const decided = svc.decide('r1', approval.id, 'approve', '可以')
    expect(decided?.status).toBe('approved')
    const outcome = await waiting
    expect(outcome.decision).toBe('approve')
    expect(outcome.timedOut).toBe(false)
    expect(svc.decide('r1', approval.id, 'reject')).toBeNull()
    expect(svc.decide('r1', 'not-exist', 'reject')).toBeNull()
    expect(svc.get(approval.id)?.status).toBe('approved')
  })

  it('超时：自动判定 timeout 并附可修正反馈', async () => {
    const svc = new ApprovalService({ timeoutMs: 60 })
    const approval = svc.create({ runId: 'r1', sessionId: 's1', action: 'a', detail: 'd' })
    const outcome = await svc.wait(approval.id)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.decision).toBe('timeout')
    expect(outcome.approval.status).toBe('timeout')
    expect(outcome.feedback).toContain('未响应')
  })

  it('运行停止：signal abort → cancelled 收敛（rejected + 取消标注）', async () => {
    const svc = new ApprovalService({ timeoutMs: 60_000 })
    const approval = svc.create({ runId: 'r1', sessionId: 's1', action: 'a', detail: 'd' })
    const ctrl = new AbortController()
    const waiting = svc.wait(approval.id, ctrl.signal)
    ctrl.abort()
    const outcome = await waiting
    expect(outcome.cancelled).toBe(true)
    expect(outcome.approval.status).toBe('rejected')
  })

  it('留痕落库：请求 / 批准 / 超时全生命周期写入 approvals 表（审核 M-4）', async () => {
    const env = makeEnv()
    const svc = new ApprovalService({ timeoutMs: 5000, db: env.db })
    const a1 = svc.create({
      runId: 'r1',
      sessionId: 's1',
      agentId: 'backend',
      action: '安装依赖',
      detail: 'npm i lodash',
    })
    // 请求即落库（pending / 未决时间空）
    const pendingRow = env.db.get<{ status: string; decision: string | null; decided_at: string | null }>(
      'SELECT status, decision, decided_at FROM approvals WHERE id = ?',
      a1.id,
    )
    expect(pendingRow?.status).toBe('pending')
    expect(pendingRow?.decision).toBeNull()
    expect(pendingRow?.decided_at).toBeNull()

    svc.decide('r1', a1.id, 'approve', '可以')
    const approvedRow = env.db.get<{
      status: string
      decision: string
      feedback: string
      decided_at: string | null
    }>('SELECT status, decision, feedback, decided_at FROM approvals WHERE id = ?', a1.id)
    expect(approvedRow?.status).toBe('approved')
    expect(approvedRow?.decision).toBe('approve')
    expect(approvedRow?.feedback).toBe('可以')
    expect(approvedRow?.decided_at).toBeTruthy()

    // 超时拒绝 → 同样留痕
    const svc2 = new ApprovalService({ timeoutMs: 30, db: env.db })
    const a2 = svc2.create({ runId: 'r2', sessionId: 's1', action: 'a', detail: 'd' })
    await svc2.wait(a2.id)
    const timeoutRow = env.db.get<{ status: string; decision: string | null }>(
      'SELECT status, decision FROM approvals WHERE id = ?',
      a2.id,
    )
    expect(timeoutRow?.status).toBe('timeout')
    expect(timeoutRow?.decision).toBeNull()
  })
})

// ---------- 引擎审批门（risky 默认） ----------

describe('M7：引擎审批门', () => {
  it('risky：覆盖写已有文件 → 挂起（落盘 awaiting_approval + 通知）→ 批准后执行', async () => {
    const env = makeEnv()
    const { sessionId, root } = newSession(env)
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const v = 1\n')
    scriptProvider(env, (_req, round) =>
      round === 0
        ? [toolCall('write_file', { path: 'app.ts', content: 'export const v = 2\n' }), done]
        : [handoffUser, done],
    )

    const runId = sendMessage(env, sessionId, '把 app.ts 的 v 改成 2')
    const pending = await waitApproval(env, runId)

    expect(pending.action).toContain('覆盖已有文件')
    expect(pending.detail).toContain('app.ts')
    expect(env.runs.get(runId)?.state).toBe('awaiting_approval')
    expect(env.published.some((n) => n.type === 'notify:approval-requested')).toBe(true)
    // 挂起期间工具未执行
    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('v = 1')

    env.approvals.decide(runId, pending.id, 'approve')
    await waitRunFinished(env.engine, runId)

    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('v = 2')
    expect(env.published.some((n) => n.type === 'notify:approval-resolved')).toBe(true)
    expect(env.runs.get(runId)?.state).not.toBe('awaiting_approval')
  })

  it('拒绝：模型收到反馈并改方案（验收：拒绝后换 edit_file 完成）', async () => {
    const env = makeEnv()
    const { sessionId, root } = newSession(env)
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const v = 1\n')
    const seenToolMessages: string[] = []
    scriptProvider(env, (req, round) => {
      if (round === 0) {
        return [toolCall('write_file', { path: 'app.ts', content: 'export const v = 2\n' }), done]
      }
      if (round === 1) {
        const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
        seenToolMessages.push(textOfContent(lastTool?.content ?? ''))
        return [toolCall('edit_file', { path: 'app.ts', old_text: 'v = 1', new_text: 'v = 3' }, 'c2'), done]
      }
      return [handoffUser, done]
    })

    const runId = sendMessage(env, sessionId, '把 app.ts 的 v 改成 2')
    const pending = await waitApproval(env, runId)
    env.approvals.decide(runId, pending.id, 'reject', '不要整体覆盖，请用 edit_file 做小改')
    await waitRunFinished(env.engine, runId)

    expect(seenToolMessages[0]).toContain('用户拒绝')
    expect(seenToolMessages[0]).toContain('edit_file')
    // 模型换方案后真实执行成功
    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('v = 3')
  })

  it('超时：未响应视为拒绝，操作不执行（工具消息含超时反馈）', async () => {
    const env = makeEnv({ approvalTimeoutMs: 200 })
    const { sessionId, root } = newSession(env)
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const v = 1\n')
    const seenToolMessages: string[] = []
    scriptProvider(env, (req, round) => {
      if (round === 0) {
        return [toolCall('write_file', { path: 'app.ts', content: 'export const v = 2\n' }), done]
      }
      const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
      seenToolMessages.push(textOfContent(lastTool?.content ?? ''))
      return [handoffUser, done]
    })

    const runId = sendMessage(env, sessionId, '覆盖 app.ts')
    await waitRunFinished(env.engine, runId)

    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('v = 1')
    expect(seenToolMessages[0]).toContain('未在时限内响应')
    expect(env.approvals.forRun(runId)[0]?.status).toBe('timeout')
  })

  it('停止运行：挂起审批被取消，操作不执行', async () => {
    const env = makeEnv({ approvalTimeoutMs: 60_000 })
    const { sessionId, root } = newSession(env)
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const v = 1\n')
    scriptProvider(env, (_req, round) =>
      round === 0
        ? [toolCall('write_file', { path: 'app.ts', content: 'export const v = 2\n' }), done]
        : [handoffUser, done],
    )

    const runId = sendMessage(env, sessionId, '覆盖 app.ts')
    const pending = await waitApproval(env, runId)
    env.engine.stop(runId)
    await waitRunFinished(env.engine, runId)

    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('v = 1')
    expect(env.approvals.get(pending.id)?.status).toBe('rejected')
    expect(env.approvals.get(pending.id)?.feedback).toContain('停止')
  })

  it('停止运行：同批未执行的工具调用收口（不留 running 悬挂）', async () => {
    const env = makeEnv({ approvalTimeoutMs: 60_000 })
    const { sessionId, root } = newSession(env)
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const v = 1\n')
    scriptProvider(env, (_req, round) =>
      round === 0
        ? [
            toolCall('write_file', { path: 'app.ts', content: 'export const v = 2\n' }, 'c1'),
            toolCall('remember', { kind: 'fact', content: 'v 已改' }, 'c2'),
            done,
          ]
        : [handoffUser, done],
    )

    const runId = sendMessage(env, sessionId, '覆盖 app.ts')
    const pending = await waitApproval(env, runId)
    env.engine.stop(runId)
    await waitRunFinished(env.engine, runId)

    // 审批取消：操作不执行
    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('v = 1')
    expect(env.approvals.get(pending.id)?.status).toBe('rejected')
    // 两条工具条目均已结算：write_file = 审批取消；remember = 未执行（不遗留 running 卡片悬挂）
    // M47：运行停止导致的取消归入「已停止」语义（非工具失败，前端琥珀色）
    const agentMessage = env.sessions
      .get(sessionId)!
      .messages.find((m) => m.role === 'agent' && (m.toolCalls?.length ?? 0) >= 2)
    const calls = agentMessage?.toolCalls ?? []
    expect(calls.map((c) => c.status)).toEqual(['stopped', 'stopped'])
    expect(calls[0].summary).toContain('审批取消')
    expect(calls[1].summary).toContain('未执行')
    expect(calls.every((c) => Boolean(c.endedAt))).toBe(true)
  })

  it('APPROVAL_MODE=off：不拦截，直接执行', async () => {
    const env = makeEnv({ approvalMode: 'off' })
    const { sessionId, root } = newSession(env)
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const v = 1\n')
    scriptProvider(env, (_req, round) =>
      round === 0
        ? [toolCall('write_file', { path: 'app.ts', content: 'export const v = 2\n' }), done]
        : [handoffUser, done],
    )

    const runId = sendMessage(env, sessionId, '覆盖 app.ts')
    await waitRunFinished(env.engine, runId)

    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('v = 2')
    expect(env.published.some((n) => n.type === 'notify:approval-requested')).toBe(false)
  })

  it('APPROVAL_MODE=all：新建文件（非覆盖）也需审批', async () => {
    const env = makeEnv({ approvalMode: 'all' })
    const { sessionId, root } = newSession(env)
    scriptProvider(env, (_req, round) =>
      round === 0
        ? [toolCall('write_file', { path: 'docs/new.md', content: '# 新文档\n' }), done]
        : [handoffUser, done],
    )

    const runId = sendMessage(env, sessionId, '写一份新文档')
    const pending = await waitApproval(env, runId)
    expect(pending.action).toContain('write_file')
    env.approvals.decide(runId, pending.id, 'approve')
    await waitRunFinished(env.engine, runId)

    expect(fs.existsSync(path.join(root, 'docs', 'new.md'))).toBe(true)
  })

  it('敏感文件：ALLOW_SENSITIVE 开启时访问需逐次审批', async () => {
    const env = makeEnv({ allowSensitive: true })
    const { sessionId, root } = newSession(env)
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n')
    scriptProvider(env, (_req, round) =>
      round === 0
        ? [toolCall('write_file', { path: '.env', content: 'SECRET=2\n' }), done]
        : [handoffUser, done],
    )

    const runId = sendMessage(env, sessionId, '更新 .env')
    const pending = await waitApproval(env, runId)
    expect(pending.action).toContain('敏感文件')
    env.approvals.decide(runId, pending.id, 'reject', '凭据文件不要动')
    await waitRunFinished(env.engine, runId)

    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('SECRET=1\n')
  })
})

// ---------- request_approval 工具 ----------
describe('M7：request_approval 工具', () => {
  it('custom 决策：修改意见回灌模型', async () => {
    const env = makeEnv()
    const { sessionId } = newSession(env)
    const seenToolMessages: string[] = []
    scriptProvider(env, (req, round) => {
      if (round === 0) {
        return [
          toolCall('request_approval', { action: '安装 lodash 依赖', detail: 'npm install lodash' }),
          done,
        ]
      }
      const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
      seenToolMessages.push(textOfContent(lastTool?.content ?? ''))
      return [handoffUser, done]
    })

    const runId = sendMessage(env, sessionId, '需要用到 lodash，帮我安装')
    const pending = await waitApproval(env, runId)
    expect(pending.action).toContain('lodash')
    env.approvals.decide(runId, pending.id, 'custom', '不要装新依赖，先用原生实现')
    await waitRunFinished(env.engine, runId)

    expect(seenToolMessages[0]).toContain('原生实现')
  })

  it('批准：工具结果标记通过并继续', async () => {
    const env = makeEnv()
    const { sessionId } = newSession(env)
    const seenToolMessages: string[] = []
    scriptProvider(env, (req, round) => {
      if (round === 0) {
        return [toolCall('request_approval', { action: '删除过期缓存', detail: 'rm -rf cache' }), done]
      }
      const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
      seenToolMessages.push(textOfContent(lastTool?.content ?? ''))
      return [handoffUser, done]
    })

    const runId = sendMessage(env, sessionId, '清理缓存')
    const pending = await waitApproval(env, runId)
    env.approvals.decide(runId, pending.id, 'approve')
    await waitRunFinished(env.engine, runId)

    expect(seenToolMessages[0]).toContain('已批准')
  })
})

// ---------- git_commit 强制审批（验收） ----------

function initRepo(): string {
  const dir = makeTmpDir('ma-m7-repo-')
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'M7 Test',
    GIT_AUTHOR_EMAIL: 'm7@test.local',
    GIT_COMMITTER_NAME: 'M7 Test',
    GIT_COMMITTER_EMAIL: 'm7@test.local',
  }
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, env: gitEnv })
  fs.writeFileSync(path.join(dir, 'README.md'), '# M7 仓库\n')
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, env: gitEnv })
  return dir
}

describe('M7：git_commit 强制审批（验收）', () => {
  it('risky：git_commit 触发审批；批准后提交落在 agent 分支，主分支不受影响', async () => {
    const repoDir = initRepo()
    const env = makeEnv({ allowedRoots: [repoDir] })
    const project = env.projects.create({ name: 'M7 仓库', rootPath: repoDir, workspaceMode: 'worktree' })
    const session = env.sessions.create(['backend'], 'M7 git 会话', { projectId: project.id })
    await env.workspace.prepare(session)
    const root = session.workspaceDir!
    // 直接落一个待提交文件（不经工具，不触发覆盖写审批）
    fs.writeFileSync(path.join(root, 'note.md'), '# 记录\n')
    scriptProvider(env, (_req, round) =>
      round === 0 ? [toolCall('git_commit', { message: 'docs: 增加记录' }), done] : [handoffUser, done],
    )

    const runId = sendMessage(env, session.id, '提交当前改动')
    const pending = await waitApproval(env, runId)
    expect(pending.action).toContain('提交 git 变更')
    // 挂起期间尚未产生提交
    const before = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim()
    expect(before).toBe('init')

    env.approvals.decide(runId, pending.id, 'approve')
    await waitRunFinished(env.engine, runId)

    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim()
    expect(subject).toBe('docs: 增加记录')
    // 主分支不受影响（提交只落在 agent/<sid> 分支）
    const mainSubject = execFileSync('git', ['log', '-1', '--format=%s', 'main'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim()
    expect(mainSubject).toBe('init')
  })
})

// ---------- git_restore 强制审批（验收） ----------

describe('M7：git_restore 强制审批（验收）', () => {
  it('risky：git_restore 触发审批；批准后未提交改动被还原', async () => {
    const repoDir = initRepo()
    const env = makeEnv({ allowedRoots: [repoDir] })
    const project = env.projects.create({ name: 'M7 仓库', rootPath: repoDir, workspaceMode: 'worktree' })
    const session = env.sessions.create(['backend'], 'M7 restore 会话', { projectId: project.id })
    await env.workspace.prepare(session)
    const root = session.workspaceDir!
    // 弄脏一个 tracked 文件（git_restore 只对已跟踪文件生效）
    fs.writeFileSync(path.join(root, 'README.md'), '# M7 仓库（未提交改动）\n')
    scriptProvider(env, (_req, round) =>
      round === 0 ? [toolCall('git_restore', { path: 'README.md' }), done] : [handoffUser, done],
    )

    const runId = sendMessage(env, session.id, '丢弃 README 的未提交改动')
    const pending = await waitApproval(env, runId)
    expect(pending.action).toContain('还原文件')
    // 挂起期间改动仍在（未执行）
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('未提交改动')

    env.approvals.decide(runId, pending.id, 'approve')
    await waitRunFinished(env.engine, runId)

    // 批准后已还原到最近提交状态
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# M7 仓库\n')
  })

  it('拒绝：还原不执行（未提交改动保留）', async () => {
    const repoDir = initRepo()
    const env = makeEnv({ allowedRoots: [repoDir] })
    const project = env.projects.create({ name: 'M7 仓库', rootPath: repoDir, workspaceMode: 'worktree' })
    const session = env.sessions.create(['backend'], 'M7 restore 拒绝', { projectId: project.id })
    await env.workspace.prepare(session)
    const root = session.workspaceDir!
    fs.writeFileSync(path.join(root, 'README.md'), '# M7 仓库（保留我）\n')
    scriptProvider(env, (_req, round) =>
      round === 0 ? [toolCall('git_restore', { path: 'README.md' }), done] : [handoffUser, done],
    )

    const runId = sendMessage(env, session.id, '丢弃 README 的未提交改动')
    const pending = await waitApproval(env, runId)
    env.approvals.decide(runId, pending.id, 'reject', '改动还要用，不要还原')
    await waitRunFinished(env.engine, runId)
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('保留我')
  })
})

// ---------- 安全中间件与配置 ----------

function mockRes(): {
  statusCode: number
  body: unknown
  status(code: number): unknown
  json(b: unknown): void
} {
  return {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
    },
  }
}

describe('M7：安全中间件', () => {
  it('鉴权：无 / 错 token → 401；Bearer 与 cookie 正确 → 放行；未配置 token → 放行', () => {
    const cfg: AppConfig = { ...loadConfig(), authToken: 's3cret' }
    const auth = createAuthMiddleware(cfg, makeAuthService(cfg))
    const run = (headers: Record<string, string>): { statusCode: number; next: boolean } => {
      const res = mockRes()
      let next = false
      auth({ headers } as unknown as Request, res as unknown as Response, () => {
        next = true
      })
      return { statusCode: res.statusCode, next }
    }
    expect(run({}).statusCode).toBe(401)
    expect(run({ authorization: 'Bearer wrong-token' }).statusCode).toBe(401)
    expect(run({ authorization: 'Bearer s3cret' }).next).toBe(true)
    expect(run({ cookie: 'auth_token=s3cret' }).next).toBe(true)
    expect(run({ cookie: 'other=1; auth_token=s3cret' }).next).toBe(true)

    const openCfg: AppConfig = { ...loadConfig(), authToken: '' }
    const open = createAuthMiddleware(openCfg, makeAuthService(openCfg))
    const res = mockRes()
    let next = false
    open({ headers: {} } as unknown as Request, res as unknown as Response, () => {
      next = true
    })
    expect(next).toBe(true)
  })

  it('CORS：白名单优先；未配置时仅本机来源与无 Origin', async () => {
    const decide = (opts: ReturnType<typeof createCorsOptions>, origin: string | undefined) =>
      new Promise<boolean>((resolve) => {
        const handler = opts.origin as unknown as (
          origin: string | undefined,
          cb: (err: Error | null, allow?: boolean) => void,
        ) => void
        handler(origin, (err, allow) => resolve(!err && Boolean(allow)))
      })
    const listed = createCorsOptions({ ...loadConfig(), allowedOrigins: ['http://example.com'] })
    expect(await decide(listed, 'http://example.com')).toBe(true)
    expect(await decide(listed, 'http://evil.com')).toBe(false)
    const local = createCorsOptions({ ...loadConfig(), allowedOrigins: [] })
    expect(await decide(local, 'http://localhost:5173')).toBe(true)
    expect(await decide(local, 'http://127.0.0.1:8787')).toBe(true)
    expect(await decide(local, 'http://evil.com')).toBe(false)
    expect(await decide(local, undefined)).toBe(true)
  })

  it('Origin 校验：同源 / 本机来源 / 白名单放行；跨站写请求 → 403', () => {
    const run = (cfg: AppConfig, method: string, headers: Record<string, string>) => {
      const guard = createOriginGuard(cfg)
      const res = mockRes()
      let next = false
      guard({ method, headers } as unknown as Request, res as unknown as Response, () => {
        next = true
      })
      return { res, next }
    }

    const open: AppConfig = { ...loadConfig(), allowedOrigins: [] }
    // 无 Origin 的 CLI / 测试请求与 GET 读请求放行
    expect(run(open, 'POST', { host: 'localhost:8787' }).next).toBe(true)
    expect(run(open, 'GET', { origin: 'http://evil.com', host: 'localhost:8787' }).next).toBe(true)
    // 同源（生产单端口 / nginx 反代域名）
    expect(run(open, 'POST', { origin: 'http://localhost:8787', host: 'localhost:8787' }).next).toBe(true)
    // 开发模式：Vite 代理 changeOrigin 改写 Host 为 8787，浏览器 Origin 仍为 5173
    expect(run(open, 'POST', { origin: 'http://localhost:5173', host: 'localhost:8787' }).next).toBe(true)
    // 跨站写请求拒绝（403 + 文案）
    const denied = run(open, 'POST', { origin: 'http://evil.com', host: 'localhost:8787' })
    expect(denied.next).toBe(false)
    expect(denied.res.statusCode).toBe(403)

    // 白名单：跨域按名单放行；同源不因白名单配置而被拒；名单外本机来源不放行（收紧语义与 CORS 一致）
    const listed: AppConfig = { ...loadConfig(), allowedOrigins: ['https://team.example.com'] }
    expect(run(listed, 'POST', { origin: 'https://team.example.com', host: 'localhost:8787' }).next).toBe(
      true,
    )
    expect(run(listed, 'POST', { origin: 'http://localhost:8787', host: 'localhost:8787' }).next).toBe(true)
    expect(run(listed, 'POST', { origin: 'http://localhost:5173', host: 'localhost:8787' }).next).toBe(false)
  })

  it('限流：超过 MESSAGE_RATE_LIMIT 条/分钟 → 429', async () => {
    const cfg: AppConfig = { ...loadConfig(), messageRateLimit: 2 }
    const app = express()
    app.use(express.json())
    app.post('/api/sessions/:id/messages', createMessageLimiter(cfg), (_req, res) => {
      res.json({ ok: true })
    })
    const server = app.listen(0)
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()))
      const port = (server.address() as AddressInfo).port
      const url = `http://127.0.0.1:${port}/api/sessions/s1/messages`
      const post = (): Promise<globalThis.Response> =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect((await post()).status).toBe(200)
      expect((await post()).status).toBe(200)
      const third = await post()
      expect(third.status).toBe(429)
      const body = (await third.json()) as { error: string }
      expect(body.error).toContain('频繁')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('浏览器授权入口（M10）：/?token= 种 cookie 302；错 token 401；无 token / 未配置放行', async () => {
    const cfg: AppConfig = { ...loadConfig(), authToken: 'entry-secret' }
    const app = express()
    app.use(createTokenEntryMiddleware(cfg))
    app.get('/', (_req, res) => res.json({ ok: true }))
    const server = app.listen(0)
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      const ok = await fetch(`${base}/?token=entry-secret`, { redirect: 'manual' })
      expect(ok.status).toBe(302)
      expect(ok.headers.get('location')).toBe('/')
      const cookie = ok.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('auth_token=entry-secret')
      expect(cookie).toContain('HttpOnly')

      expect((await fetch(`${base}/?token=wrong`)).status).toBe(401)
      expect((await fetch(`${base}/`)).status).toBe(200)

      const openApp = express()
      openApp.use(createTokenEntryMiddleware({ ...loadConfig(), authToken: '' }))
      openApp.get('/', (_req, res) => res.json({ ok: true }))
      const openServer = openApp.listen(0)
      await new Promise<void>((resolve) => openServer.once('listening', () => resolve()))
      try {
        const openBase = `http://127.0.0.1:${(openServer.address() as AddressInfo).port}`
        expect((await fetch(`${openBase}/?token=anything`, { redirect: 'manual' })).status).toBe(200)
      } finally {
        await new Promise<void>((resolve) => openServer.close(() => resolve()))
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('WS 握手鉴权（M10）：无/错 token 拒绝升级；cookie 或 query token 放行', async () => {
    const cfg: AppConfig = { ...loadConfig(), authToken: 'ws-secret' }
    const notify = new NotifyHub(cfg)
    const server = http.createServer((_req, res) => res.end('ok'))
    notify.attach(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const tryConnect = (suffix: string, headers?: Record<string, string>): Promise<boolean> =>
      new Promise((resolve) => {
        const socket = new WsClient(`ws://127.0.0.1:${port}${suffix}`, { headers })
        const done = (result: boolean): void => {
          resolve(result)
          socket.close()
        }
        socket.on('open', () => done(true))
        socket.on('error', () => done(false))
      })
    try {
      expect(await tryConnect('/ws')).toBe(false)
      expect(await tryConnect('/ws?token=wrong')).toBe(false)
      expect(await tryConnect('/ws?token=ws-secret')).toBe(true)
      expect(await tryConnect('/ws', { cookie: 'auth_token=ws-secret' })).toBe(true)
    } finally {
      notify.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('config：BIND_ALL=true 且无 AUTH_TOKEN → 拒绝启动', () => {
    const prevBind = process.env.BIND_ALL
    const prevToken = process.env.AUTH_TOKEN
    try {
      process.env.BIND_ALL = 'true'
      process.env.AUTH_TOKEN = ''
      expect(() => loadConfig()).toThrow(/AUTH_TOKEN/)
    } finally {
      if (prevBind === undefined) delete process.env.BIND_ALL
      else process.env.BIND_ALL = prevBind
      if (prevToken === undefined) delete process.env.AUTH_TOKEN
      else process.env.AUTH_TOKEN = prevToken
    }
  })

  it('schema：审批决策 / 消息体（zod）', () => {
    expect(approvalDecisionSchema.safeParse({ decision: 'approve' }).success).toBe(true)
    expect(approvalDecisionSchema.safeParse({ decision: 'yolo' }).success).toBe(false)
    expect(approvalDecisionSchema.safeParse({ decision: 'reject', feedback: '太危险' }).success).toBe(true)
    expect(sendMessageSchema.safeParse({ content: '   ' }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ content: '你好' }).data?.content).toBe('你好')
  })
})
