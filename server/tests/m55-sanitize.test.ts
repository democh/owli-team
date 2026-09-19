/**
 * M55 模型输出净化测试（§77）：仿写 [工具调用] 块 / 协议标记泄漏剥离与落盘声明提取。
 * 样本取自真实会话（s_a1a972a1：ziwei 编造调用记录 / bazi 协议标记泄漏）。
 */
import { describe, expect, it } from 'vitest'
import { extractDeliveredPaths, sanitizeModelText } from '@multi-agent/shared'

/** 全角竖线经转义拼接：避免源码直写协议标记序列 */
const VB = '\uFF5C'
const dsml = (tag: string): string => `</${VB}${VB}DSML${VB}${VB} ${tag}>`

// ziwei 样本尾部（模型仿写的调用记录块）
const ZIWEI_TAIL = [
  '@用户 请确认**出生时辰**（几点几分，不确定也请说明）。',
  '',
  '[工具调用]',
  '- ziwei_pan({"birth":"1992-08-27 00:00","gender":"male","timezone":"Asia/Shanghai","longitude":116.4,"trueSolarTime":true}) → 紫微排盘完成：土五局，命宫戌，身宫戌（命身同宫），命主禄存，身主天梁',
].join('\n')

// bazi 样本尾部（仿写块 + 协议标记泄漏行）
const BAZI_TAIL = [
  '**落盘**：`docs/八字命盘-今日是否适宜花费大钱.md`。',
  '',
  '[工具调用]',
  '- bazi_pan({"birth":"1992-08-27 00:00","gender":"male"}) → 四柱：壬申 戊申 甲戌 丙子（乾造）',
  '- write_file({"path":"docs/x.md","content":"# 八字命盘","dry_run":true}) → 预览通过（新建文件）',
  dsml('parameter'),
  dsml('invoke'),
  dsml('calls'),
].join('\n')

describe('sanitizeModelText（M55 仿写日志与协议标记剥离）', () => {
  it('剥离仿写的 [工具调用] 块：正文保留、日志与标题整块删除', () => {
    const out = sanitizeModelText(ZIWEI_TAIL)
    expect(out).toBe('@用户 请确认**出生时辰**（几点几分，不确定也请说明）。')
    expect(out).not.toContain('ziwei_pan')
  })

  it('剥离仿写块与协议标记行：正文中的落盘声明保留', () => {
    const out = sanitizeModelText(BAZI_TAIL)
    expect(out).toBe('**落盘**：`docs/八字命盘-今日是否适宜花费大钱.md`。')
    expect(out).not.toContain('[工具调用]')
    expect(out).not.toContain('DSML')
  })

  it('半截流式安全：标题行后尚无完整日志 → 保持原文（待补齐后整体命中）', () => {
    const partial = ['正文', '', '[工具调用]', ''].join('\n')
    expect(sanitizeModelText(partial)).toBe(partial)
    const partial2 = ['正文', '', '[工具调用]', '- ziwei_pan({"birth":"1992-08'].join('\n')
    expect(sanitizeModelText(partial2)).toBe(partial2)
  })

  it('宁窄勿宽：无箭头的列表 / 无标题的箭头列表 → 均保持原文', () => {
    const plainList = ['结论：', '', '[工具调用]', '- 只是普通列表项，没有箭头'].join('\n')
    expect(sanitizeModelText(plainList)).toBe(plainList)
    const arrowList = ['流程：', '- 输入 → 处理 → 输出'].join('\n')
    expect(sanitizeModelText(arrowList)).toBe(arrowList)
  })

  it('块位于正文中间：删除日志块、保留前后正文', () => {
    const middle = ['前半段。', '', '[工具调用]', '- read_file({"path":"a.md"}) → 已读取 a.md', '', '后半段。'].join('\n')
    expect(sanitizeModelText(middle)).toBe(['前半段。', '', '后半段。'].join('\n'))
  })

  it('幂等 + 无关键特征零拷贝', () => {
    const once = sanitizeModelText(BAZI_TAIL)
    expect(sanitizeModelText(once)).toBe(once)
    const text = '普通正文，含箭头 → 也不受影响。'
    expect(sanitizeModelText(text)).toBe(text)
  })
})

// 规则 4：子轮边界（工具结果回灌后）模型漏换行导致 `:::` 容器头 / `# 标题` 贴住前文
// （样本取自真实会话：`…activating the bazi tool.::: pan bazi 四柱 …`）。
describe('sanitizeModelText（粘连块起始拆分，规则 4）', () => {
  const GLUED_PAN = [
    "I'll start by checking the workspace and activating the bazi tool.::: pan bazi 四柱 壬申 戊申 乙亥 壬午",
    '命造：乾造 ｜ 生肖 猴 ｜ 公历 1992-08-27 12:00',
    '- 命宫 壬寅 | 武曲(得)忌 天相(庙)',
    ':::',
  ].join('\n')

  it('粘连容器头拆为独立行：卡片可被行级容器解析识别', () => {
    const out = sanitizeModelText(GLUED_PAN)
    expect(out).toBe(
      [
        "I'll start by checking the workspace and activating the bazi tool.",
        '::: pan bazi 四柱 壬申 戊申 乙亥 壬午',
        '命造：乾造 ｜ 生肖 猴 ｜ 公历 1992-08-27 12:00',
        '- 命宫 壬寅 | 武曲(得)忌 天相(庙)',
        ':::',
      ].join('\n'),
    )
  })

  it('粘连标题拆分（句读符后 `# 标题` 独立成行）；「C# 语言」类不误伤', () => {
    const out = sanitizeModelText("I'll draw the cards.# 十字阵解读 · 当下整体处境")
    expect(out).toBe(["I'll draw the cards.", '# 十字阵解读 · 当下整体处境'].join('\n'))
    const csharp = 'C# 是一门编程语言。'
    expect(sanitizeModelText(csharp)).toBe(csharp)
    expect(sanitizeModelText('记号 #标签 不做拆分')).toBe('记号 #标签 不做拆分')
  })

  it('宁窄勿宽：行首容器头 / 反引号示例 / 无空格 `:::x` 一律不拆', () => {
    const ok = ['::: pan bazi 四柱 甲子 丙寅', '正文。', ':::'].join('\n')
    expect(sanitizeModelText(ok)).toBe(ok)
    const code = '用 `::: pan` 标记盘面卡。'
    expect(sanitizeModelText(code)).toBe(code)
    const nospace = '前缀abc:::def 不是容器头'
    expect(sanitizeModelText(nospace)).toBe(nospace)
  })

  it('幂等 + 与仿写块剥离叠加：同一文本先拆行后剥块', () => {
    const once = sanitizeModelText(GLUED_PAN)
    expect(sanitizeModelText(once)).toBe(once)
    const both = [
      '先给出结论。::: pan gua 本卦 天雷无妄',
      ':::',
      '',
      '[工具调用]',
      '- gua_pan({"n":1}) → 起卦完成',
    ].join('\n')
    expect(sanitizeModelText(both)).toBe(['先给出结论。', '::: pan gua 本卦 天雷无妄', ':::'].join('\n'))
  })
})

describe('extractDeliveredPaths（M55 落盘声明提取）', () => {
  it('采集完成态声明：已写入 / 「落盘**：」清单形态', () => {
    expect(extractDeliveredPaths('已写入 docs/a.md（3.9KB）')).toEqual(['docs/a.md'])
    expect(extractDeliveredPaths('**落盘**：`docs/八字命盘-今日是否适宜花费大钱.md`。')).toEqual([
      'docs/八字命盘-今日是否适宜花费大钱.md',
    ])
  })

  it('不采集计划性表述', () => {
    expect(extractDeliveredPaths('我按此定稿落盘 `docs/紫微命盘-今日是否适宜花费大钱.md`')).toEqual([])
    expect(extractDeliveredPaths('建议后续写入 docs/a.md 后再交付')).toEqual([])
  })

  it('多声明去重', () => {
    expect(extractDeliveredPaths('已生成 docs/a.md；已落盘 docs/b.md；已生成 docs/a.md')).toEqual(['docs/a.md', 'docs/b.md'])
  })
})
