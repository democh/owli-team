/**
 * M26 测试：/api/console 资产控制台（Agent / Skill CRUD、引用检查、软删除、头像、校验聚合、工具元数据）。
 *
 * 环境：tmp 目录内播种 agents/（_protocol + _group.yaml + pm 角色）与 skills/（report），
 * PromptLibrary / SkillLibrary / SessionStore 真实装配（无 mock），express listen(0) 真实 HTTP 往返。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { AgentGroup, ConsoleAgentDetail, ConsoleAgentSummary, ConsoleSkillDetail, ConsoleToolInfo, ValidationIssue } from '@multi-agent/shared'
import { ASSETS_TOPIC } from '@multi-agent/shared'
import { AssetManager } from '../src/assets/manager.js'
import { loadConfig } from '../src/config.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createConsoleRouter } from '../src/routes/console.js'
import { openDatabase } from '../src/store/db.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { SessionStore } from '../src/store/sessions.js'
import { SkillLibrary } from '../src/store/skills.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { makeTmpDir } from './helpers.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

/** 播种：agents/development/{_group.yaml, pm/AGENT.md} + _protocol.md + skills/report/SKILL.md */
function seedAssets(agentsDir: string, skillsDir: string): void {
  fs.mkdirSync(path.join(agentsDir, 'development', 'pm'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, '_protocol.md'), '# 全局协作协议\n\n测试：保持结论收敛。\n')
  fs.writeFileSync(
    path.join(agentsDir, 'development', '_group.yaml'),
    [
      'id: development',
      'name: 研发团队',
      'description: 测试场景',
      'icon: code',
      'theme: ["#3b82f6", "#60a5fa"]',
      'objective: 交付可用软件',
      'chain: [pm]',
      'defaultSkills: []',
      'parallel: false',
      'rounds: false',
      'order: 10',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(agentsDir, 'development', 'pm', 'AGENT.md'),
    [
      '---',
      'id: pm',
      'name: 产品经理',
      'role: 产品经理',
      'title: 需求负责人',
      'description: 测试角色',
      'capabilities: [需求拆解]',
      'avatar:',
      '  icon: clipboard-list',
      '  gradient: ["#6366f1", "#818cf8"]',
      'handoff: []',
      '---',
      '',
      '## 职责',
      '',
      '测试正文。',
      '',
    ].join('\n'),
  )
  fs.mkdirSync(path.join(skillsDir, 'report'), { recursive: true })
  fs.writeFileSync(
    path.join(skillsDir, 'report', 'SKILL.md'),
    ['---', 'name: report', 'description: 编写结构化汇报时使用', 'tags: [汇报]', '---', '', '# report', '', '## 步骤', '', '1. 汇总要点', ''].join('\n'),
  )
}

interface PublishedNotification {
  type: string
  sessionId: string
  payload: Record<string, unknown>
}

async function makeConsoleEnv(): Promise<{
  dir: string
  agentsDir: string
  skillsDir: string
  trashDir: string
  prompts: PromptLibrary
  skills: SkillLibrary
  sessions: SessionStore
  assets: AssetManager
  published: PublishedNotification[]
  url: string
  close: () => Promise<void>
}> {
  const dir = makeTmpDir('ma-m26-')
  const agentsDir = path.join(dir, 'agents')
  const skillsDir = path.join(dir, 'skills')
  const trashDir = path.join(dir, 'data', 'trash', 'assets')
  seedAssets(agentsDir, skillsDir)
  const prompts = new PromptLibrary({ agentsDir, promptsDir: path.join(dir, 'prompts'), onWarn: () => undefined })
  const skills = new SkillLibrary(skillsDir)
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const sessions = new SessionStore(db)
  const tools = createToolRegistry(loadConfig())
  const assets = new AssetManager({
    agentsDir,
    skillsDir,
    trashDir,
    prompts,
    skills,
    sessions,
    toolNames: () => tools.list().map((t) => t.name),
  })
  const published: PublishedNotification[] = []
  const deps = {
    assets,
    prompts,
    tools,
    notify: {
      publish: (input: PublishedNotification) => {
        published.push(input)
        return input
      },
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api', createConsoleRouter(deps as unknown as ApiDeps))
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: `内部错误：${err.message}` })
  })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    dir,
    agentsDir,
    skillsDir,
    trashDir,
    prompts,
    skills,
    sessions,
    assets,
    published,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('M26：/api/console Agent 生命周期', () => {
  it('CRUD 全链路：创建（新场景）→ 详情 → 更新（三态）→ 复制 → 删除；每次写盘广播 assets-changed', async () => {
    const env = await makeConsoleEnv()
    try {
      // 创建：随向导新建场景 review
      const created = (await (
        await fetch(`${env.url}/api/console/agents`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            id: 'critic',
            group: 'review',
            newGroup: { id: 'review', name: '评审组', description: '挑刺', icon: 'gavel', theme: ['#ef4444', '#f87171'] },
            name: '挑刺官',
            role: '质量评审',
            title: '批判性评审',
            description: '专门找问题',
            capabilities: ['找问题'],
            avatar: { icon: 'bug', gradient: ['#f97316', '#fb923c'] },
            handoff: [],
            tools: ['read_file', 'search_text'],
            skills: ['report'],
            body: '## 职责\n\n对方案挑刺。',
          }),
        })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(created.agent.id).toBe('critic')
      expect(created.agent.group).toBe('review')
      expect(created.agent.meta.tools).toEqual(['read_file', 'search_text'])
      expect(created.agent.meta.skills).toEqual(['report'])
      expect(created.agent.body).toBe('## 职责\n\n对方案挑刺。')
      // 写盘即热更新：PromptLibrary 立即含新角色（无需重启 / 手动 reload）
      expect(env.prompts.list().some((a) => a.id === 'critic')).toBe(true)
      expect(fs.existsSync(path.join(env.agentsDir, 'review', 'critic', 'AGENT.md'))).toBe(true)
      expect(fs.existsSync(path.join(env.agentsDir, 'review', '_group.yaml'))).toBe(true)

      // 详情
      const detail = (await (await fetch(`${env.url}/api/console/agents/critic`)).json()) as { agent: ConsoleAgentDetail }
      expect(detail.agent.name).toBe('挑刺官')
      expect(detail.agent.refs.items).toEqual([])

      // 更新：tools/skills 传 null 恢复「未配置」三态；model/temperature 写入
      const updated = (await (
        await fetch(`${env.url}/api/console/agents/critic`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            name: '挑刺官',
            role: '质量评审',
            title: '批判性评审',
            description: '专门找问题',
            capabilities: ['找问题'],
            avatar: { icon: 'bug' },
            handoff: [],
            tools: null,
            skills: null,
            model: 'gpt-test',
            temperature: 0.4,
            body: '## 职责\n\n更新后的正文。',
          }),
        })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(updated.agent.meta.tools).toBeUndefined()
      expect(updated.agent.meta.skills).toBeUndefined()
      expect(updated.agent.meta.model).toBe('gpt-test')
      expect(updated.agent.meta.temperature).toBe(0.4)
      expect(updated.agent.body).toBe('## 职责\n\n更新后的正文。')
      const onDisk = fs.readFileSync(path.join(env.agentsDir, 'review', 'critic', 'AGENT.md'), 'utf8')
      expect(onDisk).not.toContain('tools:')
      expect(onDisk).not.toContain('skills:')

      // 复制：critic → critic-copy（名称带（副本））
      const copied = (await (
        await fetch(`${env.url}/api/console/agents/critic/duplicate`, { method: 'POST', headers: JSON_HEADERS })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(copied.agent.id).toBe('critic-copy')
      expect(copied.agent.name).toContain('（副本）')
      expect(fs.existsSync(path.join(env.agentsDir, 'review', 'critic-copy', 'AGENT.md'))).toBe(true)

      // 删除无引用角色：软删除到回收站；场景仍保留其余角色
      const deleted = (await (
        await fetch(`${env.url}/api/console/agents/critic-copy`, { method: 'DELETE' })
      ).json()) as { ok: boolean; deletedGroup: boolean }
      expect(deleted.ok).toBe(true)
      expect(deleted.deletedGroup).toBe(false)
      expect(fs.existsSync(path.join(env.agentsDir, 'review', 'critic-copy'))).toBe(false)
      const trashEntries = fs.existsSync(env.trashDir) ? fs.readdirSync(env.trashDir) : []
      expect(trashEntries.length).toBeGreaterThan(0)
      const moved = path.join(env.trashDir, trashEntries[0]!, 'agents', 'review', 'critic-copy', 'AGENT.md')
      expect(fs.existsSync(moved)).toBe(true)

      // 广播：创建 / 更新 / 复制 / 删除各一次 → ≥4 条，全部为保留主题
      const notifies = env.published.filter((n) => n.type === 'notify:assets-changed')
      expect(notifies.length).toBeGreaterThanOrEqual(4)
      expect(notifies.every((n) => n.sessionId === ASSETS_TOPIC)).toBe(true)
    } finally {
      await env.close()
    }
  })

  it('展示元数据 catalog：创建 / 更新 / 复制往返不丢，旧客户端不传时保留', async () => {
    const env = await makeConsoleEnv()
    try {
      const base = {
        name: '挑刺官',
        role: '质量评审',
        title: '批判性评审',
        description: '专门找问题',
        capabilities: ['找问题'],
        avatar: { icon: 'bug' },
        handoff: [],
        body: '## 职责\n\n对方案挑刺。',
      }
      const catalog = {
        keywords: ['挑刺'],
        inputs: ['待评审方案'],
        outputs: ['评审意见'],
        boundary: '只给意见，不代用户做决定。',
      }
      const post = async (body: unknown): Promise<{ agent: ConsoleAgentDetail }> =>
        (await (
          await fetch(`${env.url}/api/console/agents`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
        ).json()) as { agent: ConsoleAgentDetail }
      const put = async (body: unknown): Promise<{ agent: ConsoleAgentDetail }> =>
        (await (
          await fetch(`${env.url}/api/console/agents/critic`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) })
        ).json()) as { agent: ConsoleAgentDetail }

      const created = await post({
        ...base,
        id: 'critic',
        group: 'review',
        newGroup: { id: 'review', name: '评审组', description: '挑刺', icon: 'gavel', theme: ['#ef4444', '#f87171'] },
        catalog,
      })
      expect(created.agent.meta.catalog).toEqual(catalog)
      expect(fs.readFileSync(path.join(env.agentsDir, 'review', 'critic', 'AGENT.md'), 'utf8')).toContain('boundary:')

      // 旧客户端（不含 catalog 字段）保存 → 保留磁盘上的展示元数据
      const kept = await put({ ...base, name: '挑刺官' })
      expect(kept.agent.meta.catalog).toEqual(catalog)

      // 显式 null → 清除（三态语义）
      const cleared = await put({ ...base, catalog: null })
      expect(cleared.agent.meta.catalog).toBeUndefined()

      // 恢复后复制：副本保留 catalog
      await put({ ...base, catalog })
      const copied = (await (
        await fetch(`${env.url}/api/console/agents/critic/duplicate`, { method: 'POST', headers: JSON_HEADERS })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(copied.agent.meta.catalog).toEqual(catalog)
    } finally {
      await env.close()
    }
  })

  it('非法 id / 路径穿越 / 重复 id：400 与 409 拒绝', async () => {
    const env = await makeConsoleEnv()
    try {
      const base = { group: 'development', name: 'x', role: 'y', body: '## 职责\n\nx' }
      // 非法 id（大写）
      const badCase = await fetch(`${env.url}/api/console/agents`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...base, id: 'BadId' }),
      })
      expect(badCase.status).toBe(400)

      // 路径穿越（编码的 ../）
      const traversal = await fetch(`${env.url}/api/console/agents`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...base, id: '../evil' }),
      })
      expect(traversal.status).toBe(400)

      // 详情接口的路径穿越同样拒绝
      const traversalGet = await fetch(`${env.url}/api/console/agents/${encodeURIComponent('../../etc/passwd')}`)
      expect(traversalGet.status).toBe(400)

      // 重复 id：pm 已存在
      const dup = await fetch(`${env.url}/api/console/agents`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...base, id: 'pm' }),
      })
      expect(dup.status).toBe(409)

      // 不存在的场景（未带 newGroup）
      const noGroup = await fetch(`${env.url}/api/console/agents`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...base, id: 'ghost', group: 'nope' }),
      })
      expect(noGroup.status).toBe(400)

      // 未知工具名 → 400（toolNames 白名单）
      const badTool = await fetch(`${env.url}/api/console/agents`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...base, id: 'okname', tools: ['not_a_real_tool'] }),
      })
      expect(badTool.status).toBe(400)
    } finally {
      await env.close()
    }
  })

  it('引用检查：handoff / 会话成员命中时 409 + 清单，force=1 强制软删除；组内最后角色整组入回收站', async () => {
    const env = await makeConsoleEnv()
    try {
      // 造引用：新角色 self-review + pm handoff 指向它
      await fetch(`${env.url}/api/console/agents`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: 'reviewer',
          group: 'development',
          name: '评审员',
          role: '评审',
          handoff: [],
          body: '## 职责\n\n评审。',
        }),
      })
      await fetch(`${env.url}/api/console/agents/pm`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: '产品经理',
          role: '产品经理',
          title: '需求负责人',
          description: '测试角色',
          capabilities: ['需求拆解'],
          avatar: { icon: 'clipboard-list', gradient: ['#6366f1', '#818cf8'] },
          handoff: ['reviewer'],
          tools: null,
          skills: null,
          body: '## 职责\n\n测试正文。',
        }),
      })
      // 会话成员引用
      env.sessions.create(['reviewer'], '引用 reviewer 的会话')

      const conflict = await fetch(`${env.url}/api/console/agents/reviewer`, { method: 'DELETE' })
      expect(conflict.status).toBe(409)
      const body = (await conflict.json()) as { error: string; refs: string[] }
      expect(body.refs.length).toBeGreaterThanOrEqual(2)
      expect(body.refs.some((r) => r.includes('pm'))).toBe(true)
      expect(body.refs.some((r) => r.includes('会话'))).toBe(true)

      // force=1 → 删除成功
      const forced = (await (
        await fetch(`${env.url}/api/console/agents/reviewer?force=1`, { method: 'DELETE' })
      ).json()) as { ok: boolean; deletedGroup: boolean }
      expect(forced.ok).toBe(true)
      expect(forced.deletedGroup).toBe(false)

      // 组内最后角色（pm）删除 → 整组（含 _group.yaml）入回收站
      const last = (await (await fetch(`${env.url}/api/console/agents/pm?force=1`, { method: 'DELETE' })).json()) as {
        ok: boolean
        deletedGroup: boolean
      }
      expect(last.deletedGroup).toBe(true)
      expect(fs.existsSync(path.join(env.agentsDir, 'development'))).toBe(false)
      const trashEntries = fs.readdirSync(env.trashDir)
      const groupMoved = trashEntries.some((t) =>
        fs.existsSync(path.join(env.trashDir, t, 'agents', 'development', '_group.yaml')),
      )
      expect(groupMoved).toBe(true)
    } finally {
      await env.close()
    }
  })

  it('头像：非 PNG 400 / 合法 PNG 写入并出现在摘要 / 删除后回收站', async () => {
    const env = await makeConsoleEnv()
    try {
      // 非 PNG（明文 base64）
      const bad = await fetch(`${env.url}/api/console/agents/pm/avatar`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ data: Buffer.from('not a png').toString('base64') }),
      })
      expect(bad.status).toBe(400)

      // 合法 PNG（magic 头 + 少量数据；服务端只做文件头校验）
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('m26-test'),
      ])
      const uploaded = (await (
        await fetch(`${env.url}/api/console/agents/pm/avatar`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({ data: `data:image/png;base64,${png.toString('base64')}` }),
        })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(uploaded.agent.hasAvatar).toBe(true)
      expect(uploaded.agent.avatar.image).toBe('/api/agents/pm/avatar')
      expect(fs.existsSync(path.join(env.agentsDir, 'development', 'pm', 'avatar.png'))).toBe(true)

      // 列表摘要同步
      const list = (await (await fetch(`${env.url}/api/console/agents`)).json()) as { agents: ConsoleAgentSummary[] }
      expect(list.agents.find((a) => a.id === 'pm')?.hasAvatar).toBe(true)

      // 删除头像 → 回收站
      const removed = (await (
        await fetch(`${env.url}/api/console/agents/pm/avatar`, { method: 'DELETE' })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(removed.agent.hasAvatar).toBe(false)
      expect(fs.existsSync(path.join(env.agentsDir, 'development', 'pm', 'avatar.png'))).toBe(false)
    } finally {
      await env.close()
    }
  })

  it('灵魂：写入 / 设为默认（patch soul 字段）/ 删除（显式默认灵魂被删时清字段）', async () => {
    const env = await makeConsoleEnv()
    try {
      const written = (await (
        await fetch(`${env.url}/api/console/agents/pm/souls/advisor`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            name: '军师',
            tagline: '冷静参谋',
            traits: ['冷静'],
            tone: '沉稳',
            quirks: ['三思而后行'],
            body: '你是军师。',
            setDefault: true,
          }),
        })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(written.agent.souls).toHaveLength(1)
      expect(written.agent.souls[0]!.isDefault).toBe(true)
      expect(written.agent.soulCount).toBe(1)
      expect(written.agent.meta.soul).toBe('advisor')
      expect(fs.existsSync(path.join(env.agentsDir, 'development', 'pm', 'souls', 'advisor.md'))).toBe(true)

      // 列表摘要灵魂数同步
      const list = (await (await fetch(`${env.url}/api/console/agents`)).json()) as { agents: ConsoleAgentSummary[] }
      expect(list.agents.find((a) => a.id === 'pm')?.soulCount).toBe(1)

      // 删除：显式 soul=advisor 被清空（否则 PromptLibrary 拒绝加载）
      const deleted = (await (
        await fetch(`${env.url}/api/console/agents/pm/souls/advisor`, { method: 'DELETE' })
      ).json()) as { agent: ConsoleAgentDetail }
      expect(deleted.agent.souls).toHaveLength(0)
      expect(deleted.agent.meta.soul).toBeUndefined()
      const raw = fs.readFileSync(path.join(env.agentsDir, 'development', 'pm', 'AGENT.md'), 'utf8')
      expect(raw).not.toContain('soul:')
    } finally {
      await env.close()
    }
  })
})

describe('M26：/api/console Skill 生命周期', () => {
  it('创建 / 更新 / 列表（引用统计）/ 引用检查 409 / force 删除入回收站', async () => {
    const env = await makeConsoleEnv()
    try {
      // 创建
      const created = (await (
        await fetch(`${env.url}/api/console/skills`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: 'weekly-report', description: '写周报时使用', tags: ['汇报'], body: '# weekly-report\n\n步骤。' }),
        })
      ).json()) as { skill: ConsoleSkillDetail }
      expect(created.skill.name).toBe('weekly-report')
      expect(created.skill.lineCount).toBeGreaterThan(0)
      // 热更新：技能库立即可见
      expect(env.skills.list().some((s) => s.name === 'weekly-report')).toBe(true)

      // 重复创建 409
      const dup = await fetch(`${env.url}/api/console/skills`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'weekly-report', description: 'x', body: '# x' }),
      })
      expect(dup.status).toBe(409)

      // 非法名（含下划线）
      const badName = await fetch(`${env.url}/api/console/skills`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'bad_name', description: 'x', body: '# x' }),
      })
      expect(badName.status).toBe(400)

      // 更新
      const updated = (await (
        await fetch(`${env.url}/api/console/skills/weekly-report`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({ description: '写周报时使用（更新）', tags: ['汇报', '写作'], body: '# weekly-report\n\n新步骤。' }),
        })
      ).json()) as { skill: ConsoleSkillDetail }
      expect(updated.skill.description).toContain('更新')
      expect(updated.skill.tags).toEqual(['汇报', '写作'])

      // 角色预载引用 → 删除 409 + 清单
      await fetch(`${env.url}/api/console/agents/pm`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: '产品经理',
          role: '产品经理',
          title: '需求负责人',
          description: '测试角色',
          capabilities: ['需求拆解'],
          avatar: { icon: 'clipboard-list' },
          handoff: [],
          tools: null,
          skills: ['weekly-report'],
          body: '## 职责\n\n测试正文。',
        }),
      })
      const conflict = await fetch(`${env.url}/api/console/skills/weekly-report`, { method: 'DELETE' })
      expect(conflict.status).toBe(409)
      const refsBody = (await conflict.json()) as { refs: string[] }
      expect(refsBody.refs.some((r) => r.includes('pm'))).toBe(true)

      // 列表：引用统计出现在摘要
      const list = (await (await fetch(`${env.url}/api/console/skills`)).json()) as { skills: ConsoleSkillDetail[] }
      const summary = list.skills.find((s) => s.name === 'weekly-report')
      expect(summary?.usedByAgents).toContain('pm')

      // force 删除 → 回收站
      const forced = await fetch(`${env.url}/api/console/skills/weekly-report?force=1`, { method: 'DELETE' })
      expect(forced.status).toBe(200)
      expect(fs.existsSync(path.join(env.skillsDir, 'weekly-report'))).toBe(false)
      const trashEntries = fs.readdirSync(env.trashDir)
      expect(trashEntries.some((t) => fs.existsSync(path.join(env.trashDir, t, 'skills', 'weekly-report', 'SKILL.md')))).toBe(true)
    } finally {
      await env.close()
    }
  })
})

describe('M26：/api/console 场景 / 校验 / 工具元数据', () => {
  it('GET /groups 返回播种场景；POST /groups 建新场景', async () => {
    const env = await makeConsoleEnv()
    try {
      const list = (await (await fetch(`${env.url}/api/console/groups`)).json()) as { groups: AgentGroup[] }
      expect(list.groups.map((g) => g.id)).toContain('development')

      const created = (await (
        await fetch(`${env.url}/api/console/groups`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ id: 'ops', name: '运营组', icon: 'headset' }),
        })
      ).json()) as { group: AgentGroup }
      expect(created.group.id).toBe('ops')
      expect(created.group.chain).toEqual([])
      expect(fs.existsSync(path.join(env.agentsDir, 'ops', '_group.yaml'))).toBe(true)

      const dup = await fetch(`${env.url}/api/console/groups`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'ops', name: '运营组2' }),
      })
      expect(dup.status).toBe(409)
    } finally {
      await env.close()
    }
  })

  it('POST /validate：聚合 handoff 悬空 / 技能目录缺 SKILL.md / 场景空组，健康资产零 error', async () => {
    const env = await makeConsoleEnv()
    try {
      // 健康基线
      const healthy = (await (
        await fetch(`${env.url}/api/console/validate`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })
      ).json()) as { issues: ValidationIssue[] }
      expect(healthy.issues.filter((i) => i.level === 'error')).toHaveLength(0)

      // 注入问题 1：handoff 指向不存在的角色（写盘时允许，校验时暴露）
      await fetch(`${env.url}/api/console/agents/pm`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: '产品经理',
          role: '产品经理',
          title: '需求负责人',
          description: '测试角色',
          capabilities: ['需求拆解'],
          avatar: { icon: 'clipboard-list' },
          handoff: ['ghost'],
          tools: null,
          skills: null,
          body: '## 职责\n\n测试正文。',
        }),
      })
      // 注入问题 2：技能目录缺 SKILL.md
      fs.mkdirSync(path.join(env.skillsDir, 'broken'), { recursive: true })

      const issues = (await (
        await fetch(`${env.url}/api/console/validate`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })
      ).json()) as { issues: ValidationIssue[] }
      expect(issues.issues.some((i) => i.message.includes('handoff') && i.message.includes('ghost'))).toBe(true)
      expect(issues.issues.some((i) => i.path === 'skills/broken' && i.level === 'error')).toBe(true)
    } finally {
      await env.close()
    }
  })

  it('GET /tools：真实注册表元数据（分类映射 / readOnly / 参数项数 / 白名单使用情况）', async () => {
    const env = await makeConsoleEnv()
    try {
      // 给 pm 配白名单 → usedByAgents 反映使用情况
      await fetch(`${env.url}/api/console/agents/pm`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: '产品经理',
          role: '产品经理',
          title: '需求负责人',
          description: '测试角色',
          capabilities: ['需求拆解'],
          avatar: { icon: 'clipboard-list' },
          handoff: [],
          tools: ['read_file', 'git_status'],
          skills: null,
          body: '## 职责\n\n测试正文。',
        }),
      })
      const { tools } = (await (await fetch(`${env.url}/api/console/tools`)).json()) as { tools: ConsoleToolInfo[] }
      const readFile = tools.find((t) => t.name === 'read_file')
      expect(readFile).toBeTruthy()
      expect(readFile!.category).toBe('文件检索')
      expect(readFile!.readOnly).toBe(true)
      expect(readFile!.paramCount).toBeGreaterThan(0)
      expect(readFile!.usedByAgents).toContain('pm')
      expect(tools.find((t) => t.name === 'git_status')?.category).toBe('Git')
      expect(tools.find((t) => t.name === 'web_search')?.category).toBe('联网')
      expect(tools.find((t) => t.name === 'remember')?.category).toBe('记忆协作')
    } finally {
      await env.close()
    }
  })
})
