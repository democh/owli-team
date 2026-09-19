/**
 * M34 Python 桥测试：
 * - probe：探测输出解析 / 状态分档 / 无解释器降级（纯函数 + 真实 spawn）；
 * - runner：协议往返 / 错误码映射 / 超时 kill / 非 JSON 容错 / 并发串行（真实 spawn fake 脚本）；
 * - env：环境净化（不透传密钥）；
 * - 真脚本冒烟：fin_bridge.py capabilities（无三方包环境仍正常协议输出）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sanitizedEnv } from '../src/finance/bridge/env.js'
import {
  buildStatus,
  parseProbeJson,
  probePython,
  resetProbeCache,
  type RawProbe,
} from '../src/finance/bridge/probe.js'
import {
  DEFAULT_BRIDGE_SCRIPT,
  parseBridgeOutput,
  runBridge,
} from '../src/finance/bridge/runner.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FAKE_BRIDGE = path.join(HERE, 'fixtures', 'finance', 'fake_bridge.py')

/** 本机 python3（缺失时跳过需要真实 spawn 的用例） */
let python = ''
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' })
  python = 'python3'
} catch {
  python = ''
}
const maybeDescribe = python ? describe : describe.skip

function rawProbe(overrides: Partial<RawProbe> = {}): RawProbe {
  return {
    python: '/usr/bin/python3',
    version: '3.12.4',
    packages: {
      baostock: { installed: true, version: '0.8.9' },
      akshare: { installed: true, version: '1.14.0' },
      pandas: { installed: true, version: '2.2.3' },
      ta: { installed: true, version: '0.11.0' },
      tablib: { installed: true, version: '3.7.0' },
      openpyxl: { installed: true, version: '3.1.5' },
      curl_cffi: { installed: true, version: '0.7.4' },
    },
    ...overrides,
  }
}

describe('M34 Python 桥：环境净化', () => {
  it('sanitizedEnv：白名单透传 + 强制 UTF-8 / 北京时间 + 不透传密钥', () => {
    process.env.TEST_SECRET_API_KEY = 'sk-should-not-leak'
    try {
      const env = sanitizedEnv()
      expect(env.PYTHONIOENCODING).toBe('utf-8')
      expect(env.PYTHONUNBUFFERED).toBe('1')
      expect(env.TZ).toBe('Asia/Shanghai')
      expect(env.TEST_SECRET_API_KEY).toBeUndefined()
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      delete process.env.TEST_SECRET_API_KEY
    }
  })
})

describe('M34 Python 桥：探测解析与分档（纯函数）', () => {
  it('parseProbeJson：合法输出解析 / 非 JSON 与缺字段拒绝', () => {
    const parsed = parseProbeJson(
      '{"python":"/usr/bin/python3","version":"3.12.4","packages":{"ta":{"installed":true,"version":"0.11.0"}}}',
    )
    expect(parsed?.python).toBe('/usr/bin/python3')
    expect(parsed?.packages.ta).toEqual({ installed: true, version: '0.11.0' })
    expect(parseProbeJson('not json')).toBeNull()
    expect(parseProbeJson('{"python":"x"}')).toBeNull()
    expect(parseProbeJson('{"python":"x","version":"3.12","packages":null}')).toBeNull()
  })

  it('buildStatus：三档判定（ready / partial / absent）与缺失清单', () => {
    const ready = buildStatus(rawProbe())
    expect(ready.level).toBe('ready')
    expect(ready.missing).toEqual([])
    expect(ready.summary).toContain('就绪')

    const partial = buildStatus(
      rawProbe({ packages: { ...rawProbe().packages, ta: { installed: false }, tablib: { installed: false } } }),
    )
    expect(partial.level).toBe('partial')
    expect(partial.missing).toEqual(['ta', 'tablib'])
    expect(partial.summary).toContain('ta')

    const absent = buildStatus({
      python: 'x',
      version: '3.12',
      packages: { baostock: { installed: false }, akshare: { installed: false } },
    })
    expect(absent.level).toBe('absent')
    expect(absent.missing).toHaveLength(5)
  })

  it('probePython：显式指定不存在的解释器 → absent 降级（不退候选）', async () => {
    resetProbeCache()
    const status = await probePython({ python: '/nonexistent/python-xyz', force: true, timeoutMs: 5_000 })
    expect(status.level).toBe('absent')
    expect(status.python).toBeUndefined()
    expect(status.summary).toContain('Node 数据源')
  })
})

maybeDescribe('M34 Python 桥：runner 协议（真实 spawn 假桥）', () => {
  it('echo：stdin 参数往返 + data 返回 + 耗时', async () => {
    const res = await runBridge<{ params: unknown }>('echo', { a: 1, s: '中文' }, { python, scriptPath: FAKE_BRIDGE })
    expect(res.data.params).toEqual({ a: 1, s: '中文' })
    expect(res.ms).toBeGreaterThanOrEqual(0)
  })

  it('错误码映射：DEP_MISSING / LOGIN_FAIL / BAD_PARAM / 未知码归一', async () => {
    await expect(runBridge('err_dep', {}, { python, scriptPath: FAKE_BRIDGE })).rejects.toMatchObject({
      name: 'BridgeError',
      code: 'DEP_MISSING',
    })
    await expect(runBridge('err_login', {}, { python, scriptPath: FAKE_BRIDGE })).rejects.toMatchObject({
      code: 'LOGIN_FAIL',
      detail: '网络不可达',
    })
    await expect(runBridge('unknown-task', {}, { python, scriptPath: FAKE_BRIDGE })).rejects.toMatchObject({
      code: 'BAD_PARAM',
    })
    await expect(runBridge('err_unknown_code', {}, { python, scriptPath: FAKE_BRIDGE })).rejects.toMatchObject({
      code: 'BRIDGE_ERROR',
    })
  })

  it('非 JSON 输出 → BRIDGE_ERROR', async () => {
    await expect(runBridge('garbage', {}, { python, scriptPath: FAKE_BRIDGE })).rejects.toMatchObject({
      code: 'BRIDGE_ERROR',
    })
  })

  it('超时 → kill 子进程 + TIMEOUT', async () => {
    const started = Date.now()
    await expect(runBridge('sleep', {}, { python, scriptPath: FAKE_BRIDGE, timeoutMs: 600 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('解释器不存在 → NO_PYTHON', async () => {
    await expect(
      runBridge('echo', {}, { python: '/nonexistent/python-xyz', scriptPath: FAKE_BRIDGE }),
    ).rejects.toMatchObject({ code: 'NO_PYTHON' })
  })

  it('并发调用串行执行（信号量 1，两个 150ms 任务 ≥ 280ms）', async () => {
    const started = Date.now()
    await Promise.all([
      runBridge('tick', {}, { python, scriptPath: FAKE_BRIDGE }),
      runBridge('tick', {}, { python, scriptPath: FAKE_BRIDGE }),
    ])
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
  })
})

describe('M34 Python 桥：输出协议解析（纯函数）', () => {
  it('parseBridgeOutput：成功 / 错误 / 杂质文本容错 / 垃圾拒绝', () => {
    expect(parseBridgeOutput('{"ok":true,"data":[1,2]}')).toMatchObject({ ok: true, data: [1, 2] })
    expect(
      parseBridgeOutput('log line\n{"ok":false,"code":"LOGIN_FAIL","message":"登录失败"}\n'),
    ).toMatchObject({ ok: false, code: 'LOGIN_FAIL', message: '登录失败' })
    expect(parseBridgeOutput('')).toBeNull()
    expect(parseBridgeOutput('not json')).toBeNull()
    expect(parseBridgeOutput('{"data":1}')).toBeNull()
    expect(parseBridgeOutput('{"ok":false,"code":"WEIRD","message":"x"}')).toMatchObject({ code: 'BRIDGE_ERROR' })
  })
})

maybeDescribe('M34 Python 桥：真脚本冒烟（fin_bridge.py）', () => {
  it('capabilities：无三方包环境仍正常协议输出', async () => {
    const res = await runBridge<{ level: string; missing: string[]; packages: Record<string, unknown> }>(
      'capabilities',
      {},
      { python, timeoutMs: 15_000 },
    )
    expect(['absent', 'partial', 'ready']).toContain(res.data.level)
    expect(Array.isArray(res.data.missing)).toBe(true)
    expect(res.data.packages['baostock']).toBeDefined()
    expect(res.data.packages['curl_cffi']).toBeDefined()
  })

  it('未知任务 → BAD_PARAM（真脚本白名单校验）', async () => {
    await expect(runBridge('no_such_task', {}, { python, timeoutMs: 15_000 })).rejects.toMatchObject({
      code: 'BAD_PARAM',
    })
  })

  it('kline 字段白名单：time 仅分钟线（防「指标参数传入错误:time」回归）', () => {
    // 真脚本模块导入（仅 stdlib 依赖，不触网）：直接校验字段选择纯函数与窗口表
    const script = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location('fin_bridge', ${JSON.stringify(DEFAULT_BRIDGE_SCRIPT)})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'print(json.dumps({',
      "    'd': mod.bs_kline_fields('d'),",
      "    'w': mod.bs_kline_fields('w'),",
      "    'm': mod.bs_kline_fields('m'),",
      "    'min5': mod.bs_kline_fields('5'),",
      "    'min60': mod.bs_kline_fields('60'),",
      "    'windows': sorted(mod._BS_WINDOW_DAYS),",
      "    'akWindows': sorted(mod._AK_WINDOW_DAYS),",
      '}))',
    ].join('\n')
    const out = execFileSync(python, ['-c', script], { encoding: 'utf8' })
    const line = out
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('{'))
    const res = JSON.parse(line!) as {
      d: string
      w: string
      m: string
      min5: string
      min60: string
      windows: string[]
      akWindows: string[]
    }
    // 日/周/月线不得含 time（baostock 服务端 10004012 报错）；分钟线必须含 time
    expect(res.d).toBe('date,code,open,high,low,close,volume,amount')
    expect(res.w).not.toContain('time')
    expect(res.m).not.toContain('time')
    expect(res.min5).toContain('date,time,')
    expect(res.min60).toContain('time')
    // 日/周/月取数窗口齐备（月线需足够长以覆盖 limit 上限）
    expect(res.windows).toEqual(['d', 'm', 'w'])
    expect(res.akWindows).toEqual(['daily', 'monthly', 'weekly'])
  })

  it('默认脚本路径存在（dev 态 src/finance/bridge/py/）', () => {
    expect(DEFAULT_BRIDGE_SCRIPT.endsWith(path.join('bridge', 'py', 'fin_bridge.py'))).toBe(true)
    expect(fs.existsSync(DEFAULT_BRIDGE_SCRIPT)).toBe(true)
  })
})
