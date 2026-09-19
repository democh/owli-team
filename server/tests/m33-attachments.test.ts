/**
 * M33 测试：附件上传通道 + 消息附件链路 + 视觉注入护栏。
 *
 * - POST /sessions/:id/attachments：raw 直传 201、类型白名单 400、空体 400、文件名安全化
 *   （路径穿越清洗 / 长名前导点保留扩展名 / 非法 URL 编码 400）、x-file-metadata（时长取整 /
 *   非法与越界静默丢弃）、图片尺寸服务端探测优先；
 * - sendMessageSchema：纯附件消息（content 空）通过、空内容且无附件拒绝、附件数上限；
 * - 发送接口：附件路径防伪造（非 uploads/ / 归一化穿越 / 不存在 → 400）、kind / mime / size
 *   以磁盘事实重算（客户端伪造被覆盖）、上传 → 发送 → 双端持久化；
 * - fork：附件文件随分支复制（元数据保留、新工作区可见）；
 * - ContextService 装配：磁盘体积超 8MB 的图片在 loadImage 阶段跳过（历史伪造元数据兜底）；
 * - buildWindow 视觉护栏：从后往前填充（全窗 ≤6 / 单条 ≤4 / >8MB 跳过 / 读取失败不占配额），
 *   未注入图片保留文本占位；纯附件消息进入窗口。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessageAttachment } from '@multi-agent/shared'
import { buildWindow } from '../src/context/assembler.js'
import { VISION_TOKENS_PER_IMAGE } from '../src/context/tokenizer.js'
import { textOfContent } from '../src/llm/content.js'
import type { LlmContentPart, LlmMessageInput } from '../src/llm/provider.js'
import { createAttachmentsRouter } from '../src/routes/attachments.js'
import type { ApiDeps } from '../src/routes/index.js'
import { sendMessageSchema } from '../src/routes/schemas.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { makeEnv, waitRunFinished } from './helpers.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

// ---------- fixtures ----------

/** 最小合法 PNG（签名 + IHDR 宽高；服务端 probeImageSize 仅读文件头） */
function pngFixture(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** 完整 API 夹具：raw（附件）+ json（会话）双通道，与 index.ts 同序 */
async function startApi(env: ReturnType<typeof makeEnv>): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use('/api/sessions/:id/attachments', express.raw({ type: () => true, limit: '200mb' }))
  app.use('/api', express.json())
  app.use('/api', createSessionsRouter(env as unknown as ApiDeps))
  app.use('/api', createAttachmentsRouter(env as unknown as ApiDeps))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 上传辅助：x-file-name URL 编码 + 可选 x-file-metadata */
async function upload(
  url: string,
  sessionId: string,
  name: string,
  body: Buffer,
  metadata?: string,
): Promise<{ status: number; attachment?: MessageAttachment; error?: string }> {
  const res = await fetch(`${url}/api/sessions/${sessionId}/attachments`, {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent(name),
      ...(metadata ? { 'x-file-metadata': metadata } : {}),
    },
    body,
  })
  return { status: res.status, ...((await res.json()) as { attachment?: MessageAttachment; error?: string }) }
}

const validAttachment: MessageAttachment = {
  path: 'uploads/abc-a.png',
  name: 'a.png',
  kind: 'image',
  mime: 'image/png',
  size: 1024,
  uploadedAt: new Date().toISOString(),
}

// ---------- 上传端点 ----------

describe('M33：附件上传端点 POST /api/sessions/:id/attachments', () => {
  it('PNG 直传：201 + 服务端尺寸探测（覆盖客户端元数据）+ uploads/ 落盘 + artifact 广播', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const body = pngFixture(320, 180)
      const res = await upload(app.url, session.id, '界面截图.png', body, JSON.stringify({ width: 1, height: 1 }))
      expect(res.status).toBe(201)
      const att = res.attachment!
      expect(att.kind).toBe('image')
      expect(att.mime).toBe('image/png')
      expect(att.name).toBe('界面截图.png')
      expect(att.size).toBe(body.length)
      expect(att.path).toMatch(/^uploads\/[0-9a-z]+-界面截图\.png$/)
      // 服务端探测优先于客户端元数据（不可伪造）
      expect(att.width).toBe(320)
      expect(att.height).toBe(180)
      expect(typeof att.uploadedAt).toBe('string')
      // 真实落盘且限定在会话目录内
      const full = env.artifacts.resolveSafe(session.id, att.path)
      expect(fs.existsSync(full)).toBe(true)
      // artifact:updated 广播（交付件面板即时刷新）
      expect(env.published.some((n) => n.type === 'notify:artifact-updated' && n.sessionId === session.id)).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('类型白名单：可执行 / 无扩展名 → 400（不落盘）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const exe = await upload(app.url, session.id, '木马.exe', Buffer.from('MZ'))
      expect(exe.status).toBe(400)
      expect(exe.error).toContain('不支持的文件类型')
      const noExt = await upload(app.url, session.id, 'README', Buffer.from('x'))
      expect(noExt.status).toBe(400)
      // 白名单拒绝不产生任何文件
      const dir = env.artifacts.ensureSessionDir(session.id)
      const uploadsDir = `${dir}/uploads`
      expect(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : 0).toBe(0)
    } finally {
      await app.close()
    }
  })

  it('空请求体 → 400', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const res = await fetch(`${app.url}/api/sessions/${session.id}/attachments`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.png') },
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('请求体为空')
    } finally {
      await app.close()
    }
  })

  it('文件名安全化：路径穿越仅保留 basename、非法字符替换、不逃逸会话目录', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const res = await upload(app.url, session.id, '../../etc/pa ss wd?.txt', Buffer.from('hello'))
      expect(res.status).toBe(201)
      const att = res.attachment!
      // 展示名取 basename（保留原始形态）
      expect(att.name).toBe('pa ss wd?.txt')
      // 落盘名清洗：空白 / ? 替换为 _；无路径段逃逸
      expect(att.path.startsWith('uploads/')).toBe(true)
      expect(att.path).not.toContain('..')
      expect(att.path).toContain('pa_ss_wd_.txt')
      const full = env.artifacts.resolveSafe(session.id, att.path)
      expect(fs.existsSync(full)).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('文件名安全化：长名 / 前导点不丢扩展名（防隐藏文件的同时保留类型）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      // 200 字符长名：主名截断到 120 − 扩展名长度（不含时间戳前缀），扩展名保留（否则类型识别 / 预览全失效）
      const long = await upload(app.url, session.id, `${'a'.repeat(200)}.png`, pngFixture(4, 4))
      expect(long.status).toBe(201)
      const stored = long.attachment!.path.split('/').pop()!
      const namePart = stored.replace(/^[0-9a-z]+-/, '')
      expect(namePart.endsWith('.png')).toBe(true)
      expect(namePart.length).toBeLessThanOrEqual(120)
      expect(long.attachment!.kind).toBe('image')
      // '..png'：去前导点但保留扩展名（旧实现去点后连扩展名一起丢掉）
      const dot = await upload(app.url, session.id, '..png', pngFixture(4, 4))
      expect(dot.status).toBe(201)
      expect(dot.attachment!.path).toMatch(/^uploads\/[0-9a-z]+-file\.png$/)
      expect(dot.attachment!.kind).toBe('image')
    } finally {
      await app.close()
    }
  })

  it('x-file-name 非法 URL 编码 → 400（不再 500）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const res = await fetch(`${app.url}/api/sessions/${session.id}/attachments`, {
        method: 'POST',
        headers: { 'x-file-name': '%E0%A4%A' },
        body: Buffer.from('x'),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('文件名编码非法')
    } finally {
      await app.close()
    }
  })

  it('x-file-metadata：视频时长取整；非法 JSON / 越界值静默丢弃（不阻断上传）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const ok = await upload(
        app.url,
        session.id,
        '演示.mp4',
        Buffer.from('fake-mp4'),
        JSON.stringify({ durationMs: 12345.6, width: 1920, height: 1080 }),
      )
      expect(ok.status).toBe(201)
      expect(ok.attachment!.kind).toBe('video')
      expect(ok.attachment!.mime).toBe('video/mp4')
      expect(ok.attachment!.durationMs).toBe(12346)
      expect(ok.attachment!.width).toBe(1920)

      const bad = await upload(app.url, session.id, 'b.mp4', Buffer.from('x'), '{not-json')
      expect(bad.status).toBe(201)
      expect(bad.attachment!.durationMs).toBeUndefined()

      const oob = await upload(
        app.url,
        session.id,
        'c.mp4',
        Buffer.from('x'),
        JSON.stringify({ durationMs: -1, width: 999999, height: 10 }),
      )
      expect(oob.status).toBe(201)
      expect(oob.attachment!.durationMs).toBeUndefined()
      expect(oob.attachment!.width).toBeUndefined()
      expect(oob.attachment!.height).toBeUndefined()
    } finally {
      await app.close()
    }
  })
})

// ---------- sendMessageSchema ----------

describe('M33：sendMessageSchema（消息 + 附件）', () => {
  it('纯附件消息（content 为空）通过；空内容且无附件 → 拒绝', () => {
    expect(sendMessageSchema.safeParse({ content: '', attachments: [validAttachment] }).success).toBe(true)
    const empty = sendMessageSchema.safeParse({ content: '   ' })
    expect(empty.success).toBe(false)
    if (!empty.success) expect(empty.error.issues[0].message).toContain('至少提供一个')
  })

  it('附件数上限 10；非法 kind / 缺字段 → 拒绝', () => {
    const tooMany = sendMessageSchema.safeParse({
      content: '',
      attachments: Array.from({ length: 11 }, () => validAttachment),
    })
    expect(tooMany.success).toBe(false)
    expect(sendMessageSchema.safeParse({ content: 'x', attachments: [{ ...validAttachment, kind: 'exe' }] }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ content: 'x', attachments: [{ path: 'uploads/a.png' }] }).success).toBe(false)
  })
})

// ---------- 发送接口：防伪造 + 持久化 ----------

describe('M33：发送接口附件校验与持久化', () => {
  it('附件路径防伪造：非 uploads/ 前缀 / 文件不存在 → 400', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const forged = await fetch(`${app.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: '看下', attachments: [{ ...validAttachment, path: 'evil/a.png' }] }),
      })
      expect(forged.status).toBe(400)
      expect(((await forged.json()) as { error: string }).error).toContain('附件路径非法')

      const missing = await fetch(`${app.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: '看下', attachments: [{ ...validAttachment, path: 'uploads/不存在.png' }] }),
      })
      expect(missing.status).toBe(400)
      expect(((await missing.json()) as { error: string }).error).toContain('附件不存在')
    } finally {
      await app.close()
    }
  })

  it('附件路径防伪造：归一化穿越（uploads/../x）→ 400', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const res = await fetch(`${app.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: '看下', attachments: [{ ...validAttachment, path: 'uploads/../secret.png' }] }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('附件路径非法')
    } finally {
      await app.close()
    }
  })

  it('发送时元数据以磁盘事实重算（伪造 size / kind / mime 被覆盖）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const up = await upload(app.url, session.id, '真实.png', pngFixture(64, 64))
      expect(up.status).toBe(201)
      const att = up.attachment!
      // 伪造：宣称是 1 字节的 mp4（可绕过装配器的 8MB 视觉护栏）
      const forged = { ...att, kind: 'video', mime: 'video/mp4', size: 1 }
      const sent = await fetch(`${app.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: '看下', attachments: [forged] }),
      })
      expect(sent.status).toBe(201)
      const body = (await sent.json()) as { message: ChatMessage; runId?: string }
      const saved = body.message.attachments![0]
      expect(saved.size).toBe(att.size)
      expect(saved.kind).toBe('image')
      expect(saved.mime).toBe('image/png')
      if (body.runId) await waitRunFinished(env.engine, body.runId)
    } finally {
      await app.close()
    }
  })

  it('fork：附件随分支复制（文件落入新工作区 + 元数据保留）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const up = await upload(app.url, session.id, '设计稿.png', pngFixture(64, 64))
      const att = up.attachment!
      const sent = await fetch(`${app.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: '', attachments: [att] }),
      })
      expect(sent.status).toBe(201)
      const body = (await sent.json()) as { message: ChatMessage; runId?: string }
      if (body.runId) await waitRunFinished(env.engine, body.runId)

      const forked = await fetch(`${app.url}/api/sessions/${session.id}/fork`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ fromMessageId: body.message.id }),
      })
      expect(forked.status).toBe(201)
      const { session: next } = (await forked.json()) as { session: { id: string } }
      const copied = env.sessions.messages(next.id).find((m) => m.attachments?.length)
      expect(copied?.attachments).toEqual([att])
      // 文件已复制到新会话工作区（相对路径相同）
      const full = env.artifacts.resolveSafe(next.id, att.path)
      expect(fs.existsSync(full)).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('上传 → 发送（纯附件消息）→ 201 + 内存与 DB 双端持久化 + 会话以附件名命名', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const app = await startApi(env)
    try {
      const up = await upload(app.url, session.id, '设计稿.png', pngFixture(64, 64))
      expect(up.status).toBe(201)
      const att = up.attachment!

      const sent = await fetch(`${app.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: '', attachments: [att] }),
      })
      expect(sent.status).toBe(201)
      const body = (await sent.json()) as { message: ChatMessage; runId?: string }
      expect(body.message.attachments).toEqual([att])
      if (body.runId) await waitRunFinished(env.engine, body.runId)

      // DB 双端一致（messages.attachments 列 JSON）
      const row = env.db.get<{ attachments: string | null }>('SELECT attachments FROM messages WHERE id = ?', body.message.id)
      expect(row?.attachments).toBeTruthy()
      expect(JSON.parse(row!.attachments!)).toEqual([att])
      // 纯附件消息：会话标题以附件名兜底命名
      expect(env.sessions.getSession(session.id)?.title).toBe('设计稿.png')
    } finally {
      await app.close()
    }
  })
})

// ---------- buildWindow 视觉注入护栏 ----------

const SESSION_ID = 's-m33'
const NOW = new Date().toISOString()

function imageAttachment(seq: number, index: number, size = 1024): MessageAttachment {
  return {
    path: `uploads/img-${seq}-${index}.png`,
    name: `图-${seq}-${index}.png`,
    kind: 'image',
    mime: 'image/png',
    size,
    uploadedAt: NOW,
  }
}

function userMessage(seq: number, attachments?: MessageAttachment[], content = ''): ChatMessage {
  return {
    id: `m-${seq}`,
    sessionId: SESSION_ID,
    role: 'user',
    content,
    mentions: [],
    status: 'complete',
    seq,
    turnIndex: -1,
    createdAt: NOW,
    attachments,
  }
}

function imageParts(content: LlmMessageInput['content']): LlmContentPart[] {
  return Array.isArray(content) ? content.filter((p) => p.type === 'image_url') : []
}

describe('M33：装配器视觉注入护栏（buildWindow）', () => {
  it('从后往前填充：全窗 ≤6 张、单条 ≤4 张；未注入消息保留文本占位', () => {
    const messages = [1, 2, 3].map((seq) =>
      userMessage(seq, Array.from({ length: 5 }, (_, i) => imageAttachment(seq, i))),
    )
    const loaded: string[] = []
    const out = buildWindow({
      messages,
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 1_000_000,
      toolDetailKeep: 4,
      loadImage: (p) => {
        loaded.push(p)
        return { mime: 'image/png', dataUrl: `data:image/png;base64,${p}` }
      },
    })
    // 注入顺序：最近一条 4 张（单条上限）→ 上一条补 2 张（全窗上限 6）
    expect(loaded).toEqual([
      'uploads/img-3-0.png',
      'uploads/img-3-1.png',
      'uploads/img-3-2.png',
      'uploads/img-3-3.png',
      'uploads/img-2-0.png',
      'uploads/img-2-1.png',
    ])
    expect(imageParts(out.messages[2].content)).toHaveLength(4)
    expect(imageParts(out.messages[1].content)).toHaveLength(2)
    // 最早一条未获配额：纯文本 + [附件] 占位（含全部文件名，模型可感知）
    const first = textOfContent(out.messages[0].content)
    expect(first).toContain('[附件]')
    expect(first).toContain('图-1-0.png')
    expect(first).toContain('图-1-4.png')
    // 视觉 token 计入窗口总量
    expect(out.tokens).toBeGreaterThanOrEqual(6 * VISION_TOKENS_PER_IMAGE)
  })

  it('单图 >8MB 或读取失败 → 跳过且不占视觉配额', () => {
    const messages = [
      userMessage(1, [imageAttachment(1, 0, 1024 * 1024), imageAttachment(1, 1, 9 * 1024 * 1024), imageAttachment(1, 2)]),
      userMessage(2, [imageAttachment(2, 0), imageAttachment(2, 1), imageAttachment(2, 2)]),
    ]
    const failed = new Set(['uploads/img-2-1.png'])
    const loaded: string[] = []
    const out = buildWindow({
      messages,
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 1_000_000,
      toolDetailKeep: 4,
      loadImage: (p) => {
        loaded.push(p)
        return failed.has(p) ? undefined : { mime: 'image/png', dataUrl: 'data:image/png;base64,x' }
      },
    })
    // 9MB 图根本不进入加载序列；读取失败的 img-2-1 不扣配额（img-2-2 补入）
    expect(loaded).not.toContain('uploads/img-1-1.png')
    expect(loaded).toEqual([
      'uploads/img-2-0.png',
      'uploads/img-2-1.png',
      'uploads/img-2-2.png',
      'uploads/img-1-0.png',
      'uploads/img-1-2.png',
    ])
    expect(imageParts(out.messages[1].content)).toHaveLength(2)
    expect(imageParts(out.messages[0].content)).toHaveLength(2)
    // 读取失败的 img-2-1 不注入但保留文本占位；被跳过的 9MB 图同样占位
    expect(textOfContent(out.messages[1].content)).toContain('图-2-1.png')
    expect(textOfContent(out.messages[0].content)).toContain('图-1-1.png')
  })

  it('纯附件消息（无正文）进入窗口；loadImage 缺省时保持纯文本 + [附件] 占位', () => {
    const out = buildWindow({
      messages: [userMessage(1, [imageAttachment(1, 0)], '')],
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 4096,
      toolDetailKeep: 4,
    })
    expect(out.messages).toHaveLength(1)
    const text = textOfContent(out.messages[0].content)
    expect(text).toContain('【用户】')
    expect(text).toContain('[附件]')
    expect(text).toContain('图-1-0.png')
  })

  it('非视觉图片（svg）不注入：仍是文本占位', () => {
    const svg: MessageAttachment = { ...imageAttachment(1, 0), path: 'uploads/logo.svg', name: 'logo.svg', mime: 'image/svg+xml' }
    const loaded: string[] = []
    const out = buildWindow({
      messages: [userMessage(1, [svg])],
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 4096,
      toolDetailKeep: 4,
      loadImage: (p) => {
        loaded.push(p)
        return { mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml,x' }
      },
    })
    expect(loaded).toHaveLength(0)
    expect(typeof out.messages[0].content).toBe('string')
    expect(textOfContent(out.messages[0].content)).toContain('logo.svg')
  })
})

// ---------- ContextService 装配：磁盘读取护栏（历史伪造元数据兜底） ----------

describe('M33：ContextService 装配图片体积护栏', () => {
  it('磁盘体积超 8MB 的图片在 loadImage 阶段跳过（消息内伪造 size=1 不可绕过）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const root = env.artifacts.ensureSessionDir(session.id)
    fs.mkdirSync(path.join(root, 'uploads'), { recursive: true })
    // 稀疏 9MB 文件：不实际占盘，但 stat.size 超 8MB 护栏
    const big = path.join(root, 'uploads', 'big.png')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, 9 * 1024 * 1024)
    fs.writeFileSync(path.join(root, 'uploads', 'small.png'), pngFixture(4, 4))
    env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '看两张图',
      mentions: [],
      status: 'complete',
      attachments: [
        { path: 'uploads/big.png', name: 'big.png', kind: 'image', mime: 'image/png', size: 1, uploadedAt: NOW },
        { path: 'uploads/small.png', name: 'small.png', kind: 'image', mime: 'image/png', size: 24, uploadedAt: NOW },
      ],
    })
    const prepared = await env.context.prepareTurn({ sessionId: session.id, agentId: 'pm', runId: 'r-m33-guard', queue: [] })
    const user = prepared.messages.find((m) => m.role === 'user')!
    expect(Array.isArray(user.content)).toBe(true)
    const parts = user.content as LlmContentPart[]
    // 只有小图注入；大图（伪造 size=1）在读取时被磁盘事实拦截、降级为文本占位
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1)
    const text = parts.find((p) => p.type === 'text') as { type: 'text'; text: string }
    expect(text.text).toContain('big.png')
  })
})
