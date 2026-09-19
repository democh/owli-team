/**
 * 业务工具集测试（M21.2）：calc / date_calc / csv_analyze / template_fill。
 * 覆盖：正常路径 / 异常路径 / 安全路径（越界 / 敏感文件）/ 纯函数单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { evaluateExpression } from '../src/tools/calc.js'
import { parseDelimited } from '../src/tools/csv_analyze.js'
import { addMonths, fmtDate, parseDate } from '../src/tools/date_calc.js'
import { renderTemplate } from '../src/tools/template_fill.js'
import type { ToolRuntime, TodoItem } from '../src/tools/registry.js'
import { makeTmpDir } from './helpers.js'

function makeRuntime(): { registry: ReturnType<typeof createToolRegistry>; runtime: ToolRuntime; workspace: string } {
  const cfg = loadConfig()
  const artifacts = new ArtifactStore(makeTmpDir('ma-art-'))
  const sessionId = 's1'
  const workspace = artifacts.ensureSessionDir(sessionId)
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(path.join(makeTmpDir('ma-db-'), 'app.db'))
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    sessionId,
    '测试会话',
    JSON.stringify(['finance']),
    now,
    now,
  )
  const todos: TodoItem[] = []
  const runtime: ToolRuntime = {
    sessionId,
    runId: 'r1',
    agentId: 'finance',
    workspace,
    artifacts,
    skills,
    memory: new MemoryStore(db),
    tasks: new TaskStore(db),
    participants: [{ id: 'finance', name: '周正' }],
    todos,
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webFetchAllowedDomains: [],
    webSearch: { enabled: false, apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: () => ({ ok: false, error: '未启用' }),
  }
  return { registry: createToolRegistry(cfg), runtime, workspace }
}

describe('M21.2 工具注册', () => {
  it('四个业务工具均已注册且元信息完整', () => {
    const { registry } = makeRuntime()
    for (const name of ['calc', 'date_calc', 'csv_analyze', 'template_fill']) {
      const tool = registry.get(name)
      expect(tool, name).toBeTruthy()
      expect(tool?.description.length).toBeGreaterThan(10)
    }
    // 只读标记：前三个只读，template_fill 写类
    expect(registry.isReadOnly('calc')).toBe(true)
    expect(registry.isReadOnly('date_calc')).toBe(true)
    expect(registry.isReadOnly('csv_analyze')).toBe(true)
    expect(registry.isReadOnly('template_fill')).toBe(false)
  })
})

describe('calc 纯函数求值', () => {
  it('四则 / 括号 / 乘方 / 优先级', () => {
    expect(evaluateExpression('(1200-800)/1200')).toMatchObject({ ok: true, value: 1 / 3 })
    expect(evaluateExpression('2 + 3 * 4')).toMatchObject({ ok: true, value: 14 })
    expect(evaluateExpression('2 ^ 3 ^ 2')).toMatchObject({ ok: true, value: 512 }) // 右结合
    expect(evaluateExpression('-5 + 3')).toMatchObject({ ok: true, value: -2 })
  })

  it('业务函数：毛利 / CAGR / 月供 / 盈亏平衡 / 税后', () => {
    const margin = evaluateExpression('gross_margin(1200, 800)')
    expect(margin.ok && margin.value).toBeCloseTo(1 / 3, 10)
    const cagr = evaluateExpression('cagr(100, 121, 2)')
    expect(cagr.ok && cagr.value).toBeCloseTo(0.1, 10)
    const payment = evaluateExpression('loan_payment(100000, 0.06, 12)')
    expect(payment.ok && payment.value).toBeCloseTo(8606.64, 1)
    const be = evaluateExpression('breakeven(5000, 50, 30)')
    expect(be.ok && be.value).toBe(250)
    expect(evaluateExpression('net_after_tax(10000, 0.2)')).toMatchObject({ ok: true, value: 8000 })
  })

  it('npv / irr：现金流数组（含负数）', () => {
    const npv = evaluateExpression('npv(0.1, [-10000, 3000, 4000, 5000])')
    const expected = -10000 + 3000 / 1.1 + 4000 / 1.21 + 5000 / 1.331
    expect(npv.ok && npv.value).toBeCloseTo(expected, 8)
    const irr = evaluateExpression('irr([-1000, 500, 500, 500])')
    expect(irr.ok).toBe(true)
    if (irr.ok) expect(irr.value).toBeGreaterThan(0.2)
    if (irr.ok) expect(irr.value).toBeLessThan(0.26)
  })

  it('数组聚合：sum / avg / min / max 支持展开与数组两种形式', () => {
    expect(evaluateExpression('sum(1, 2, 3)')).toMatchObject({ ok: true, value: 6 })
    expect(evaluateExpression('sum([1, 2, 3])')).toMatchObject({ ok: true, value: 6 })
    expect(evaluateExpression('avg([10, 20, 30])')).toMatchObject({ ok: true, value: 20 })
    expect(evaluateExpression('max(3, 9, 4)')).toMatchObject({ ok: true, value: 9 })
  })

  it('函数轨迹（detail 过程）非空', () => {
    const outcome = evaluateExpression('gross_margin(1200, 800)')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.trace.join('\n')).toContain('gross_margin(1200, 800)')
  })

  it('异常：除零 / 未知函数 / 语法 / 参数数量 / IRR 无解', () => {
    expect(evaluateExpression('1/0')).toMatchObject({ ok: false })
    expect((evaluateExpression('1/0') as { error: string }).error).toContain('除数为零')
    const unknown = evaluateExpression('foo(1)')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('未知函数')
    expect(evaluateExpression('1 +')).toMatchObject({ ok: false })
    expect(evaluateExpression('(1 + 2')).toMatchObject({ ok: false })
    expect(evaluateExpression('round(1, 2, 3)')).toMatchObject({ ok: false })
    // 参数个数 / 顺序错误 → 错误附函数签名（usage），模型可按签名一步纠正
    const wrongCount = evaluateExpression('breakeven(5000, 50)')
    expect(wrongCount.ok).toBe(false)
    if (!wrongCount.ok) {
      expect(wrongCount.error).toContain('需要 3 个数字参数')
      expect(wrongCount.error).toContain('用法：breakeven(固定成本, 单价, 单位变动成本)')
    }
    const noIrr = evaluateExpression('irr([100, 200, 300])')
    expect(noIrr.ok).toBe(false)
  })

  it('工具入口：成功返回摘要与求值过程；失败返回中文错误', async () => {
    const { registry, runtime } = makeRuntime()
    const ok = await registry.execute('calc', { expression: 'gross_margin(1200, 800)' }, runtime)
    expect(ok.ok).toBe(true)
    expect(ok.summary.startsWith('= ')).toBe(true)
    expect(ok.detail).toContain('求值过程')
    const bad = await registry.execute('calc', { expression: '1/0' }, runtime)
    expect(bad.ok).toBe(false)
    expect(bad.summary).toContain('除数为零')
    // 工具卡（summary）：函数签名提示直达 UI 与模型
    const wrongCount = await registry.execute('calc', { expression: 'breakeven(5000, 50)' }, runtime)
    expect(wrongCount.ok).toBe(false)
    expect(wrongCount.summary).toContain('用法：breakeven(固定成本, 单价, 单位变动成本)')
  })
})

describe('date_calc 纯函数与工具', () => {
  it('add：天 / 月（月末对齐）/ 闰年 / 工作日', async () => {
    const { registry, runtime } = makeRuntime()
    const days = await registry.execute('date_calc', { op: 'add', base: '2025-04-14', amount: 7 }, runtime)
    expect(days.ok).toBe(true)
    expect(days.summary).toContain('2025-04-21（周一）')
    // 月末对齐：1-31 + 1 月 → 2-28
    expect(fmtDate(addMonths(parseDate('2025-01-31'), 1))).toContain('2025-02-28')
    // 闰年 2-29 + 1 年 → 2-28
    expect(fmtDate(addMonths(parseDate('2024-02-29'), 12))).toContain('2025-02-28')
    const biz = await registry.execute(
      'date_calc',
      { op: 'add', base: '2025-04-17', amount: 3, unit: 'business-day' },
      runtime,
    )
    expect(biz.ok).toBe(true)
    expect(biz.summary).toContain('2025-04-22（周二）')
  })

  it('diff：自然日 + 工作日', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('date_calc', { op: 'diff', base: '2025-04-14', to: '2025-04-21' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('7 自然日')
    expect(result.summary).toContain('5 工作日')
  })

  it('list：跳周末排期', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute(
      'date_calc',
      { op: 'list', base: '2025-04-18', count: 4, skip_weekends: true },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('2025-04-18（周五）')
    expect(result.detail).toContain('2025-04-21（周一）')
    expect(result.detail).not.toContain('2025-04-19')
  })

  it('period：周 / 月 / 季 / 年起止', async () => {
    const { registry, runtime } = makeRuntime()
    const week = await registry.execute('date_calc', { op: 'period', base: '2025-04-17', unit: 'week' }, runtime)
    expect(week.ok).toBe(true)
    expect(week.summary).toContain('2025-04-14（周一）')
    expect(week.summary).toContain('2025-04-20（周日）')
    const quarter = await registry.execute('date_calc', { op: 'period', base: '2025-05-10', unit: 'quarter' }, runtime)
    expect(quarter.ok).toBe(true)
    expect(quarter.summary).toContain('2025-04-01')
    expect(quarter.summary).toContain('2025-06-30')
    const year = await registry.execute('date_calc', { op: 'period', base: '2025-05-10', unit: 'year' }, runtime)
    expect(year.ok).toBe(true)
    expect(year.summary).toContain('2025-12-31')
  })

  it('异常：非法日期 / 缺参数', async () => {
    const { registry, runtime } = makeRuntime()
    expect((await registry.execute('date_calc', { op: 'add', base: '2025-02-30', amount: 1 }, runtime)).ok).toBe(false)
    expect((await registry.execute('date_calc', { op: 'add', base: '2025-04-01' }, runtime)).ok).toBe(false)
    expect((await registry.execute('date_calc', { op: 'diff', base: '2025-04-01' }, runtime)).ok).toBe(false)
    expect(
      (await registry.execute('date_calc', { op: 'period', base: '2025-04-01', unit: 'day' }, runtime)).ok,
    ).toBe(false)
  })
})

describe('csv_analyze 解析与工具', () => {
  const CSV = [
    '名称,渠道,金额,日期',
    '甲,抖音,100,2025-01-01',
    '乙,微信,200,2025-01-02',
    '"丙,有限公司",抖音,1000,2025-01-03',
    '丁,微信,300,2025-01-04',
    '戊,抖音,,2025-01-05',
  ].join('\n')

  async function withCsv(): Promise<ReturnType<typeof makeRuntime>> {
    const env = makeRuntime()
    await env.registry.execute('write_file', { path: 'data/流水.csv', content: CSV }, env.runtime)
    return env
  }

  it('parseDelimited：引号 / 转义 / CRLF / BOM', () => {
    expect(parseDelimited('"a,b",c\r\n1,2\r\n', ',')).toEqual([
      ['a,b', 'c'],
      ['1', '2'],
    ])
    expect(parseDelimited('"x""y",z\n', ',')).toEqual([['x"y', 'z']])
    expect(parseDelimited('\uFEFFa,b\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('head / describe：预览与列统计（数值列含合计）', async () => {
    const { registry, runtime } = await withCsv()
    const head = await registry.execute('csv_analyze', { path: 'data/流水.csv', op: 'head', limit: 2 }, runtime)
    expect(head.ok).toBe(true)
    expect(head.detail).toContain('名称')
    expect(head.summary).toContain('4 列 × 5 行')
    const desc = await registry.execute('csv_analyze', { path: 'data/流水.csv', op: 'describe' }, runtime)
    expect(desc.ok).toBe(true)
    expect(desc.detail).toContain('1600') // 金额合计 100+200+1000+300
    expect(desc.detail).toContain('400') // 平均值 1600/4（空值跳过）
  })

  it('groupby：sum 聚合降序', async () => {
    const { registry, runtime } = await withCsv()
    const result = await registry.execute(
      'csv_analyze',
      { path: 'data/流水.csv', op: 'groupby', by: '渠道', agg: 'sum:金额' },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect((result.detail ?? '').indexOf('抖音')).toBeLessThan((result.detail ?? '').indexOf('微信'))
    expect(result.detail).toContain('1100')
  })

  it('sort：数值列降序 / 文本列', async () => {
    const { registry, runtime } = await withCsv()
    const result = await registry.execute(
      'csv_analyze',
      { path: 'data/流水.csv', op: 'sort', column: '金额', order: 'desc', limit: 2 },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('1000')
    expect((result.detail ?? '').indexOf('1000')).toBeLessThan((result.detail ?? '').indexOf('300'))
  })

  it('filter：数值比较 / 包含 / 空值不误配', async () => {
    const { registry, runtime } = await withCsv()
    const byAmount = await registry.execute(
      'csv_analyze',
      { path: 'data/流水.csv', op: 'filter', where: '金额 > 150' },
      runtime,
    )
    expect(byAmount.ok).toBe(true)
    expect(byAmount.summary).toContain('3 / 5')
    const contains = await registry.execute(
      'csv_analyze',
      { path: 'data/流水.csv', op: 'filter', where: '渠道 ~ 抖' },
      runtime,
    )
    expect(contains.ok).toBe(true)
    expect(contains.summary).toContain('3 / 5')
  })

  it('异常与安全：列不存在 / 文件不存在 / 越界 / 敏感文件 / 语法错误', async () => {
    const { registry, runtime, workspace } = await withCsv()
    expect(
      (await registry.execute('csv_analyze', { path: 'data/流水.csv', op: 'sort', column: '不存在' }, runtime)).ok,
    ).toBe(false)
    expect((await registry.execute('csv_analyze', { path: 'data/none.csv', op: 'head' }, runtime)).ok).toBe(false)
    expect((await registry.execute('csv_analyze', { path: '../evil.csv', op: 'head' }, runtime)).ok).toBe(false)
    expect(
      (await registry.execute('csv_analyze', { path: 'data/流水.csv', op: 'filter', where: '金额 ?? 1' }, runtime)).ok,
    ).toBe(false)
    fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1\n')
    const sensitive = await registry.execute('csv_analyze', { path: '.env', op: 'head' }, runtime)
    expect(sensitive.ok).toBe(false)
    expect(sensitive.summary).toContain('敏感文件')
  })
})

describe('template_fill 渲染与落盘', () => {
  const TEMPLATE = '# 报价单\n\n客户：{{客户.名称}}\n金额：{{金额}} 元\n备注：{{备注}}\n'

  it('renderTemplate 纯函数：替换 / 缺失 / 非法值', () => {
    const ok = renderTemplate('a={{a}}, b={{b.c}}', { a: 1, b: { c: 'x' } })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.rendered).toBe('a=1, b=x')
    const missing = renderTemplate('{{nope}}', {})
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.missing).toContain('nope')
    const invalid = renderTemplate('{{obj}}', { obj: { x: 1 } })
    expect(invalid.ok).toBe(false)
    const leftover = renderTemplate('{{bad name}}', {})
    expect(leftover.ok).toBe(false)
  })

  it('成功路径：渲染落盘 + artifacts 标记', async () => {
    const { registry, runtime, workspace } = makeRuntime()
    await registry.execute('write_file', { path: 'templates/报价单.md', content: TEMPLATE }, runtime)
    const result = await registry.execute(
      'template_fill',
      {
        template: 'templates/报价单.md',
        data: { 客户: { 名称: '某某公司' }, 金额: 1200, 备注: '含税' },
        output: 'docs/报价单-某某.md',
      },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.artifacts).toEqual(['docs/报价单-某某.md'])
    const written = fs.readFileSync(path.join(workspace, 'docs/报价单-某某.md'), 'utf8')
    expect(written).toContain('客户：某某公司')
    expect(written).toContain('金额：1200 元')
  })

  it('缺失变量：汇总报错且不落盘', async () => {
    const { registry, runtime, workspace } = makeRuntime()
    await registry.execute('write_file', { path: 'tpl.md', content: TEMPLATE }, runtime)
    const result = await registry.execute(
      'template_fill',
      { template: 'tpl.md', data: { 客户: { 名称: '甲' } }, output: 'out.md' },
      runtime,
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('缺失变量')
    expect(result.summary).toContain('金额')
    expect(fs.existsSync(path.join(workspace, 'out.md'))).toBe(false)
  })

  it('dry_run：返回预览不落盘', async () => {
    const { registry, runtime, workspace } = makeRuntime()
    await registry.execute('write_file', { path: 'tpl.md', content: TEMPLATE }, runtime)
    const result = await registry.execute(
      'template_fill',
      {
        template: 'tpl.md',
        data: { 客户: { 名称: '甲' }, 金额: 1, 备注: '-' },
        output: 'out.md',
        dry_run: true,
      },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('dry-run')
    expect(result.detail).toContain('客户：甲')
    expect(fs.existsSync(path.join(workspace, 'out.md'))).toBe(false)
  })

  it('安全：模板越界 / 输出越界 / 模板不存在', async () => {
    const { registry, runtime } = makeRuntime()
    expect(
      (await registry.execute('template_fill', { template: '../x.md', data: {}, output: 'o.md' }, runtime)).ok,
    ).toBe(false)
    expect(
      (await registry.execute('template_fill', { template: 't.md', data: {}, output: '../o.md' }, runtime)).ok,
    ).toBe(false)
    const missing = await registry.execute('template_fill', { template: 'nope.md', data: {}, output: 'o.md' }, runtime)
    expect(missing.ok).toBe(false)
    expect(missing.summary).toContain('模板不存在')
  })
})
