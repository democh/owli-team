# ADR 0175：择日盘 · 兼向判定 · 叠图旋转对齐——M66 续完善三件（zeri_pan / pitchOf / GridOverlay 对齐）

- 状态：Accepted
- 引入：M66 续完善（2026-09-19）
- 相关：docs/design-studio-design.md（§10 风水设计 + §13 M66）· ADR 0168（M66-A 口径）· ADR 0171（M66-B 盘卡）· [server/src/pan/zeri.ts](../../server/src/pan/zeri.ts) · [server/src/pan/calendar.ts](../../server/src/pan/calendar.ts) · [client/src/components/chat/md-ext/pan/ZeriBoard.tsx](../../client/src/components/chat/md-ext/pan/ZeriBoard.tsx)

## 背景

M66 收官时显式留待 v2 的三项（用户指令推进）：① 择日（日课）——评审已决 v1 不做，本批评估并落地 `zeri_pan` 第六件套；② 玄空兼向替卦判定——原声明「不启用」，本批落 A 级门槛判定；③ 叠图旋转对齐——v1 固定正北，本批落滑条对齐。

## 决策

1. **历法基础域 `pan/calendar.ts`（纯计算）**：JDN（标准 Gregorian 公式）→ 日干支 `(JDN + 49) mod 60`（锚定公开基准：2000-01-01 戊午 / 2024-01-01 甲子——golden 双向验证）；节气「节」近似公式（21 世纪 C 表，12 节）+ 月建（节前 / 节后分支：`(m+11)%12` / `m%12`）；声明「近似公式 ±1 天，边界日以专业历书复核」随输出。
2. **择日排盘域 `pan/zeri.ts`**：主轴 = **建除十二神**（月建随节气 + 日支顺推 `(日支 − 月支 + 12) % 12`）+ 日支冲煞（冲生肖 = 对宫；煞方三合局：申子辰南 / 寅午戌北 / 亥卯未西 / 巳酉丑东）；八类事项（搬家入宅 / 动土装修 / 开市开业 / 嫁娶婚庆 / 签约合作 / 安床布置 / 出行远行 / 祭祀祈福）；评分 1–5（基线 3 + 吉组（成开满定）+1 + 命宜 +1 − 命忌 −1 − 破 −2，clamp）；区间 ≤ 31 天；**破日合规表述「传统列为诸事慎用日（宜静不宜动）」**。golden：2026-09-20..28 搬家逐日评分 + 推荐序（09-22 满 5 · 09-28 成 5 · 09-24 定 4）。
3. **工具 `zeri_pan`**（deferred 只读 + tool_search「择日 / 日课 / 吉日 / 黄道 / 建除」）：输出逐日表 + 推荐 + 合规声明 + `::: pan zeri` 整卡模板；PanError 语义。注册：builtin / categories（命理占星）；**blank general 白名单同步**（差集=仅 handoff 的既有不变式）。
4. **择日盘 `ZeriBoard`（第 11 类 pan 卡）**：`pan/zeri-model.ts` 派生（日期条目 `- 日期（干 · 建除 · 周）| 评分 | 冲煞 | 注` → ZeriCardDay；必需门 = 日期条目 ≥ 1）；渲染 = 推荐 chips + 逐日行（星级 ★、破日合规注、推荐描边高亮）+ 行点击回填 + AskBar（推荐日细节 / 放宽区间）；PAN_KINDS/双份 PanKind/derive/PanView 全链接线（同盘卡纪律）。
5. **兼向判定 `pitchOf`（luopan 扩展）**：二十四山每山 15°——**山中心 ±4.5° 为下卦带、两侧各 3° 为兼向带**（3+9+3 自洽分布）；**仅 A 级数据启用**（B/C 级输出「未判定」+ 提示）；兼向仅判定与声明（「传统需替卦……替卦排盘需专业复核，本盘按下卦呈现」——替卦排盘本身不做）；盘卡字段行 + 工具文本 + notes 口径文案同步。
6. **叠图旋转对齐（GridOverlay）**：对齐滑条 0–359°（`rotate(R 50 50)` 包格组——**格内容随网格整体旋转**（旋转后网格的「北格」对齐图纸的北，语义正确）；此前 ADR 0171「被否决：旋转对齐」的判断修正——当时误判「格内容需重排」，实际整体旋转下无需重排）；复位按钮（仅非零时显示）；滑条值实时显示（`R°`）；测试与 E2E 断言 transform。

## 理由

- 择日以**建除十二神**为 v1 主轴：口径公开（大游年级共识）、可 golden 锁定、与「先盘后论 / 禁心算」纪律同构；玄空 / 奇门择日（日课深层）不做——避免半知半解的专业风险；
- 历法锚点用**双公开基准**（2000-01-01 与 2024-01-01）交叉验证，杜绝单源谬误；
- 兼向分带采纳 3+9+3（与「下卦九度」口径一致）且**以 A 级门槛**兑现设计承诺（原 §10.1「v1 不启用」以本批升级为「A 级判定」）。

## 被否决与边界

- **替卦排盘**（24 山 × 兼左右 → 替星盘）：不做（专业软件职责），仅判定 + 声明；
- **择日玄空 / 奇门**：不做（v1）；
- **叠图拖拽 / 自动找正**：不做（滑条已满足对齐需求；自动识别图纸朝向列 v3 评估）；
- **节气精确计算**（寿星天文历级）：不做（近似 ±1 天 + 显式声明，工程折衷）。

## 影响

- 服务端：`pan/calendar.ts`（新）、`pan/zeri.ts`（新）、`pan/luopan.ts`（+pitchOf / PitchJudgement / notes 文案）、`tools/zeri.ts`（新）、`tools/luopan.ts`（+兼向行）、`tools/builtin.ts` + `tools/categories.ts`（注册）；
- 客户端：`pan/zeri-model.ts` + `pan/ZeriBoard.tsx`（新）、`pan/model.ts`（ZeriModel + PanKind 'zeri'）、`pan/derive.ts` 分派、`pan/index.tsx`（lazy + 分派）、`pan/GridOverlay.tsx`（旋转对齐）、`remark-ext.ts`（PAN_KINDS 第 11 类 + 徽标「择日」）、`index.css`（pn-zr-* + 对齐控件样式）；
- 资产：司南 AGENT（+择日职责 / capabilities / zeri_pan 白名单）、fengshui 协议（容器约定 + 择日纪律 #12）、SKILL（§七 择日速查 + 反模式扩）、blank general 白名单、mock ZERI_BLOCKS（建除真值块）；
- 测试：`tests/calendar/zeri.test.ts`（5）、luopan.test +兼向（6）；计数同步（tools 68/47 · m28 61 · m47 60/61/67）；client `m66-zeri.test.tsx`（3）+ m66-luopan +叠图旋转（5）；
- 验证：server **1294/1294** · client **1184/1184** · E2E **m66-fengshui 2/2**（含续完善全链 14.6s）· check:agents 165+41 · check:skills 61/61 · eval **35/36**（1 红为 M63 外部批「参考声明」中间态欠账，归属记录非本批）。
