/**
 * M43（§72）：多方 PK 范式纯函数测试（lib/pk）。
 * - findings：行解析（含全角分隔 / 缺修补）/ 编号提及（定义行排除、「缺陷 10」不误配）/ 已响应签名；
 * - 分侧 / 阶段 / 计分：席位优先 → 姿态注册表、单侧为空降级、轮次阶段徽章、发言与缺陷响应统计；
 * - 裁决模板：四按钮文案与 @ 触发（再来一轮）；
 * - claim / offer：容器块扫描、行级解析、报价数值与让步差值格式化。
 */
import { describe, expect, it } from 'vitest'
import {
  claimDetailOf,
  claimNodesOfContent,
  claimReasonsOfLines,
  duelPhaseOf,
  duelSides,
  duelTally,
  duelVerdictLabel,
  findingIdsOfSig,
  findingMentions,
  findingsOfLines,
  formatOfferAmount,
  offerAmount,
  offerHeadline,
  offerRowsOf,
  offersOfContent,
  parseClaimReasons,
  parseFindingsItems,
  parseOfferRows,
  respondedSig,
  verdictTemplates,
  type MessageLookup,
} from '../src/lib/pk'

// ---------- findings ----------

describe('lib/pk：findings 解析与已响应', () => {
  it('findingsOfLines：`- 缺陷 N | 描述 | 修补`；缺修补降级空串；全角分隔兼容', () => {
    const items = findingsOfLines([
      '- 缺陷 1 | 样本区间偏窄 | 补充跨周期样本',
      '- 缺陷 2 | 口径不一致',
      '- 问题 3 | 成本项漏项 | 补测算口径',
      '- 缺陷 4｜描述甲｜修补乙',
      '普通行',
      '- 缺陷 x | 非法编号',
    ])
    expect(items).toEqual([
      { id: 1, text: '样本区间偏窄', fix: '补充跨周期样本' },
      { id: 2, text: '口径不一致', fix: '' },
      { id: 3, text: '成本项漏项', fix: '补测算口径' },
      { id: 4, text: '描述甲', fix: '修补乙' },
    ])
  })

  it('findingMentions：定义行不计提及；「缺陷 10」整段匹配不误配「缺陷 1」', () => {
    expect(findingMentions('- 缺陷 1 | 定义行 | 修补\n回应缺陷 1 已修补')).toEqual([1])
    expect(findingMentions('针对缺陷 10 的修补')).toEqual([10])
    expect(findingMentions('缺陷10、缺陷 3')).toEqual([10, 3])
    expect(findingMentions('无编号提及')).toEqual([])
  })

  it('respondedSig：仅统计自身之后的消息；排序去重为 primitive 签名', () => {
    const store: MessageLookup = {
      order: ['a', 'b', 'c'],
      byId: new Map([
        ['a', { content: '::: findings t\n- 缺陷 1 | x | y\n:::' }],
        ['b', { content: '回应缺陷 2 与缺陷 3' }],
        ['c', { content: '缺陷 1 已修补' }],
      ]),
    }
    expect(respondedSig(store, 'a')).toBe('1,2,3')
    expect(respondedSig(store, 'b')).toBe('1')
    expect(respondedSig(store, 'c')).toBe('')
    expect(respondedSig(store, 'missing')).toBe('')
    expect(findingIdsOfSig('1,3')).toEqual(new Set([1, 3]))
    expect(findingIdsOfSig('').size).toBe(0)
  })

  it('parseFindingsItems：合法 JSON 取条目；非法 / 形状不符跳过', () => {
    const json = JSON.stringify([
      { id: 1, text: '甲', fix: '补' },
      { id: 2, text: '乙' },
      { id: 'x', text: '非法 id' },
      { id: 3, text: '' },
      'x',
    ])
    expect(parseFindingsItems(json)).toEqual([
      { id: 1, text: '甲', fix: '补' },
      { id: 2, text: '乙', fix: '' },
    ])
    expect(parseFindingsItems('{oops')).toEqual([])
    expect(parseFindingsItems(undefined)).toEqual([])
  })
})

// ---------- 分侧 / 阶段 / 计分 ----------

describe('lib/pk：对决分侧与阶段', () => {
  it('duelSides：席位优先于姿态表；中轴席显式声明；全员各就各位且两侧非空才成立', () => {
    expect(
      duelSides(['affirmative', 'negative', 'judge'], { left: ['affirmative'], right: ['negative'], center: ['judge'] }),
    ).toEqual({
      left: ['affirmative'],
      right: ['negative'],
      center: ['judge'],
    })
    // 席位与姿态表冲突时席位优先（姿态：challenger 右 / affirmative 左；席位反转两侧均按席位）
    expect(duelSides(['challenger', 'affirmative'], { left: ['challenger'], right: ['affirmative'] })).toEqual({
      left: ['challenger'],
      right: ['affirmative'],
      center: [],
    })
    // 无席位时走姿态注册表（头脑风暴红队对：两人波成立）
    expect(duelSides(['ideator', 'challenger'])).toEqual({
      left: ['ideator'],
      right: ['challenger'],
      center: [],
    })
    // 场上存在「无站位」成员 → 混合波不成对决（头脑风暴全员同波回退并行协作）
    expect(duelSides(['ideator', 'challenger', 'facilitator'])).toBeUndefined()
    // 席位未声明中轴席时，未命中姿态的成员同样视为无站位
    expect(duelSides(['affirmative', 'negative', 'judge'], { left: ['affirmative'], right: ['negative'] })).toBeUndefined()
    // 单侧为空 / 空输入 → 不成对决
    expect(duelSides(['ideator', 'facilitator'])).toBeUndefined()
    expect(duelSides([])).toBeUndefined()
  })

  it('duelPhaseOf：0 立论 / 1 反驳 / ≥2 修补；负值按立论兜底', () => {
    expect(duelPhaseOf(0)).toBe('立论')
    expect(duelPhaseOf(1)).toBe('反驳')
    expect(duelPhaseOf(2)).toBe('修补')
    expect(duelPhaseOf(9)).toBe('修补')
    expect(duelPhaseOf(-1)).toBe('立论')
  })

  it('duelTally：发言数 / 缺陷数 / 被响应数（跨消息提及口径）', () => {
    const tally = duelTally(
      [
        { role: 'agent', agentId: 'affirmative', content: '::: findings t\n- 缺陷 1 | a | b\n:::' },
        { role: 'agent', agentId: 'negative', content: '回应缺陷 1：我方复核中' },
        { role: 'agent', agentId: 'negative', content: '::: findings t\n- 缺陷 2 | c | d\n:::' },
        { role: 'user', content: '继续' },
        { role: 'agent', agentId: 'affirmative', content: '收到缺陷 2' },
      ],
      { left: ['affirmative'], right: ['negative'] },
    )
    expect(tally.left).toEqual({ speaks: 2, findings: 1, responded: 1 })
    expect(tally.right).toEqual({ speaks: 2, findings: 1, responded: 1 })
  })

  it('duelVerdictLabel：左右标签化胜负文案', () => {
    expect(duelVerdictLabel('long', '立言', '砺锋')).toBe('立言 胜')
    expect(duelVerdictLabel('short', '立言', '砺锋')).toBe('砺锋 胜')
    expect(duelVerdictLabel('draw', '立言', '砺锋')).toBe('势均力敌')
    expect(duelVerdictLabel('none', '立言', '砺锋')).toBeUndefined()
  })
})

// ---------- 裁决模板 ----------

describe('lib/pk：裁决回填模板', () => {
  it('verdictTemplates：四按钮（采纳左右 / 并保留 / 再来一轮），again 含 @ 双方触发并行', () => {
    const outs = verdictTemplates('立言', '砺锋')
    expect(outs.map((t) => t.key)).toEqual(['left', 'right', 'both', 'again'])
    expect(outs[0]!.label).toBe('采纳「立言」')
    expect(outs[0]!.text).toContain('采纳「立言」')
    expect(outs[1]!.text).toContain('采纳「砺锋」')
    expect(outs[2]!.text).toContain('两案并保留')
    expect(outs[3]!.text).toContain('@立言 @砺锋')
  })
})

// ---------- claim / offer ----------

describe('lib/pk：claim 主张解析', () => {
  it('claimReasonsOfLines / claimDetailOf：论据证据配对与细节行', () => {
    expect(claimReasonsOfLines(['- 论据 | 证据', '- 只有论据', '普通行', '* 星号论据 | 证据乙'])).toEqual([
      { text: '论据', evidence: '证据' },
      { text: '只有论据' },
      { text: '星号论据', evidence: '证据乙' },
    ])
    expect(claimDetailOf(['细节：一句话要点', '说明: 冒号也认'])).toBe('一句话要点')
    expect(claimDetailOf(['x', 'y'])).toBeUndefined()
  })

  it('claimNodesOfContent：多块保序；未闭合块忽略', () => {
    const content = [
      '::: claim 主张 A',
      '细节：A 的要点',
      '- 论据 1 | 证据 1',
      ':::',
      '::: claim 主张 B',
      '- 论据 2',
      ':::',
      '::: claim 未闭合',
      '- x',
    ].join('\n')
    const nodes = claimNodesOfContent(content)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toEqual({
      claim: '主张 A',
      detail: 'A 的要点',
      reasons: [{ text: '论据 1', evidence: '证据 1' }],
    })
    expect(nodes[1]).toEqual({ claim: '主张 B', reasons: [{ text: '论据 2' }] })
  })

  it('parseClaimReasons：非法 JSON / 形状不符过滤', () => {
    expect(parseClaimReasons(JSON.stringify([{ text: '甲', evidence: '证' }, { text: '' }, 'x']))).toEqual([
      { text: '甲', evidence: '证' },
    ])
    expect(parseClaimReasons('{oops')).toEqual([])
  })
})

describe('lib/pk：offer 报价解析', () => {
  it('offerRowsOf：字段行 + 条目行（同 pan 口径）；报价数值与量级', () => {
    const rows = offerRowsOf(['报价：98 万', '底线：82 万', '- 依据 | 行情中位', '- 裸条目'])
    expect(rows.fields).toEqual([
      { label: '报价', value: '98 万' },
      { label: '底线', value: '82 万' },
    ])
    expect(rows.items).toEqual([
      { label: '依据', value: '行情中位' },
      { label: '', value: '裸条目' },
    ])
    expect(offerAmount('98 万')).toBe(980000)
    expect(offerAmount('1.2 亿')).toBe(120000000)
    expect(offerAmount('无数字')).toBeUndefined()
    expect(formatOfferAmount(980000)).toBe('98 万')
    expect(formatOfferAmount(120000000)).toBe('1.2 亿')
    expect(formatOfferAmount(3000)).toBe('3 千')
  })

  it('offerHeadline：价格类键优先，其次首字段 / 首条目 / 兜底', () => {
    expect(offerHeadline([{ label: '报价', value: '98 万' }], [], '')).toBe('98 万')
    expect(offerHeadline([{ label: '主题', value: '甲' }], [], '')).toBe('甲')
    expect(offerHeadline([], [{ label: '', value: '乙' }], '')).toBe('乙')
    expect(offerHeadline([], [], '兜底')).toBe('兜底')
  })

  it('offersOfContent：容器 → 实例（标题 / 头条 / 数值）；解析失败字段为空', () => {
    const content = '::: offer 首轮出价\n报价：98 万\n底线：82 万\n- 依据 | 行情中位\n:::'
    expect(offersOfContent(content, 'm1')).toEqual([
      { messageId: 'm1', title: '首轮出价', headline: '98 万', amount: 980000 },
    ])
    expect(offersOfContent('::: offer 空\n- 裸条目\n:::', 'm2')[0]).toEqual({
      messageId: 'm2',
      title: '空',
      headline: '裸条目',
    })
    expect(offersOfContent('无容器', 'm3')).toEqual([])
  })

  it('parseOfferRows：非法 JSON / 空值过滤（卡片 data-fields 兜底）', () => {
    expect(parseOfferRows(JSON.stringify([{ label: '报价', value: '98 万' }, { value: '' }, 'x']))).toEqual([
      { label: '报价', value: '98 万' },
    ])
    expect(parseOfferRows('{oops')).toEqual([])
  })
})
