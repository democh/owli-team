/**
 * Mock 镜像面全量覆盖防回归测试（每个角色 × 4 件套：SCRIPTS / artifactFor / DISPLAY_NAMES / preferredOf，另核对 E2E AGENT_NAME）。
 *
 * 背景：mock.ts 是 E2E 与 eval 的离线确定性替身；其镜像面必须与 agents/ 资产全量同步（新角色入库即四件套齐备），
 * 否则出现两类历史缺陷（v14 扩张留 34 角色未补、v15 修 bi 漏镜像）：
 * ① 台词错位——角色漏配 SCRIPTS 时静默走 backend 兜底剧本（`?? SCRIPTS.backend`）；
 * ② 转交显示 id——漏配 DISPLAY_NAMES 时转交行显示「@sre」而非「@江屿」。
 *
 * 断言方式：artifactFor 已导出 → 直接行为断言；SCRIPTS / DISPLAY_NAMES / preferredOf 为私有实现，
 * 经 MockProvider.chatStream 行为驱动（同 E2E 真实链路）断言输出文本；E2E AGENT_NAME 以源文本核对。
 * 计数不写死（取 lib.list() 全量）——新增角色时本文件自动纳入覆盖，无需改断言。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { MockProvider, artifactFor } from '../src/llm/mock.js'
import type { ChatRequest } from '../src/llm/provider.js'
import { PromptLibrary } from '../src/store/prompts.js'

const TOPIC = '登录'
/** backend 兜底剧本特征串（`SCRIPTS[agentId] ?? SCRIPTS.backend` 兜底路径的判定依据） */
const BACKEND_FALLBACK_MARK = '接口我定了 3 个端点'
/** 交付契约的文档名占位符（M18 场景用「议题 / 课题」，其余用「主题」） */
const CONTRACT_PLACEHOLDERS = ['<主题>', '<议题>', '<课题>']
const E2E_HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e', 'helpers.ts')

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

function makeReq(agentId: string, participantIds: string[]): ChatRequest {
  return {
    system: '',
    messages: [{ role: 'user', content: `【用户】优化${TOPIC}体验` }],
    meta: { agentId, participantIds, spokenAgentIds: [agentId] },
  }
}

/** 驱动 MockProvider 文本输出（不给 tools → 跳过脚本化工具阶段，直达文本剧本 + 转交行） */
async function speak(provider: MockProvider, agentId: string, participantIds: string[]): Promise<string> {
  let out = ''
  for await (const chunk of provider.chatStream(makeReq(agentId, participantIds), new AbortController().signal)) {
    if (chunk.type === 'text') out += chunk.text
  }
  return out
}

describe('Mock 镜像面覆盖：全量角色四件套齐备', () => {
  it('artifactFor：全量角色命中专属交付件（无 default 兜底），路径与 AGENT.md 交付契约对齐', () => {
    const lib = realLibrary()
    const cfg = loadConfig()
    const roles = lib.list()
    expect(roles.length).toBeGreaterThanOrEqual(73)
    for (const role of roles) {
      const art = artifactFor(role.id, TOPIC)
      expect(art.path, `${role.id} 未配置专属交付件（走 default 兜底）`).not.toContain('工作笔记')
      expect(art.content.length, `${role.id} 交付件内容为空`).toBeGreaterThan(80)
      const md = fs.readFileSync(path.join(cfg.agentsDir, role.group, role.id, 'AGENT.md'), 'utf8')
      const hit = CONTRACT_PLACEHOLDERS.some((ph) => md.includes(art.path.replace(TOPIC, ph)))
      expect(hit, `${role.id} 交付件路径 ${art.path} 未与 AGENT.md 交付契约对齐`).toBe(true)
    }
  })

  it('SCRIPTS：全量角色均有专属剧本（不落 backend 兜底台词），单成员编制收尾交还用户', async () => {
    const lib = realLibrary()
    const provider = new MockProvider({ delayMs: 0 })
    for (const role of lib.list()) {
      const out = await speak(provider, role.id, [role.id])
      if (role.id !== 'backend') {
        expect(out, `${role.id} 缺失 SCRIPTS 条目（走了 backend 兜底剧本）`).not.toContain(BACKEND_FALLBACK_MARK)
      }
      expect(out, `${role.id} 单成员编制未收尾交还用户`).toContain('@用户')
    }
  })

  it('preferredOf / DISPLAY_NAMES：转交不随成员顺序漂移、首选属 handoff 且显示角色中文名', async () => {
    const lib = realLibrary()
    const provider = new MockProvider({ delayMs: 0 })
    for (const role of lib.list()) {
      if (role.handoff.length === 0) {
        // 无 handoff 角色（空场景通用助手）：单成员编制直接交还用户
        const out = await speak(provider, role.id, [role.id])
        expect(out, `${role.id} 无 handoff 时未交还用户`).toContain('@用户')
        continue
      }
      // 注入全部 handoff 目标（正序 / 逆序两次）：preferredOf 生效则转交对象一致（缺失时会漂移为成员首位）
      const outA = await speak(provider, role.id, [...role.handoff, role.id])
      const outB = await speak(provider, role.id, [...role.handoff].reverse().concat(role.id))
      const targetA = /@(\S+) 接力棒给你了。/.exec(outA)?.[1]
      const targetB = /@(\S+) 接力棒给你了。/.exec(outB)?.[1]
      expect(targetA, `${role.id} 未产出转交行`).toBeTruthy()
      expect(targetB, `${role.id} 转交随成员顺序漂移（preferredOf 缺失或失效）`).toBe(targetA)
      const inHandoff = role.handoff.some((t) => lib.get(t)?.name === targetA)
      expect(inHandoff, `${role.id} 转交对象「${targetA}」不在 handoff 内（preferredOf 表失配）`).toBe(true)
      expect(outA, `${role.id} 转交行回退显示了角色 id（DISPLAY_NAMES 缺失）`).not.toMatch(/@[a-z][\w-]* 接力棒/)
    }
  })

  it('M79-K：剧本标记 [[handoff:姓名]] → 行首 @该姓名 指定交还（覆盖默认承接 / 交还用户）', async () => {
    const provider = new MockProvider({ delayMs: 0 })
    const req: ChatRequest = {
      system: '',
      messages: [{ role: 'user', content: `【用户】优化${TOPIC}体验 [[handoff:张三]]` }],
      meta: { agentId: 'pm', participantIds: ['pm'], spokenAgentIds: ['pm'] },
    }
    let out = ''
    for await (const chunk of provider.chatStream(req, new AbortController().signal)) {
      if (chunk.type === 'text') out += chunk.text
    }
    expect(out).toMatch(/(^|\n)@张三 请你确认这一步。$/)

    // 共享会话昵称前缀（M57 P2 署名 `【e2e-admin】…`）同样命中（否则共享会话里标记/触发块静默失效）
    const sharedReq: ChatRequest = {
      system: '',
      messages: [
        { role: 'user', content: '【用户】优化登录体验' },
        { role: 'user', content: '【e2e-admin】请推进 [[handoff:李四]]' },
      ],
      meta: { agentId: 'pm', participantIds: ['pm'], spokenAgentIds: ['pm'] },
    }
    let sharedOut = ''
    for await (const chunk of provider.chatStream(sharedReq, new AbortController().signal)) {
      if (chunk.type === 'text') sharedOut += chunk.text
    }
    expect(sharedOut).toMatch(/(^|\n)@李四 请你确认这一步。$/)

    // 无标记 → 维持现值（单成员编制交还用户；零差异）
    const plain = await speak(provider, 'pm', ['pm'])
    expect(plain).toContain('@用户')
  })

  it('e2e/helpers.ts AGENT_NAME：与全部角色 id→name 逐一相等（E2E 转交断言的字面量镜像）', () => {
    const lib = realLibrary()
    const src = fs.readFileSync(E2E_HELPERS, 'utf8')
    const block = src.match(/export const AGENT_NAME: Record<string, string> = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const actual: Record<string, string> = {}
    for (const m of block.matchAll(/(?:'([\w-]+)'|([A-Za-z][\w-]*)):\s*'([^']+)'/g)) {
      actual[m[1] ?? m[2]] = m[3]
    }
    const expected = Object.fromEntries(lib.list().map((r) => [r.id, r.name]))
    expect(actual).toEqual(expected)
  })
})
