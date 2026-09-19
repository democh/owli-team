/**
 * M55（§77 / ADR 0125）：模型输出净化 —— 剥离正文中的「仿写工具调用日志」与「协议标记泄漏」。
 *
 * 背景：上下文投影（server/src/context/assembler.ts）会以
 * `[工具调用]\n- 工具名(参数) → 摘要` 段落向模型展示历史真实调用；模型可能学样在正文复述
 * 该格式（协议红线禁止但仅靠 prompt 不可靠：实测 deepseek-flash 仍会仿写，甚至编造未执行的
 * 调用结果与落盘声明）；部分模型还会把工具协议标记（`｜｜DSML｜｜` 系列 XML 形态）以纯文本
 * 泄漏进正文。二者均为系统内部格式，不属于用户可见内容：落库与展示前统一剥离。
 *
 * 规则（宁窄勿宽，避免误删正常正文；对半截流式文本安全幂等）：
 * 1. `[工具调用]` 独立行 + 其后连续的「空行 / 列表行 / 缩进续行」序列：仅当序列中至少含一条
 *    带箭头（→ / -> / =>）的日志列表行时整块删除；无日志行保持原文（流式半截不误删，
 *    待后续分片补齐再整体命中）；无标题行时单靠箭头不剥离（正文正常箭头列表不受影响）；
 * 2. 协议标记行（整行匹配 `</?｜…DSML…`；半截不匹配 → 待补齐）：整行删除；
 * 3. 删除造成的多余空行归一（连续 ≥3 换行压缩为 2），尾部空白去除。
 */

const DSML_LINE_RE = /^\s*<\/?\s*｜+\s*DSML\b.*$/iu
const TOOL_SECTION_LINE = '[工具调用]'
/** 列表行（- / * / • / 1. / 1、） */
const LIST_ITEM_RE = /^\s*(?:[-*•]|\d+[.、])\s+\S/
/** 日志箭头（工具调用记录格式 `- 名称(…) → 摘要`） */
const LOG_ARROW_RE = /→|->|=>/
/** 列表续行（≥2 空格 / Tab 缩进） */
const INDENT_LINE_RE = /^[ \t]{2,}\S/

/** 净化模型正文：返回剥离后的文本（内容未变化时返回原文引用） */
export function sanitizeModelText(text: string): string {
  if (!text) return text
  if (!text.includes(TOOL_SECTION_LINE) && !text.includes('｜')) return text

  const lines = text.split('\n')
  const drop = new Array<boolean>(lines.length).fill(false)
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // 规则 2：协议标记泄漏行（DSML 系列）
    if (DSML_LINE_RE.test(line)) {
      drop[i] = true
      changed = true
      continue
    }
    if (line.trim() !== TOOL_SECTION_LINE) continue
    // 规则 1：向后收集候选块（空行 / 列表行 / 缩进续行），要求 ≥1 条带箭头日志行
    let hasLog = false
    let end = i + 1
    for (; end < lines.length; end++) {
      const candidate = lines[end]!
      if (candidate.trim() === '') continue
      if (LIST_ITEM_RE.test(candidate)) {
        if (LOG_ARROW_RE.test(candidate)) hasLog = true
        continue
      }
      if (INDENT_LINE_RE.test(candidate)) continue
      break
    }
    if (!hasLog) continue // 半截 / 非日志形态：保持原文，待补齐后整体命中
    for (let k = i; k < end; k++) drop[k] = true
    changed = true
  }
  if (!changed) return text

  return lines
    .filter((_, index) => !drop[index])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
}

// ---------- 落盘声明审计（server 侧留痕用） ----------

/** 完成态声明锚：已写入 / 已落盘 / 已生成 / 已保存 / 已创建 / 已覆盖 / 已输出 */
const DONE_CLAIM_RE = /已(?:写入|落盘|生成|保存|创建|覆盖|输出)/g
/** 「落盘**：」清单锚（容忍 markdown 装饰；负向断言避免与「已落盘」重复采集） */
const LEDGER_CLAIM_RE = /(?<!已)落盘\s*[*_`]*\s*[：:]/g
/** 文件路径形态（声明词后窗口内提取；扩展名白名单防误报） */
const FILE_PATH_RE =
  /[A-Za-z0-9_\-./\u4e00-\u9fff]+\.(?:md|txt|csv|json|xlsx?|docx?|pptx?|pdf|html?|ya?ml|sql|sh|py|tsx?|zip|png|jpe?g|svg)/g
/** 声明词后提取窗口（字符数） */
const CLAIM_WINDOW = 60

/**
 * 提取正文中的「完成态落盘声明」文件名清单（用于「声称已落盘 vs 真实写调用」审计）。
 * 仅作留痕判定依据，不改变正文；声明裸「落盘」需紧跟冒号（「定稿落盘 `docs/x.md`」是计划
 * 而非完成态，不采集）。
 */
export function extractDeliveredPaths(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  const collect = (start: number): void => {
    const window = text.slice(start, start + CLAIM_WINDOW)
    for (const match of window.matchAll(FILE_PATH_RE)) found.push(match[0])
  }
  for (const match of text.matchAll(DONE_CLAIM_RE)) collect(match.index ?? 0)
  for (const match of text.matchAll(LEDGER_CLAIM_RE)) collect(match.index ?? 0)
  return [...new Set(found)]
}
