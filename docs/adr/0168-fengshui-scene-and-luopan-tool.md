# ADR 0168：堪舆阳宅场景与 luopan_pan 工具——先盘后论 · 精度分级 · 合规红线（M66-A）

- 状态：Accepted
- 引入：M66 批一（2026-09-19）
- 相关：docs/design-studio-design.md（§5.2 场景 / §10 风水设计）· ADR 0111（命理占星红线圈定 + 排盘工具化先例）· [server/src/pan/luopan.ts](../../server/src/pan/luopan.ts) · [server/src/tools/luopan.ts](../../server/src/tools/luopan.ts) · [agents/fengshui/](../../agents/fengshui/)

## 背景

设计评审（§14.5）落定：风水独立成场景（不与 metaphysics 合并）、择日 v1 不做、3D 锁定家装。M66-A 需落「堪舆阳宅」场景资产与罗盘工具化：① 2 角色（户型解析 → 堪舆判读）；② `luopan_pan` 工具（二十四山 / 八宅游年 / 玄空流年）；③ 合规红线（复用 ADR 0111 口径 + 新增精度边界）；④ mock 镜像与 eval。

## 决策

1. **场景 `fengshui`（堪舆阳宅）**：order 123（让位 122 的 ecommerce 撞号——同号时 id 字典序兜底，实施取 123 保序稳定）；dock + chartboard（复用盘面面板）；严格串行（先解析后判读：`plan-surveyor` → `yangzhai-master`）；defaultSkills `[fengshui]`。
2. **算法域（自研纯计算，零新依赖；口径显式）**：二十四山（每山 15°，子山跨 0°）；八宅（**坐山派**，大游年歌诀；东西四宅分组）；三元九运（1864 起二十年一运，九运 2024–2043）+ 流年入中星（公式 `((11 − 年数字和%9 − 1)%9)+1`——golden：2024 三碧 / 2025 二黑 / 2026 一白；**设计文档 §10.1 原示例「2026 五黄」为笔误，随本批勘误**）；飞布洛书顺飞（中→乾→兑→艮→离→坎→坤→震→巽）。
3. **精度分级（A/B/C）与磁偏角纪律**：A 级（现场 / 专业测量）方可启用 `declination`（B/C 级启用报错）；未经现场测量一律附方向性声明；C 级不做兼向判定。玄空 v1 下卦口径（替卦不做）。
4. **工具 `luopan_pan`**：deferred + readOnly + 纯计算；description 含 tool_search 关键词（罗盘 / 风水 / 堪舆 / 阳宅 / 坐向 / 飞星）；输出含 `::: pan luopan` 整卡模板（先盘后论；M66-B 落第五盘卡渲染，在此之前 PanCard 未知 kind 通用降级——fail-safe）；失败语义 PanError（结构化 + 建议）。
5. **合规红线（场景协议五段）**：文化研习定位（不承诺吉凶必应）；禁恐吓与商业化（禁词：大凶 / 血光 / 破财 / 化解费；「凶方」统一表述为「传统观点列为慎用方位（宜作辅助功能）」）；医疗 / 投资 / 法律 / 婚育 / 生死不做结论；术语附白话；隐私。**四层扫描**落测：协议 / 人设 / 技能 / mock 触发块（含规范句豁免——「禁用 / 不写 / 禁词 / 恐吓 / 反模式」行）。
6. **mock 镜像与 eval**：SCRIPTS 2 角色 / artifactFor 2 交付件（户型解析 / 堪舆点评）/ DISPLAY_NAMES / preferredOf；触发块 2 组（「堪舆走查」→ yangzhai-master 盘卡；「户型走查」→ plan-surveyor 清单；唯一词防碰撞入测）；TOPICS +「阳宅」；eval 34-fengshui（35/35 通过）。

## 理由

- 场景独立（评审已决）：协议红线（宅居 vs 论命）、面板（chartboard 盘面）、串行链（解析→判读）均与 metaphysics 不同构；
- 工具化而非对话推演：与四件套同构（golden 可验、先盘后论、禁止心算）；流年公式与八宅歌诀以 golden 锁定（含 2024–2026 逐年）；
- 精度分级把「未现场测量」的诚实边界写进工具与协议（输出声明 + 测试断言双保险）。

## 被否决与边界

- **择日（日课）v1 不做**：评审落档（v2 评估 zeri_pan 第六件套）；
- **替卦 / 兼向判定**：需更高精度数据（A 级 + 磁偏角），v1 声明不做；
- **同 order 兜底**：122 与 ecommerce 撞号虽由 id 字典序稳定兜底，仍取 123 显式让位（避免依赖 tie-break 的隐式序）。

## 影响

- 服务端：`pan/luopan.ts`（算法域）、`tools/luopan.ts`（工具）、`tools/builtin.ts`（注册）、`tools/categories.ts`（命理占星类）、`llm/mock.ts`（四件套 + 2 触发块 + TOPICS）；
- 资产：`agents/fengshui/`（场景 + 协议 + 2 角色 + 头像）、`skills/fengshui/SKILL.md`、`_presets.yaml`（move-in-check）；
- 测试：`tests/luopan.test.ts`（5 golden）、`tests/fengshui.test.ts`（5 项：资产 / 协议 / 禁词 / 触发词 / 工具核心）；m21 计数同步（41 场景 / 165 角色 / 33 预设 / 36 stage）；tools.test（67 总 / 46 deferred）；e2e/helpers AGENT_NAME；
- 评测：eval 35/35；check:agents 165+41；check:skills 61/61。
