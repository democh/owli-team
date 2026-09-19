/**
 * E2E · M31 修订：Agent ↔ 画布联动——
 * 1) 全周期落位与写入反馈：创建媒体任务 → 服务端落占位（画布上出现节点）+ 写入闪环（.canvas-agent-flash）；
 *    在对话页创建 → 画布页签角标出现（切回画布清零）；
 * 2) 预置渲染：agent 写入节点（by）显示作者徽标；pending 占位节点呼吸 + 进度文案；指向占位的 flow 边能量流动。
 *
 * 说明：媒体任务走 REST 创建（comfyui 指向不可达端口 → 任务快速失败，但「创建落占位 + 广播」链路完整）；
 * 自建媒体连接用后即删（幂等可重跑）；数据目录与 main 链路共用 e2e-main（无媒体连接时自清理）。
 */
import { expect, test, type Page } from '@playwright/test'
import net from 'node:net'
import { createSession, openApp, switchMainTab } from './helpers'

/** 删除全部媒体连接（前置清场；保证「无残留连接」起点） */
async function removeMediaConnections(page: Page): Promise<void> {
  const res = await page.request.get('/api/connections')
  const body = (await res.json()) as { connections: Array<{ id: string; kind: string }> }
  for (const c of body.connections.filter((x) => x.kind === 'media')) {
    await page.request.delete(`/api/connections/${c.id}`)
  }
}

/** 黑孔 HTTP 服务（接受 TCP 连接但永不响应）——让媒体任务稳定挂起（pending 窗口充足，从「快速失败」的不确定性中解耦） */
async function startBlackhole(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    // 接受连接，不读不写：请求方挂起
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    // 必须先 destroy 已建立的连接：server.close 只停止接受新连接，挂起连接会让回调永不触发（用例超时）
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.close(() => resolve())
      }),
  }
}

/** 建一条指向黑孔的媒体连接（任务创建即落占位，运行必然挂起——链路验证不需要真实出图） */
async function createHangingMediaConnection(page: Page, port: number): Promise<string> {
  const res = await page.request.post('/api/connections', {
    data: {
      name: `E2E 画布联动-${Date.now()}`,
      kind: 'media',
      enabled: true,
      config: {
        provider: 'comfyui',
        baseUrl: `http://127.0.0.1:${port}`,
        capabilities: ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'],
        // defaultModel 必填：comfyui 内置工作流引用 {{model}}，未配置会在提交前直接失败（不走网络）
        defaultModel: 'flux-dev',
        timeoutMs: 60_000, // 挂起窗口 60s：足够页面 reload + 断言，测试结束随服务一并回收
      },
    },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { connection: { id: string } }).connection.id
}

/** 现会话 id（按唯一标题反查） */
async function sessionIdOf(page: Page, title: string): Promise<string> {
  const list = (await (await page.request.get('/api/sessions')).json()) as { sessions: { id: string; title: string }[] }
  const sid = list.sessions.find((s) => s.title === title)?.id
  expect(sid).toBeTruthy()
  return sid!
}

/** 创建媒体任务（返回任务 id） */
async function createJob(page: Page, sid: string, prompt: string, canvasTarget: { x: number; y: number }): Promise<string> {
  const res = await page.request.post(`/api/sessions/${sid}/media/jobs`, {
    data: { capability: 'text2image', prompt, canvasTarget },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { job: { id: string } }).job.id
}

test('联动 · 落位与写入反馈：任务创建 → 占位节点 + 写入闪环；对话页创建 → 画布页签角标', async ({ page }) => {
  await openApp(page)
  await removeMediaConnections(page) // 清场
  const blackhole = await startBlackhole()
  let connectionId: string | undefined
  try {
    connectionId = await createHangingMediaConnection(page, blackhole.port)
    await page.reload()
    await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 15_000 })

    const title = `E2E-M31LINK-落位-${Date.now()}`
    await createSession(page, { title })
    await switchMainTab(page, '画布')
    await expect(page.locator('.react-flow__pane')).toBeVisible({ timeout: 15_000 })
    const sid = await sessionIdOf(page, title)

    // 1) 画布打开态创建任务：服务端落占位 → 闪环 + 画布出现 image 节点（黑孔挂起 → pending 窗口充足）
    await createJob(page, sid, 'E2E 占位图', { x: 120, y: 120 })
    await expect(page.locator('.canvas-agent-flash').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.react-flow__node-image').first()).toBeVisible({ timeout: 15_000 })

    // 2) 切到对话页再创建：画布页签出现未读角标（同会话、非画布页）
    await switchMainTab(page, '对话')
    await createJob(page, sid, 'E2E 后台占位', { x: 200, y: 120 })
    const badge = page.getByTitle('Agent 在画布上有新写入')
    await expect(badge).toBeVisible({ timeout: 15_000 })

    // 3) 切回画布：角标清零
    await switchMainTab(page, '画布')
    await expect(page.getByTitle('Agent 在画布上有新写入')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.locator('.react-flow__node-image').nth(1)).toBeVisible({ timeout: 15_000 })
  } finally {
    if (connectionId) await page.request.delete(`/api/connections/${connectionId}`)
    await blackhole.close()
  }
})

test('联动 · 预置渲染：作者徽标 / pending 呼吸占位（真实挂起任务）/ 能量流动边', async ({ page }) => {
  await openApp(page)
  await removeMediaConnections(page)
  const blackhole = await startBlackhole()
  let connectionId: string | undefined
  try {
    connectionId = await createHangingMediaConnection(page, blackhole.port)
    await page.reload()
    await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 15_000 })

    const title = `E2E-M31LINK-渲染-${Date.now()}`
    await createSession(page, { title })
    const sid = await sessionIdOf(page, title)

    // 1) 真实挂起任务 → 服务端落占位（jobId 在任务快照中 → 自愈不触发，pending 保持呼吸）
    const jobId = await createJob(page, sid, '一只猫', { x: 460, y: 280 })
    const jobsRes = (await (await page.request.get(`/api/sessions/${sid}/media/jobs`)).json()) as {
      jobs: Array<{ id: string; canvasNodeId?: string }>
    }
    const nodeId = jobsRes.jobs.find((j) => j.id === jobId)?.canvasNodeId
    expect(nodeId).toBeTruthy()

    // 2) 在现有文档（含占位节点）上补：by 节点 + prompt 节点 + 指向占位的 flow 边
    const cur = (await (await page.request.get(`/api/sessions/${sid}/canvas`)).json()) as {
      doc: { version: number; nodes: Array<{ id: string }> }
    }
    await page.request.put(`/api/sessions/${sid}/canvas`, {
      data: {
        baseVersion: cur.doc.version,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          ...cur.doc.nodes, // 含占位节点（pending）
          {
            id: 'nd_agent',
            type: 'note',
            position: { x: 80, y: 60 },
            width: 220,
            height: 140,
            by: 'architect',
            data: { text: '艾达的草稿', accent: 'sky' },
          },
          { id: 'nd_src', type: 'prompt', position: { x: 80, y: 280 }, width: 260, height: 150, data: { text: '一只猫', negative: '' } },
        ],
        edges: [{ id: 'ed_flow', source: 'nd_src', target: nodeId, kind: 'flow' }],
      },
    })

    await page.reload()
    await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 15_000 })
    await switchMainTab(page, '画布')

    const agent = page.locator('.react-flow__node[data-id="nd_agent"]')
    const pending = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
    await expect(agent).toBeVisible({ timeout: 15_000 })
    await expect(pending).toBeVisible({ timeout: 15_000 })

    // 作者徽标（by='architect' → 艾达）
    await expect(agent.locator('[title*="由「艾达」写入"]')).toBeVisible()

    // pending 占位：呼吸 + 实时进度文案（黑孔挂起 → 任务在快照中保持运行态）
    await expect(pending.locator('.canvas-breath')).toBeVisible()
    await expect(pending.getByText(/生成中|排队中/)).toBeVisible()

    // 指向 pending 的 flow 边能量流动
    await expect(page.locator('.react-flow__edge .canvas-edge-energy-live')).toHaveCount(1, { timeout: 10_000 })
  } finally {
    if (connectionId) await page.request.delete(`/api/connections/${connectionId}`)
    await blackhole.close()
  }
})

test('联动 · 僵尸占位自愈（M31 修订）：任务已丢失的 pending 节点 → 打开画布自动转中断态', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M31LINK-自愈-${Date.now()}`
  await createSession(page, { title })
  const sid = await sessionIdOf(page, title)
  const cur = (await (await page.request.get(`/api/sessions/${sid}/canvas`)).json()) as { doc: { version: number } }
  await page.request.put(`/api/sessions/${sid}/canvas`, {
    data: {
      baseVersion: cur.doc.version,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'nd_zombie',
          type: 'image',
          position: { x: 100, y: 100 },
          width: 280,
          height: 200,
          // jobId 不存在于任务快照（服务端重启 / 历史清理场景）
          data: { pending: true, jobId: 'mj_gone', prompt: '失去联系的任务' },
        },
      ],
      edges: [],
    },
  })
  await page.reload() // store 同会话跳过重拉：reload 强制加载预置文档
  await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 15_000 })
  await switchMainTab(page, '画布')

  const node = page.locator('.react-flow__node[data-id="nd_zombie"]')
  await expect(node).toBeVisible({ timeout: 15_000 })
  // 任务快照拉取（该环境该会话无任务）→ 自愈标记中断：呼吸停止 + error 文案
  await expect(node.getByText('生成中断')).toBeVisible({ timeout: 15_000 })
  await expect(node.locator('.canvas-breath')).toHaveCount(0)
})
