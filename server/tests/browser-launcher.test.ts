/**
 * 浏览器启动器回归（M22）：DevToolsActivePort 残留导致的「假端点」问题。
 *
 * 场景：上次 Chrome 被强杀（文件不清理）→ 专用 Profile 目录残留 DevToolsActivePort（过期端口）；
 * 再次启动时新实例尚未覆写文件，若启动器直接返回文件里的端点，界面会以
 * `CDP 连接失败：connect ECONNREFUSED 127.0.0.1:<旧端口>` 收场。
 * 修复约束：spawn 前清理残留文件 + waitForEndpoint 必须 /json/version 探测通过才返回（失败继续等待）。
 *
 * 用「假浏览器」脚本（延迟写端口文件后保持存活）驱动真实 launchBrowser 全链路，不依赖本机安装 Chrome。
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { killLaunchedBrowser, launchBrowser, type LaunchResult } from '../src/browser/launcher.js'

const unixOnly = process.platform === 'win32' ? describe.skip : describe

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

unixOnly('M22：浏览器启动器（本地持久 Profile 残留端口自愈）', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn()
  })

  it('残留端点指向死端口时：等待新实例覆写并返回真实可达的端点', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-launcher-'))
    const profileDir = path.join(root, 'local')
    fs.mkdirSync(profileDir, { recursive: true })
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))

    // 死端口：先占住再释放，保证当前不可达（模拟被强杀的旧实例）
    const deadProbe = http.createServer()
    const deadPort = await listen(deadProbe)
    await close(deadProbe)

    // 新实例的「真实」端点：本地 HTTP 服务提供 /json/version
    let livePort = 0
    const live = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            Browser: 'FakeChrome/1.0',
            webSocketDebuggerUrl: `ws://127.0.0.1:${livePort}/devtools/browser/fake-id`,
          }),
        )
        return
      }
      res.statusCode = 404
      res.end()
    })
    livePort = await listen(live)
    cleanups.push(() => close(live))

    // 模拟上次运行残留：端口文件存在但指向死端口
    fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), `${deadPort}\n/devtools/browser/stale-id`)

    // 假浏览器：延迟写端口文件（复刻新实例覆写前的空窗），随后保持存活
    const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const arg = process.argv.find((a) => a.startsWith('--user-data-dir='))
if (!arg) process.exit(1)
const dir = arg.slice('--user-data-dir='.length)
setTimeout(() => {
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '${livePort}\\n/devtools/browser/fake-id')
}, 400)
setInterval(() => {}, 1000)
`
    const exe = path.join(root, 'fake-chrome')
    fs.writeFileSync(exe, script)
    fs.chmodSync(exe, 0o755)

    const result: LaunchResult = await launchBrowser({
      backend: 'local',
      profileRoot: root,
      executable: exe,
      timeoutMs: 8_000,
    })
    cleanups.push(() => killLaunchedBrowser(result.child))

    // 返回的必须是存活端点，而不是残留文件里的死端口
    expect(result.external).toBe(false)
    expect(result.endpoint).toBe(`ws://127.0.0.1:${livePort}/devtools/browser/fake-id`)
    expect(result.endpoint).not.toContain(String(deadPort))
  })

  it('复用探测失败后不误读残留文件：残留文件在启动前被清理', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-launcher-'))
    const profileDir = path.join(root, 'local')
    fs.mkdirSync(profileDir, { recursive: true })
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))

    const deadProbe = http.createServer()
    const deadPort = await listen(deadProbe)
    await close(deadProbe)
    fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), `${deadPort}\n/devtools/browser/stale-id`)

    // 假浏览器：本次不写端口文件、直接保持存活 → 启动器应等待超时并以明确错误收场
    const script = `#!/usr/bin/env node
setInterval(() => {}, 1000)
`
    const exe = path.join(root, 'fake-chrome')
    fs.writeFileSync(exe, script)
    fs.chmodSync(exe, 0o755)

    await expect(
      launchBrowser({ backend: 'local', profileRoot: root, executable: exe, timeoutMs: 1_500 }),
    ).rejects.toThrow(/调试端口未就绪/)

    // 残留文件已被清理（不会再被后续运行误读）
    expect(fs.existsSync(path.join(profileDir, 'DevToolsActivePort'))).toBe(false)
  })
})
