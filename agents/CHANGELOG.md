# Prompt / Skill 变更日志

> 规则：**每次修改 `agents/` 下的协议或角色人设（含灵魂），必须在本文件追加一条记录**，并附当次评测结果。
> 评测结果（`npm run eval`）与基线（`evals/baseline.json`）对比无回归，是 prompt 变更合并的准入条件。
> mock 断言看「确定性」列；真实模型 judge 分数看「judge」列（手动 / 夜间跑，仅作趋势参考）。
>
> 说明：v1–v4 为基线建立时的**追溯登记**（按里程碑记录整理）；自 v5 起逐条随改动记录。

## 变更记录

### v55 — 可玩盘面：四张排盘卡的交互化与参与式游戏化（M54，纯前端批次 + metaphysics 协议 #14 一条）

- **动因**：用户原话「不要只是简单的表格，可以增加交互和游戏性，让用户参与感更强」——M53 交付后四张盘（八字 / 紫微 / 星盘 / 卦）信息已专业化，但呈现仍是静态行渲染（`PanCard` 字段行 / `PanBoard` 静态行），阅读单向零交互；关键机会：盘面数据已全量在卡内且卡格式被契约测试（`m53-pan-card`）锁定——交互化可做到纯前端派生、零工具、零协议变更。本批按设计基线 `docs/pan-interactive-design.md`（947 行 v2）三分期一次收口：M54-A 基座 / M54-B 盘面 / M54-C 参与层。**agents 侧仅 metaphysics 协议 #14 一条**（M54-A / B 纯前端，本批一并登记）。
- **派生层与视图切换（M54-A）**：`model.ts` + `derive.ts` 从 `::: pan` 卡文本全量派生交互模型，必需门（八字 = 四柱 + 五行 + 日主 + ≥1 大运；紫微 = 12 宫全项）不过 → 回退静态表格（表格为回退终点，`PanCard` 不替换）；`PanView` 统一入口（kind 分发 + ErrorBoundary + Suspense——四盘板懒加载单 chunk，失败回退表格）；默认盘面 + 视图切换记忆 `ma:pn:view:<sid>:<mid>`（session）；流式期回退表格（半截卡不派生）。
- **四盘交互（M54-A / B）**：`BaziBoard`（四柱点看 / 五行能量 / 大运轨道 scrub / 流年条 / 请教草稿）；`ZiweiBoard`（4×4 宫格 / 三方四正 `.is-rel` / 大限巡游 `.is-current` / 四化双编码）；`GuaBoard`（装卦回放 / 变卦剧场 / 错·综预览 / 世应空亡 / 爻详情随选切换 / 无动爻禁用态）；`NatalWheel`（轮盘 10 行星 / 16 弦 / 12 宫 / ASC·MC 轴，行星浮标 + 详情、弦提示与中选、相位筛选 16 ⇄ 12、矩阵互跳）；键盘可达（行星 Enter / 矩阵方向键）+ reduced-motion 直出终态。
- **摇卦台与报数（M54-C）**：`TsToss`——公开仪式种子（crypto）+ `mulberry32(seed)` 现推六爻（与 `gua_pan`（method=coin）同源表逐位一致，单测断言）；存储 `ma:pn:toss` 只存 `{seed, question, done, startedAt}`（结果恒现推）；「以此卦请解」草稿携种子与 `gua_pan（method=coin，seed=…）` 参数入 Composer（不发送）；报数起卦页签草稿携两数与 `method=number`——不本地预测卦名（卦名唯一来源工具复算）。
- **档案 · 合参 · 研习足迹（M54-C）**：档案 `ma:pn:archive:<sessionId>`（聊天卡 ⭐ 与面板统一入口，上限 20 FIFO，本地私密不落库；同型盘差异高亮、异类盘仅并排）；时间轴合参 `Almanac`（统一年龄轴 0 → 两盘最晚终限，八字大运 × 紫微大限双泳道，出生年已知同轴标年份、缺失只显年龄；点选联动高亮 + 只读详情；面板头部「合参」toggle）；研习足迹 `ma:pn:trail:<sessionId>`（去重计数页脚只读小字，无任何成瘾机制——合规红线）。
- **协议 #14（metaphysics `_protocol.md`）**：新增「摇卦复算核对」——用户以摇卦台 / 报数起卦发来的草稿（含种子 / 两数）必须先经 `gua_pan` 复算，禁止直接采信草稿中的卦名与动爻结论；解读前复述本卦 / 变卦 / 动爻 / 世应并核对一致，不一致以工具结果纠正并说明（与第 9 条「起卦可复现」呼应）。
- **面板接入与 E2E（M54-C）**：`ChartboardPanel` / `PanBoard` 多盘 tabs；面板补合参 toggle 与档案抽屉；mock 新增触发词「盘面走查」（`PAN_TRIGGER`：bazi / ziwei 剧本追加可派生盘卡，E2E 固定剧本口径同 M37 checklist 先例）；E2E `m54-pan-interactive` 6 例（卦盘 / 星盘主路径 + reduced-motion + 键盘走查 + 摇卦台全链 + 面板双盘合参档案）。
- **收口期补强（同日）**：mock 盘卡对齐真实全格式（藏干 / 纳音 / 地势 / 胎元 / 命宫 + 10 流年——面板合参可全量派生）；E2E 补四盘主路径全覆盖 2 例（八字盘点柱详情（十神 / 藏干 / 纳音）+ 大运 scrub 空态补算；紫微盘点宫三方四正（设计 §7.8 口径②）+ 四化定位 + 大限巡游 + 请教草稿）——`m54-pan-interactive` 6 → 8 例；相邻回归 E2E 28/28 全绿（2.5m：`markdown-ext` 4 含盘面卡渲染 / `m52-stage` 22 场景工作区 / `m37-scene-chat` 2）。
- **视觉走查修复（收口后同日）**：临时 Playwright 走查 spec 全量复现（17 张截图：四盘桌面 / 详情 / 窄屏 + 参与层 + 面板 + 弹窗）→ 修复 2 项真实缺陷：① `TsToss` 摇卦台未 Portal 化——遮罩在消息虚拟列表行内被行 `transform` 封层（stacking context），实际层级 ≈ 0，被「波次条（z-30）/ 回到最新（z-20）」盖过并劫持点击（模态性破坏；`elementsFromPoint` 命中栈实证）→ `createPortal(mask, document.body)` + 组件测容器改 `baseElement`（8 例不变）；②「回到最新」胶囊 `justify-center` 居中线遮挡卡片底部操作区（窄屏「请教大运」按钮 / 表格回退态流年行实锤）→ 贴右下（`justify-end` + `pr-2`；m12 以 `title` 定位零改动）。走查另澄清 3 项为设计内行为（合参段截断 / 轨道横滚 / 足迹计数）不修。复验：走查复截零遮挡 + 定向 E2E 11/11（`m12-interactions` / `m37-scene-chat` / `m54-pan-interactive`）+ client 68 文件 / 866 全绿 + typecheck / ESLint 0 错误。
- **模态性深化修复（二次续完善，探针驱动）**：临时探针实测发现 2 项确凿缺陷 + 1 项设计缺口：① **Tab 焦点逃逸**（14 步实测 12 步逃出弹窗——自定义弹窗无焦点约束）；② **虚拟列表行回收卸载弹窗**（滚动 1800px 后 `.pn-toss` 消失、滚回不恢复——宿主在 `PanView` 消息行内，行被 `@tanstack/react-virtual` 回收即卸载；重开可恢复为存储兜底）；③ §5.1「chartboard 面板头部同按钮」未实现（面板无摇卦入口）。修复三位一体：**宿主提升**——`ui-store` 新增 `panToss` 请求态（`PanTossRequest {compare, sessionId}` + `openPanToss` / `closePanToss`），`TsToss` 宿主自消息行内上提为 AppLayout 级唯一 `PanTossHost`（overlays 区恒挂载，与任何局部卸载解耦；请解草稿仍走 `insertToComposer` 全局通道，成卦 / 请教程在宿主落账）；`trail.ts` 新增 `subscribeTrail` 订阅（宿主不在 PanView 内时的页脚跳组件刷新——E2E `摇卦 1 次` 断言链路保持）；**焦点约束**——`TsToss` 加轻量 trap（document `keydown` 捕获：Tab 首尾环回弹 / 焦点在台外拉入 + `focusin` 逃逸拉回；面板为 portal 末尾元素，浏览器无自然环回）；**面板入口补齐**——`ChartboardPanel` 头部「亲手摇卦」（`.pn-toss-enter` 独立类名免 `.pn-alm-toggle` 单元素定位冲突；首个可派生卦盘作对照基线，无卦盘 `compare=null` 也摇）。复验：探针复跑逃逸 **12/14 → 0/14**（Tab 全环在台内）、滚动 1800 前后与滚回 `.pn-toss` 恒为 1（小视口 900×560 / 窄屏 375 弹窗存续可测，截图 `data/m54w-small-*.png` / `m54w-narrow-done.png`）；`m54c-pan-toss` +1（Tab 首尾环回 + 逃逸拉回）/ 新建 `m54d-pan-toss-host` 3 例（请求驱动开合 / 请解草稿 + 请教足迹 / 对照快照 + 摇卦足迹 + 无会话降级）→ client 69 文件 / 870 全绿；E2E `m54-pan-interactive` 8/8（含面板摇卦入口新增断言）+ 相邻回归 28/28（`markdown-ext` / `m37-scene-chat` / `m52-stage`）；全仓 typecheck / ESLint 0 错误；client build 通过。
- 评测：eval 28/28 ✅（mock；含 metaphysics 3 回合；仅协议 #14 一条 agents 变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1088 测试全绿；client 68 文件 / 866 测试全绿（M54 专项 87 例：derive 25 / boards 33 / toss 8 / archive 11 / almanac 5 / diff 5；窗口内含并发批次合流）；全仓 typecheck 0 错误；ESLint 0 错误（既有 warning）；client build 通过（主包 `index-CjG-CB_G.js` 1,286.59 kB / gzip 354.98 kB；含并发批次合流，点记录）；E2E 定向 `m54-pan-interactive` 8/8 全绿（2.0m；四盘主路径全覆盖：M54-B 6 + M54-C 2）。
- 相关文档：ADR 0131、design.md §83、`docs/adr/README.md` 索引、`docs/pan-interactive-design.md` 头部实施落位注记（v3 收口；§8 / §9 预测编号更正；v3.2 走查修复补记；v3.3 模态性深化补记）、`docs/scene-expansion-design.md` 头部落地修订注记（M54）。

### v54 — roundtable 顶区重设计与汇聚板收起：俯视圆桌 · 横向步骤条 · 折叠 / 关闭（M59，纯前端批次）

- **动因**：用户实测截图反馈（三处红框：顶区席位环 + 议程清单 / 含状态字区域 / 议程列表特写）——roundtable（社会议题研讨）顶区「太丑了，专业的角度设计下」，明确否决上批纵向议程清单（原话「不要用这个列表」）；并质疑空面板（原话「还有空的面板？可以展示和收起」）。上批 M52-H（v51）「大环 + 纵向清单」设计被整体否定，本批重做顶区；「空面板」经核为用户所持 v50（M58）前版本——就绪判定（ADR 0127）已保证无数据不渲染（roundtable 无产物不渲染汇聚板），本批补全 roundtable 汇聚板收起能力。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **顶区卡片带（RoundtableStage）**：`.scene-rt-top` 由透明条带改浅灰圆角卡片带（`hsl(var(--muted) / 0.4)` + `border-radius 0.8rem` + 外留白）——席位环与议程步骤条同行居中，内容由卡片边界收束、与消息流分层；窄屏（column）沿用降级。
- **席位环 v3 俯视圆桌（SeatRing）**：重写为俯视圆桌——头像 26px / 环半径 40 / 实心桌面 56px（inset 描边）；名字**径向朝外四向锚定**（`data-dir` up / right / down / left + CSS 属性选择器；上下向左内居中、左右向侧边居中，越界省略），**去掉底色**，消除与桌面 / 头像交叉及「贴纸」感；发言席主色描边 + 外光环（双层 box-shadow）；席位盒 = 头像盒（M52-H 几何对位口径沿用），环容器 176 × 138 恰容纳四向名字。
- **议程横向步骤条 v3（AgendaTrack）**：纵向清单（v51 形态）整体替换为横向 stepper——节点三态（完成实心 / 进行中实心 + 光环 / 待办空心）+ 连线（随前步着色）+ 标签；状态字（已完成 / 进行中 / 待办）删除，状态语义由节点 / 标签 / 连线着色承担；摘要改贴卡片带右端（`margin-left auto` + 省略），不再逐行重复、不再铺满余宽。**连线连续性**：为消除「连线被标签空白切断成短划线」观感（浏览器实测甄别），连线实现为节点两侧半线（`::before` / `::after`）+ 相邻步骤间隙段 `scene-ag-link` 拼接（节点 `z-index` 盖线端、标签空白区由半线贯穿），done 段三段同色（含相邻选择器）；交互与断言面不变（`role` / `.scene-ag-*` / `[data-ag-heading]` / onPick 语义零改动）。
- **汇聚板折叠 / 关闭（RoundtableStage + persist）**：口径同 dock（ADR 0127）——`PanelChromeProvider` 注入折叠（ChevronRight）/ 关闭（X）钮到汇聚板标题行（窄屏抽屉不注入——抽屉自带收起）；折叠 → 34px rail（展开钮 + 竖标「汇聚板」）；关闭 → 浮动恢复胶囊（`.scene-rt-reopen`）；偏好 `ma:sc:rt`（`RtPref {collapsed, closed}`）localStorage 全局记忆（与 `ma:sc:dock` 同族）。
- **实现期修复一项**：`nameDir` 方位整体偏 90°——落位公式 `rotate(θ) translateY(−R)` 使 θ=−90 落位在正左（而非正上），页面方位角实为 θ − 90°（加偏移修正；修正后实测四向正确：上席名字在上 / 右席在右 / 下席在下 / 左席在左）。
- **测试**：`m52-stage.test.tsx` 新增「M59 汇聚板收起（折叠 / 展开 / 关闭 / 恢复）」1 例全链（折叠 → rail 且面板卸载 → 展开归位 → 关闭 → 胶囊恢复；含 `ma:sc:rt` 清理）；E2E 断言面零改动（`.scene-agenda` / `.scene-ag-step` / `[data-ag-heading]` 文案 / `.scene-seat-ring` / role 全保留）。
- **续修订（同日，用户实测反馈二轮）**：① **顶区内容组整体居中**（`.scene-rt-top` `justify-content: center`；议程不再撑满余宽——`flex: 1 → 0 1 auto`、摘要 `margin-left: auto → 0` 跟随步骤条构成连续居中组；实测 1600 两侧留白 72px = 72px / 1280 16px = 16px 对称）；② **摘要收缩优先级提高**（`flex-shrink: 99`，空间不足时摘要先让位、省略号）+ 步骤条轨道 `overflow: hidden` 兜底——修复中等宽度（1280）下「摘要与末步标签重叠」（轨道收缩后内容溢出绘制所致）；③ **顶区可收起/展开**：展开态右上角悬浮收起钮 → 单行迷你条（小头像堆叠 + 摘要 + 展开钮），`RtPref.topMini` 落 `ma:sc:rt`（旧值向后兼容）；窄屏迷你条保持单行；reduced-motion 收敛登记 `.scene-rt-top-toggle`。测试：m52-stage 57 例（新增顶区收起全链 1 例）；全量 client 68 文件 / 866 测试全绿；E2E 临时 spec 实测全链（顶区收起/展开 + 汇聚板折叠/展开/关闭/恢复 + 1600/1280 双宽度布局测量：零重叠 / 留白对称）15.6s 通过后清理。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 68 文件 / 866 测试全绿（本批新增 2 例：汇聚板收起 + 顶区收起全链；窗口内含并发批次增量）；client typecheck 0 错误；ESLint 0 错误（6 条既有 warning）；client build 通过（主包 gzip 350.87 kB；含并发批次合流，点记录）；E2E 定向 `m52-stage` + `m42-roundtable` 23/23 全绿（含会议全链「议题 4/4 · 已全部议决」回归）；视觉核验截图 `data/m59-vis-top-done.png` / `m59-vis-ring.png` / `m59-vis-full.png` / `m59-vis-rail.png` 等 6 张；续修订实测截图 `data/m59c-3-top.png`（居中）/ `m59c-5-top-mini.png`（迷你条）/ `m59c-6-top-1280.png`（中等宽度降级）。
- 相关文档：ADR 0130（0128 → Amended）、design.md §82、`docs/adr/README.md` 索引、`docs/scene-expansion-design.md` 头部修订注记。

### v53 — arena 席位发言流实时化与侧栏宽度自适应：双源接入 · clamp 宽度（M60，纯前端批次）

- **动因**：用户实测反馈——arena（辩论场 / 谈判桌）两侧席位发言流「不是实时展示的，等输出结束再展示」；「全屏展示时两侧太窄」（固定 164px 与宽宿主中轴失衡）。决策见 ADR 0129；设计落位 design.md §81。
- **双源接入**：`useSceneLiveMessages`（use-scene-data.ts）——与冻结通道 `useSceneMessages` 同构同节流（500ms）、仅移除流式冻结；ArenaStage 冻结 `messages`（裁决流 / 论断树 / 报价流 / 回合定位，零改动）与实时 `liveMessages`（SideFeed 两席）并存——实时仅限纯文本投影面，容器解析面半截不进派生（ADR 0114 口径不变）。
- **流式态表达**：SideFeed 条目 `data-streaming`（描边高亮 + `caret-blink` 闪烁光标，reduced-motion 关闭）；空正文 → 「发言中…」；首 delta 后 500ms 内入流、随发言增长，收束后去标记、条目保持。
- **宽度自适应**：`.scene-arena-side` 固定 `164px` → `width: clamp(164px, 20%, 280px)`——窄宿保底不变，宽宿（含全屏 / 大屏）随宿主按比例放宽、280px 封顶；窄屏（<900px）降级路径不变。
- **测试**：组件测 `m60-arena-live.test.tsx` 新建 3（流式即时入流 + 增量节流刷新 + 收束去标记 / 空正文占位 / 冻结面边界：流式 `::: claim` 不进论断树、收束后出现）；E2E `m52-stage.spec.ts` arena 用例 +2 断言（run 收束前侧栏 `data-streaming` 条目可见；宽度 = clamp(164px, 宿主 20%, 280px) 误差 <2px + 视口放宽随宿主变宽）。
- 评测：eval 28/28 ✅（mock；零资产 / 零协议变更）；check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；server 81 文件 / 1088 测试全绿（本批零净增）；client 65 文件 / 842 测试全绿（本批新增 1 文件 3 例；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（主包 `index-DU8GPVTx.js` 1,244.16 kB / gzip 354.02 kB；含并发批次合流，点记录）；E2E 定向 `m52-stage` + `m43-pk` 24/24 全绿（2.2m——含 arena 新断言与 m43 arena 回归）。
- 相关文档：ADR 0129、design.md §81、`docs/adr/README.md` 索引、`docs/scene-expansion-design.md` 头部修订注记。

### v52 — 多方 PK 范式：对决组 · 配对卡 · 判定卡与 arena 合流（M43，协议 / mock / 前端混合批次）

- **动因**：M37–M45「场景聊天体系」专项（`docs/scene-chat-design.md` §11）第四批「高阶交互范式」——把「对抗 / 博弈」实现为 **arena 形态（M52-A，ADR 0112）+ 协议容器族**，全量兑现 `docs/scene-expansion-design.md` §7.2 目标形态（对决组 PK-1 / 缺陷-修补配对卡 PK-2 / 评审判定卡 PK-3 / 裁决卡 PK-4 / 计分板 PK-5 + 中轴「裁决流 / 论断树 / 报价流」三面板）；决策见 ADR 0117–0119；编号让位：原规划 §58 / ADR 0075–0077 → 实际 §72 / ADR 0117–0119。
- **协议（agents 三份）**：debate 条款 13——`::: claim` 主张展开（论据挂证据）/ `::: findings` 缺陷-修补方向（**编号稳定 + 回应复用「缺陷 N」**，前端配对点亮）/ `::: verdict` 终局裁决容器（容器内不写 @）；negotiation 条款 11——`::: offer` 报价容器（字段行 + 报价流按数值自动对比让步幅度）+ `::: verdict` 复盘；brainstorm 条款 11——challenger `::: findings` + ideator / refiner 复用编号响应 + 收敛 `::: claim`。
- **容器族与卡片**：remark-ext 四 builder（`mdClaim` / `mdFindings` / `mdOffer` / `mdDebate`，条目统一转 `data-items`）+ 四卡——`ClaimCard`（主张 / 细节 / 论据树 + 点论据回填补证模板）/ `FindingsCard`（缺陷行三列 + 「N/M 已响应」派生点亮）/ `OfferCard`（`is-price` 报价行高亮）/ `DebateCard`（题面 + 双方立场）；fail-safe（未闭合容器无卡片壳 / 解析失败 raw 静态兜底 / 名严格匹配）。
- **PK 判定与对决布局**：`client/src/lib/pk.ts` 纯函数族（findings 行轻量解析 / 「缺陷 N」编号扫描（排除定义行）/ 已响应签名（MessageLookup 入参不跨层依赖 store，跨消息即时点亮）/ `duelSides` 分侧 / `duelPhaseOf` 阶段 / `duelTally` 计分 / `verdictTemplates` 四模板回填）；WaveGroup duel 变体（ADR 0118）——单行二栏（left / right 纵向堆叠）+ center 席居后 + 阶段徽章（立论 / 反驳 / 修补）+ `DuelMeter` 计分条（发言数 / 被响应数 vs 中轴）、不成立 / 窄屏降级普通并行组零回归；裁决卡（PK-4）——最新波且非运行中 → 四按钮（采纳「正」/ 采纳「反」/ 两案并保留 / 再来一轮）→ composerInsert 只写草稿不直发、运行中禁用；评审判定卡（PK-3）——`mode='review'` + `usePlanStore.reviews` 命中 → `ReviewVerdictCard`（verdict 徽章 pass / conditional / fail + target 引用 + findings + 证据计数；fail 附「关联步骤 / 计划已阻塞」状态联动）。
- **arena 中轴合流（ArenaStage）**：裁决流 `[data-verdict-flow]`（`::: verdict` 消息按时间投影 chips + 点击 `ctx.focus` 定位）/ 论断树 `[data-insight="claims"]`（claim 投影 ClaimTree + 论据回填）/ 报价流 `[data-insight="offers"]`（`offerAmount` 数值化 + 相邻 delta `is-down` / `is-up`）；回合轴与席位发言流照常并接收容器数据增强。
- **mock 剧本**：affirmative `::: claim`（三条论据挂证据与置信度）/ negative `::: findings`（三缺陷 + 修补方向）/ negotiator · counterpart `::: offer`（98 万 ↔ 68 万）/ judge `::: verdict 正方 辩论裁决（3 轮制）` / tactician `::: verdict 未成交 谈判复盘`；evidence 按「缺陷 1/2/3」逐条回补（配对全量点亮「3/3 已响应」）；`writePlanCall` 评审步骤（用户点名「评审」→ 三步计划 + `mode='review'` + `reviewSignal` 分支——m24 判定卡 E2E 链路同构）。
- **实施期修复两项**：① remark-ext finalize 补 `mdDebate` 分支（曾遗漏 → DebateCard 无 `data-items`，组件测甄别）；② `duelSides` 收窄「无站位成员不成对决」——姿态兜底曾将头脑风暴全员同波（facilitator / ideator / challenger / refiner）误判为对决（二栏拆散并行圆桌，`m16-brainstorm` 全量 E2E 甄别），修复后 `m16-brainstorm` / `m43-pk` / `m52-stage` 定向 25/25 全绿。
- **测试**：client `m43-pk.test.ts` 新建 16 + `m43-cards.test.tsx` 新建 19（+2 文件 35 例）；E2E `m43-pk.spec.ts` 新建 2（辩论场全链：对决组 → 配对卡「3/3 已响应」→ 裁决流 chip；谈判桌：报价卡 + 报价流 ↓30 万色标）+ `m24-plan.spec.ts` +1（规划带「评审」→ 批准执行 → PK-3 判定卡 `data-verdict=pass`）。
- 评测：eval 28/28 ✅（mock；三份协议变更走既有断言面，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设（协议更新三份）；check:skills 51；server 81 文件 / 1088 测试全绿（本批零净增）；client 63 文件 / 830 测试全绿（本批新增 2 文件 35 例；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（主包 gzip 350.45 kB；含并发批次 M52-G/H、M58 合流，点记录）；E2E 全量多轮账目 + 隔离复跑归因（批次外运行收束竞态）+ 标准环境收口复跑 8/8 全绿——详见 design.md §72.8。
- 相关文档：ADR 0117–0119、design.md §72、`docs/adr/README.md` 索引、`docs/scene-chat-design.md` §11 落位注记、`docs/scene-expansion-design.md` §7.2 / §7.9 注记。

### v51 — 席位环几何修正与议程清单化：头像精确落位 · 桌面坐沿 · 顶区左右平衡（M52-H，纯前端批次）

- **动因**：用户实测反馈（截图）——社会议题研讨（roundtable·pool）顶部区域「效果有问题」；浏览器实测测量确认四项缺陷：① 名字标签与虚线圆交叉不对称（顶席「尚真」深入圆内 14.3px、左右席临界相切 0.4px、底席在圆外 18px）；② 座位盒「头像 + 名字」整体居中定位 → 头像视觉中心偏高 8.3px（几何正圆却视觉偏心、圆穿左 / 右 / 下三个头像）；③ 底席「允中」名字下沿溢出 `scene-rt-top` 2.1px 被消息区覆盖；④ 宽屏（1600）顶区右侧 322px 全空（约 34% 宽度），议程条 23.6px 单行与 148px 席位环失衡。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **席位环几何修正（SeatRing）**：座位盒 = 头像盒（`64 × 30`，名字绝对定位不参与盒居中）——头像中心精确落位环周（回归测量 4 席半径 54±0.05 / 角度精确 0°/90°/180°/270°）；桌面由虚线圆环改**实心圆面**（`inset 38px` 半径 38 与头像内缘 39 相切坐沿，头像不再被弧线穿切）；名字绝对定位在头像下 2px、带底色（不与圆面交叉）；底席名字固定外溢约 13px 由顶区 `padding-bottom` 承接（不再被消息区覆盖）。
- **议程清单化（AgendaTrack）**：单行 chips（含 12px 连接线）改**纵向清单**——与席位环等高并排（align-stretch + 内部居中）、撑满余宽（宽屏右侧不再留白）；每步「状态点 + 标签 + 状态字（已完成 / 进行中 / 待办）」；竖向轨道线串联（端点收束首末点、单项隐藏）；长标签单行省略；点击语义（onPick 回填 / 定位）与 `.scene-ag-*` 类名、`[data-ag-heading]` 不变（测试面零改动）。
- **顶区布局**：`.scene-rt-top` align-items `center → stretch`、padding-bottom `0.2rem → 0.9rem`（承接名字外溢）、gap `1.1rem → 1rem`；窄屏（column）沿用；顶区高度 159 → 174.4px（+15px）。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 63 文件 / 830 测试全绿（本批零新增测试——视觉几何面由既有 `.scene-seat-ring` / `.scene-ag-*` 断言与 E2E 走查覆盖；`m52-stage.test.tsx` + `m42-meeting.test.tsx` 67 例先行复跑全绿）；client typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（`index-ClLPFCs9.js` 1,233.68 kB / gzip 350.44 kB）；E2E `m52-stage` 22 例 + `m42-roundtable` 全绿（并发窗口实测）；视觉核验截图 `data/social-issue-ring-2p4x.png` / `data/social-issue-topreg-full-1p25x.png`。
- 相关文档：ADR 0128、design.md §80、`docs/scene-expansion-design.md` 头部修订注记、`docs/adr/README.md` 索引。

### v50 — 场景工作区就绪判定与面板标题合行：无数据不展示 · 折叠 / 关闭钮注入 · dock 拖拽增强（M58，纯前端批次）

- **动因**：用户实测截图（传统数术 dock·chartboard 八字盘面）——面板标题行（「盘面面板」+ 徽标）与右上角折叠 `>` / 关闭 `×` 分居两行；诉求原话「右侧面板 做成标题，放到 header 上，与关闭一行，整体优化设计i下，右侧面板没数据的时候可以先不展示，有内容之后在展示，并调整合理的宽度等，交互详细设计优化下」。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **无数据不展示（`panel-ready.ts` 新建）**：`panelReady(panel, { containers, verdicts, messages })` 纯函数六口径（chartboard = `::: pan` / pool = 结构化行或带标题容器 / versus = `::: verdict` / board = 成员标题或交付件 / console = 成员消息、管道列、交付件 / coach = `::: checklist`；口径「宁可多显示不可漏显示」——防「有数据但工作区不出现」）；`useScenePanelReady` hook（useSceneMessages 同源节流 + useMemo 派生 containersOf / verdictsOf）；SceneStage 接入——未就绪 `panel` 不下传：dock 直通纯对话流（`.scene-dock` 骨架零渲染）/ roundtable 无汇聚板 aside / 窄屏无抽屉；就绪自动出现（挂载即真实数据，无空态闪变）；closed 态尊重用户意图（有数据后显示 reopen 而非自动弹出）；组件级 PanelEmpty 保留为兜底（测试双层口径：宿主断言「不渲染」/ 组件断言「空态」）。
- **标题合行与面板壳收口**：`PanelChromeContext`（panels/chrome.tsx 新建）——宿主把折叠 / 关闭钮注入面板标题行（PanelShell 统一「图标 + 标题 + 徽标（贴左）+ 操作区右推」，`actions` prop 可覆盖）；`.scene-dock-bar` 独立操作条删除；滚动下沉至 `.scene-panel-body`（标题行固定 + border-bottom），右区 / 抽屉 / 汇聚板三宿主同构（`.scene-drawer-body` 改 overflow hidden 防双重滚动）；aside 入场动画 `scene-aside-in`（0.18s；quiet / reduced-motion 全关）。
- **dock 宽度与拖拽增强**：默认 340 → 360px、clamp 260–520 → 280–640px（persist.ts）；拖拽零 React 渲染（`widthRef` + `asideRef.current.style.width` 直改，抬手一次 commit 落态 + 落盘）；双击把手复位默认宽；把手键盘可达（← → 16px / Shift 48px、`role=separator` + aria-valuenow·min·max）；pointercancel 回滚起始宽（不落盘）；拖拽态 `.scene-dock-resizing`（全域 col-resize + 把手高亮 + user-select none）；卸载清理 body 光标 / 选择态。
- **测试**：`m52-stage.test.tsx` 46 → 55 例（SceneStage 宿主重写 4 → 6：无数据不渲染 / 有数据渲染 + 标题合行（`.scene-panel-actions` 双钮 + title）/ 窄屏有数据抽屉 / 窄屏无数据 / listMode；M52-B roundtable 汇聚板 1 → 2：有产物渲染 / 无产物不渲染；新增 `M58 panelReady` 六口径 6 例）；E2E `m52-stage` 22 例断言全面改写（约 20 处空态断言 → 「不渲染」）+ 两条有数据路径（窄屏 SRE 发消息 → 抽屉出现；融资资本发消息 → 工作区出现 → 标题行折叠 / 关闭钮 → 折叠竖条 → 展开 → 关闭 → 「显示工作区」恢复全链）；chartboard 无 E2E 有数据路径（mock 不触发 pan 工具调用）由单测覆盖。
- 评测：eval 28/28 零回归（mock；零 agents 资产变更，沿用基线）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 63 文件 / 830 测试全绿（本批 m52-stage 净增 9 例）；typecheck 0 错误（client + e2e）；ESLint 改动文件 0 错误；client build 通过（E2E webServer 构建 + 单端口托管实测）；E2E `m52-stage` 22 + `m42-roundtable` 1 + `m34-invest` 3 = **26/26**（首轮 1 例 close 阶段 trace ENOENT（并发 test-results 写入环境噪声，断言全过），单跑复验通过）。
- 相关文档：ADR 0127、design.md §79（含 §66.2 修订注记）、`docs/scene-expansion-design.md` §7.2 / §7.3、`docs/adr/README.md` 索引（0112 → Amended）。

### v49 — 成员展示去重：标题栏头像组移除 · 输入条成员条席位让位（M52-G，纯前端批次）

- **动因**：用户实测截图（谈判 arena 场景）红框标注两处成员表达并追问「是不是重复了，且输入框中的有必要展示吗」——① ChatArea 标题栏右侧头像组（纯装饰无交互）；② 输入条上方成员条（M11 指挥台 chips）；叠加 M52 场景工作区体系（ADR 0112）落地后的 arena 席位卡 / roundtable 席位环（同载「点击 @ 召唤 + speaking/waiting 状态」），同一会话内成员三处重复表达。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **收口口径（用户选定「席位覆盖时隐藏」）**：标题栏头像组删除；输入条成员条在「场景席位已覆盖全员」时让位隐藏；stream / dock / 纯列表等无席位载体场景照常展示（成员入口不缺失）；窄屏 BottomMemberBar 与右栏 TeamPanel 不在本批范围。
- **实现**：`ChatArea` 删除 `participants.slice(0, 7)` 头像堆叠（注释留档）；`Composer` 新增 `poolHidden`（useMemo——参与者空 / listMode / fallback 不隐藏；roundtable 恒隐藏；arena 全员入席（left/right/center 并集）才隐藏；有未入席成员保留保证可见可召唤）；渲染条件仅加 `!poolHidden`，@ 菜单与插入链路零改动。
- **测试**：`composer.test.tsx` 新增 4 例（arena 全员入席隐藏但 @ 菜单可用 / 未入席成员保留 / stream 保留 / 纯列表恢复）。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 63 文件 / 820 测试全绿（本批新增 4 例；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（本批窗口产物 `index-fBAX0Wfp.js` 1,231.13 kB；dist 窗口内后随并发批次重建，数值仅作点记录）；E2E `m52-stage` 22 例 + `m43-pk` 2 例 24/24 全绿（2.2m）；视觉核验截图 `data/m52g-negotiation-arena.png`（标题栏头像组消失 / 成员条让位 / 三张席位卡保留）。
- 相关文档：ADR 0126、design.md §78、`docs/adr/README.md` 索引。

### v48 — 交付清单分层默认：最终交付优先 · 过程产物折叠 · 整体可收起（M37-6 续修订，纯前端批次）

- **动因**：用户实测截图反馈——投资研究会话收尾卡「本轮交付 14 件」8 行展示中 12 件为 `charts/` 行情快照，2 份 docs/ 结论报告被淹没，底部「还有 N 件 · 打开交付件面板查看全部」虚线按钮语义不清（全展示还是跳面板？）；诉求：默认只展示最终交付（最重要的几个文件），其余收进「其他」组，组头即箭头开关（全展示 / 收起）；续修（用户二次反馈「是整个都可以收起隐藏」）：整清单亦可整体收起，收起后仅留概要行与快捷继续。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **分层口径（`client/src/lib/delivery.ts` 新建）**：过程产物判定 = 路径首段命中 `charts` / `data` / `raw` / `cache` / `tmp` / `temp` / `logs`（`charts/` 为金融行情与博弈快照落盘约定；实测 `*.json` 快照 kind=code 与源码同 kind 不可分，故不用 kind 判定）；重要度分层 = 文档（md/office/pdf）> 图示与页面（html/mmd）> 媒体 > 源码文本 > 数据（csv/json）；`partitionDelivery` 纯函数——非过程产物按（层级，原序）稳定排序取前 5 为主区，其余（过程产物 + 溢出）进「其他」。
- **卡片形态（CloseoutCard）**：主区分组渲染（`data-delivery-group="primary"`）；「其他 · N 件」组头即箭头开关（ChevronRight rotate-90 / `aria-expanded` / `data-delivery-toggle`），全展示与收起双向切换；折叠态 `null = 未操作`（默认口径：有最终交付则折叠、主区为空自动展开——卡片不空），新尾条（指纹变化）重置；原「≤8 行 + 还有 N 件」形态撤销，面板入口收敛为头部 PackageOpen 按钮；`data-delivery-row` 锚点不变（既有 E2E 断言沿用）。
- **整体折叠（续修）**：头部左簇（图标 + 标题 + 件数 + 波次 + ChevronRight）即整体开关（`data-delivery-collapse` / `aria-expanded`）——收起后隐藏全部文件行（主区 + 「其他」组），仅留概要行与底部快捷继续；与「其他」组相互独立（整体收起再展开，「其他」保持原状态）；默认展开、新尾条重置。
- **测试**：`delivery.test.ts` 新建 6 例（过程产物判定含嵌套目录与 docs/charts 反例 / 重要度分层 / 分层稳定排序与上限 / 溢出顺序 / 默认上限 5 / 全过程产物边界）；`closeout.test.tsx` 相关 3 例重写 + 整体折叠 1 例新增（共 8 例：分层默认 13 件 = 5 主区 + 8 折叠，箭头全展示·收起双向 / 重要度排序与过程目录折叠 / 全为过程产物自动展开 / 整体折叠与「其他」状态保留）。
- 评测：eval 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 全量 63 文件 / 830 测试全绿（本批新增：delivery 6 例 + closeout 净增 3 例（5→8）；全量首跑曾遇 3 例 SessionList 超时（m16-frontend ×2 / opc-frontend ×1）为并发负载假失败——隔离复跑 42/42 全绿；窗口含并发批次增量）；client typecheck 0 错误；ESLint 改动文件 0 错误；client build 通过（主包 gzip 350.44 kB，`index-ClLPFCs9.js` 含本批全部锚点；重建前先在临时 outDir 做零干扰构建验证，窗口腾出后正式重建）；E2E `m37-scene-chat` 两轮复跑全绿（分层默认后 2 例 19.6s / 整体折叠后 2 例 17.2s——均在并发 run 窗口间隙以临时隔离配置（独立端口 8791 / 8793 + 独立 data + 不 build 复用 dist + 独立 outputDir）单点复跑，清单卡断言 `[data-delivery-row]` 首行可见零回归；跑毕清理临时配置）。
- 相关文档：ADR 0123、design.md §52.4 续修订、`docs/scene-chat-design.md` §5.4 / §5.5、`docs/adr/README.md` 索引（0092 → Amended）。

### v47 — 媒体生成迁入设置——全局连接 · IA 收口（M56，服务端 / 前端混合批次）

- **动因**：用户实测反馈（截图）——「连接管理 → 新建连接」出现媒体生成类型（ComfyUI / SD WebUI / OpenAI 兼容 / 任务模板）不合理（「这些应该放在设置里面，而不是连接管理」）；根因是 M31 起媒体连接沿用**会话绑定**语义（「连接管理建 → 会话绑定 → 才能生成」三跳），与「连接管理 = 按会话授予外部系统凭据」的心智（ADR 0042）冲突；媒体生成本质是**全局能力配置**（对齐 M25 embedding 先例：全局共享 / 不参与会话绑定 / 设置中启用）。**agents 资产零变更**（分批登记纪律照记）。
- **服务端全局化**：`MediaService.providersOf()` 无参（全局启用连接清单；生成面板与工具共用）；`resolveConnection(connectionId?, capability)` 在全局启用连接中解析（缺省取首个启用；未配置引导「请到「设置 → 媒体生成」创建并启用连接」/ 指定 id 不可用「指定的媒体连接不存在或未启用」）；`GET /media/providers` 去 sessionId；绑定守卫 media → `400`（与 embedding 守卫同构相邻）；画布 `mediaBound` 改全局语义（全局存在启用中的媒体连接）；Agent 媒体工具（media_generate / media_video）引导文案同步。
- **客户端 IA 收口**：新建 `settings/MediaConnectionsSection`（清单 / 新建 / 编辑 / 测试 / 删除 / 启用开关；设置页分组 +1 共 9 组；计数「已配置 N 个连接 · 启用即全场景可用（无需会话绑定）」）；`ConnectionsConsole` 媒体全量移除（清单过滤 / 新建 chips / 绑定按钮；+11/-299 行）；`GenerationPanel` 空态引导与铅笔直达编辑改跳「设置 → 媒体生成」（`settingsFocus('media')` + `pendingEditId` 直达编辑消费迁移）；`media-store` 去 sessionId；`canvas-store` mediaBound 全局口径。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1088 测试、client 63 文件 / 816 测试全绿（复跑快照；本批面 = m31-media / m31-tools 改写 + m25-embed +1 例 + m36-frontend +3 例；窗口内含并发批次增量）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 348.90 kB；窗口点记录，含并发批次增量）；E2E `m25-memory` 2/2 全绿（首轮 1 例 trace ENOENT 录制噪声（并发 test-results 争用），复跑干净）；client 全量复跑首轮另遇 m48 / m50 组队台 3 例满载超时波动（未改动面），隔离复跑与全套件复跑均全绿。
- 相关文档：ADR 0124、design.md §76（含历史章节修订注记：§49.3 / §51.3）、`docs/adr/README.md` 索引、`docs/api.md` §11 / §16。

### v46 — 裁决条目多空侧归因：翻盘条件归败方 · 阵营词归各方 · 方向兜底（M52-F，纯前端批次）

- **动因**：用户实测追问「多方无数据？」——v44（M52-E）修复裁决状态容错后，投资研究（dock·versus）多空对弈会话（真实裁决 `::: verdict 空方领先`）局面头与空方列已有数据，多方列仍恒「暂无信号」；根因是信号列归因「按裁决方向整列倾泻」（short 裁决时全部非元条目进空方列，多方列仅「多方胜裁决」才会有数据），而条目本身有方向语义——「翻盘条件」= 败方翻盘路径（真实会话该条目内容全为多方条件：周线站上 1355 / 站上 1292 / 底背离 / 公告利好；mock 对称：多方领先裁决的翻盘条件为空方条件）。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **条目归因（lib/verdict 扩展）**：`verdictItemSide(label, status)` → long | short | draw | meta——元信息（胜负 / 置信度 / 声明 前缀）→ meta（v44 口径延续）；显式阵营词（多方 / 多头 / 正方 / 看多 ↔ long；空方 / 空头 / 反方 / 看空 ↔ short）**优先**；「翻盘条件」→ 败方（空方领先归多方、多方领先归空方、僵持归中立区、none 归 meta）；其余条目 → 裁决方向侧；none → meta（不进信号列，裁决卡全量兜底）；`META_LABEL_RE` 由面板迁入本模块（单一事实来源）。
- **面板分列（VersusPanel）**：`buildModel` 信号列构造由整列倾泻改为逐条归因分侧（`signalRowsOf` 移除）；跨轮累计口径不变（每轮裁决按各自方向归因）；效果：两列不再恒空——真实数据多方 1 条（翻盘条件）/ 空方 2 条（核心依据 + 空方失效条件），mock 多方 1 条 / 空方 1 条；「暂无信号」空态仅在该侧确无条目时出现。
- 评测：eval 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1088 测试、client 61 文件 / 785 测试全绿（本批更新 1 例 + 新增 2 例；窗口内含并发批次增量）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（server tsup；主包 gzip 349.35 kB，并发窗口含 M54 增量，仅作点记录）；E2E `m34-invest` 3 例 + `m52-stage` 22 例 25/25 全绿（56.2s；首轮 1 例 close 阶段 trace ENOENT 为并发 test-results 争用环境噪声——断言全过、截图实锤交付件齐全；窗口内有并发多轮 run 无法独占，以临时隔离配置（独立端口 / data / workspace / outputDir）复跑全绿，跑毕清理临时配置与构建产物）。
- 相关文档：ADR 0122、design.md §74、`docs/adr/README.md` 索引。

### v45 — 模型输出净化与落盘声明审计：仿写日志块剥离 · 协议标记泄漏清理 · 双端兜底（M55，服务端 / 前端 / 共享层混合批次）

- **动因**：用户实测截图反馈「工具调用展示有问题」——聊天气泡出现 `[工具调用]` 文本块、`ziwei_pan({...})` 原始 JSON 参数与「紫微排盘完成」摘要；会话存档实锤 ziwei 消息 tool_calls 为空、run 事件零工具调用，正文却「记录」了调用（模型仿写上下文投影格式：`server/src/context/assembler.ts` 注入的 `[工具调用]\n- 名称(参数) → 摘要`）；同会话另一条消息两处声称 write_file「已写入 3.9KB」且无任何成功写调用（编造落盘声明），并泄漏全角竖线包裹的 `｜｜DSML｜｜` 协议标记——M53 已立「记录真实性」prompt 红线（§68 / ADR 0113），实测不可靠，需代码级兜底。**agents 资产零变更**（协议红线沿用 M53 条款，分批登记纪律照记）。
- **净化函数（shared）**：新建 `shared/src/sanitize.ts`——`sanitizeModelText`（规则宁窄勿宽 · 半截流式安全 · 幂等：① `[工具调用]` 独立行 + 后续连续空行 / 列表行 / 缩进续行序列，仅当含 ≥1 条带箭头（→ / -> / =>）日志行时整块删除；无日志行 = 流式半截保持原文，待补齐整体命中；无标题行时单靠箭头不剥离；② 协议标记行整行删除（半截不匹配待补齐）；③ 空行归一 + 尾部空白去除；无命中快速短路）+ `extractDeliveredPaths`（完成态声明锚 + 60 字符窗口路径提取去重，仅供审计）。
- **服务端收尾净化与审计（engine）**：`sanitizeAndAudit`（幂等）挂 6 处收尾点——executeTurn 的 parseMentions 前（仿写块内可能出现伪 @ 交还标记）与 catch 开头、finishTurn（波级收尾）、续写 / 重生成完成、异常 / 中断 catch 两处——内存对象即净 → 落库 / FTS / 记忆沉淀 / 下一回合装配全干净（防模型看到自己脏文本自我强化）；命中 trace `content:sanitized`（before/after 字符数）；落盘声明文件名 vs 成功写调用（status=ok 的 args.path / args.output）不符 → trace `delivery:unverified` + warn 留痕（不阻断、不改正文）。
- **前端展示兜底（session-store）**：toStores（加载 / 全量刷新）与 upsertMessage 对 role=agent 净化（存量消息历史回看直接干净，不动数据库）；流式 appendDelta 保留原始累积缓冲（rawStreams）对「原始全文」求净化写回 content（若对已净化文本增量拼接，块内后续日志行会失去标题锚点成为孤行）；turn:start（续写 / 重生成复用消息 id）重置缓冲、回合收尾释放、会话切换清空；用户消息豁免（引用系统格式属正常输入）；消息气泡 / 画布舞台 / 侧栏发言流等全部 store 消费方一致受益。
- **测试**：`server/tests/m55-sanitize.test.ts` 9 例（真实样本：ziwei 编造调用记录 / bazi 协议标记泄漏；含半截保持、幂等、零拷贝、声明提取）+ `client/tests/m55-sanitize.test.ts` 5 例（跨分片块剥离与孤行回归 / 协议标记补齐 / 用户豁免 / 存量 upsert / 重生成缓冲重置）。
- 评测：eval 28/28 ✅（agents 资产零变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1087 测试、client 62 文件 / 790 测试全绿（本批新增：server 9 例 + client 5 例）；全仓 typecheck 0 错误；改动文件 ESLint 0 错误；client build 通过（主包 gzip 347.11 kB；构建窗口含并发 M54 中间状态，数值仅作点记录）；E2E：全量 71/76——本批主链路 relay / reload / interject 等全绿，stop 隔离复跑 26.4s 通过；失败 5 例（m54-pan-interactive ×3 / right-panel / stop 长跑）中，前两文件为运行窗口内被并发开发中的 M54 批次修改 + trace ENOENT / 浏览器会话关闭等基础设施抖动，判定非本批回归。
- 相关文档：ADR 0125、design.md §77、`docs/adr/README.md` 索引。

### v44 — 裁决状态容错与局势面板局面头——自然语言前缀 · 置信度加权 · 元条目剔除（M52-E，纯前端批次）

- **动因**：用户实测反馈（截图）——投资研究（dock·versus）多空对弈会话出现「面板上方多方 0 / 空方 0 / 暂无信号，下方裁决卡完整」的割裂；根因是裁决容器首参数的**自然语言首词**（真实模型输出 `::: verdict 空方领先`，会话存档实锤）未命中精确状态词表（多方 / 空方 / 僵持）→ 派生层判 none → 全部条目被丢弃（不落任何列）；即使命中，面板也缺「胜负 / 置信度」一等公民表达、局势条只看条目数差（多数场景全偏 ±100）。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **裁决状态容错（lib/verdict 单一事实来源）**：新建 `client/src/lib/verdict.ts`——`matchVerdictStatus`（精确或前缀命中：「空方领先」「多方占优」→ 对应状态；正反方同构）/ `parseVerdictArg`（非标准首词无剩余标题 → 保留原文为标题）/ `verdictStatusFromItems`（条目「胜负」值前缀兜底）/ `verdictConfidenceOf`（显式百分比直取；定性词低 30 / 中 60 / 高 80 仅驱动幅度、展示保留原词）；`scene/derive.ts` 与 `md-ext/remark-ext.ts` 镜像面同口径接入（后者本地 `VERDICT_STATUS_MAP` / `VerdictStatus` 移除）；未知首词仍降级无状态标题卡（零回归）；ArenaStage 裁决流 / WaveGroup 对决徽章自动受益。
- **局势面板信息架构**：局面头（胜负「多方领先 / 空方领先 / 僵持」+ 置信度 chip；色板同 md-verdict 族）+ 局势条改「方向 × 置信度」加权（§7.6 置信度聚合口径；无置信度条目满偏兜底）+ 信号列剔除元信息条目（胜负 / 置信度 / 声明——面板头 / 裁决卡 / 信号列不再三处重复）。
- 评测：eval 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 80 文件 / 1078 测试、client 60 文件 / 767 测试全绿（本批新增：`m52-stage.test.tsx` +2 / `markdown-ext.test.tsx` +1）；四包 typecheck 0 错误；ESLint 0 错误（本批引入的 1 条 warning 修复后）；build 通过（主包 gzip 346.50 kB；较 v43 收尾 335.05 kB +11.45 kB 含中间批次增量，本批为容错面 + 局面头 + 置信度映射净增）；E2E `m34-invest` 3 例 + `m52-stage` 22 例 25/25 全绿（含对弈用例新局面头断言；首轮残留旧 server / 并发 artifacts 环境噪声清场后复跑全绿）。
- 相关文档：ADR 0121、design.md §73、`docs/adr/README.md` 索引。

### v43 — 圆桌会议范式：会议容器族 · 议题进度容器化 · 派活确认制 · 纪要 @ 转交豁免（M42，协议 / 引擎 / 前端混合批次）

- **动因**：M37–M45 专项（`docs/scene-chat-design.md §10`）圆桌会议范式（RT-1..RT-5）实施——M52-A 已交付 roundtable 形态但议程仅有波次进度，会议语义（声明 / 推进 / 收尾 / 派活）无承载；实施中甄别出引擎侧语义缺陷：`parseMentions` 把 `::: minutes` 待办行的 `@负责人`（派活锚点）当作即时应答转交 → owner 重新入队、波次外扩（brainstorm 例会实测 5 → 8 波，eval `turns_lte 5` 失败）——非 mock 专属（真实模型按协议输出同构待办同样触发）。
- **协议更新（agents/）**：`strategy/_protocol.md` 条款 8（例会纪律：chief 开场输出 `::: meeting <标题>` 并逐字列出议题；成员完成本人议题后在发言尾以 `- [x] <议题原文>` 回标；末位回交主持人）+ 条款 9（纪要收尾：`::: minutes` 三栏——决议 / 待办 / 风险；待办行 `- 待办 | @负责人 事项` 的 @ 是派活锚点、**不构成即时应答转交**；收尾发言需另行单独一行给出转交，议毕即 `@用户` 交还）；`brainstorm/_protocol.md` 新增「圆桌例会纪律」8 / 9 / 10（facilitator 开场声明与阶段顺序 / 纪要三栏与派活锚点 / 回标不抢跑）；两侧交付段补「两会卡是消息内呈现，纪要卡不代替落盘」。
- **容器族与卡片（前端）**：`::: meeting`（标题 + `- [x]/[>]/-` 三态议题）/ `::: minutes`（`- 键 | 值` 三栏纪要，未知键归决议）remark-ext builder + `MeetingCard` / `MinutesCard`；fail-safe（未闭合无卡片壳 / 解析失败 raw 兜底）；议题进度容器化（`lib/meeting.ts` 纯函数族 + 本地勾选 store `ma:meeting:<sid>`；`RoundtableStage` 容器合并驱动「议题 x/n · 当前：XXX」/「已全部议决」+ 点击定位；无容器回退波次驱动零回归）；派活确认制（待办 @ 回填 `@负责人 ` 草稿，ADR 0064）；散会胶囊（尾条指纹派生，运行收束后静态展示）。
- **引擎语义（ADR 0116）**：`parser.ts` 新增 `stripMinutesBlocks`（与 remark-ext 容器正则同源、栈式深度匹配、未闭合 fail-safe 不剥离）——`parseMentions` 先剥离再解析成员提及与「交还用户」判定（返回 `text` 仍为原文，渲染 / 存档零感知）；仅豁免 minutes 容器，其余容器内文本照常解析。
- **mock 链路**：`MEETING_TRIGGER='例会'` + 主持人在场（chief 优先，其次 facilitator）→ 开场声明（`::: meeting` 四议题）→ 成员逐项回标 → 全体议毕回交主持人（「请主持收尾并出纪要」）→ 主持人收尾（minutes 三栏 + 自议题回标 + `@用户` 交还）；首 / 收尾判定走请求历史扫描去重（不依赖 spokenTimes）；eval 13 `opc-weekly-review`（turns_lte 5 临界 / 交还用户 / 无循环）同构。
- 评测：mock 28/28 ✅（含 13 临界 5 回合）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 78 文件 / 1067 测试、client 57 文件 / 703 测试全绿（本批新增：`parser.test.ts` +4 / `m42-meeting.test.ts` 新建 3 例 / `m42-meeting.test.tsx` 新建 21 例 / `m52-stage.test.tsx` +3 / `markdown-ext.test.tsx` +2）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 335.05 kB，较 v42 收尾 332.61 kB +2.44 kB = 会议卡族 + 进度容器化 + 散会胶囊净增）；全量 E2E 69/69 全绿（7.7m；新增 `m42-roundtable.spec.ts` 13.8s）。
- 相关文档：ADR 0115 / 0116、design.md §71、`docs/adr/README.md` 索引、`docs/scene-chat-design.md §10` 落位注记。

### v42 — arena 席位发言流 · 运行中回合号回填 · 贴底跟随末端锚定 · 运行流订阅晚到兜底（M52-D，纯前端批次）

- **动因**：用户实测反馈「辩论两侧是空的」——arena v1（ADR 0112）左右席仅席位卡、两侧留白，`docs/scene-expansion-design.md §7.2` 目标形态「左 = 左席发言流 / 右 = 右席发言流」未兑现；同期三处实时性缺陷：① 运行中回合号缺省（计分板「未开赛」/ 回合轴不动 / 发言流无轮次徽标，刷新才恢复）；② 贴底跟随被虚拟列表测量调整打断（流式收尾后视口偶停「距底几百像素」/ 误离底翻转）；③ 运行流订阅晚到（短 Run 高负载下 attach 跑输 Run 生命周期 → `/api/runs/:id/stream` 404 → 事件链整体缺失、UI 永停过期快照——全量 E2E 甄别出的**产品缺陷**，真实用户弱机 / 高负载同样可复现）。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **席位发言流投影（SideFeed）**：arena 左右席卡片下栏——该席成员消息投影为条目（最新在上 + 轮次徽标「第 N 轮」+ `excerptOf` 摘录 + 点击定位原消息 + 空态「该席发言将显示在这里」）；投影而非拆流（复用 `useSceneMessages` 500ms 节流 + 流式冻结），不复制数据层、不触虚拟列表结构键契约；零编制席位栏保持空；窄屏沿用单流 + 席位横条降级。
- **运行中回合号回填**：`run-store` 的 `turn:start` 归约回填 `event.turnIndex`（服务端 / 重放路径本就同口径，仅归约层缺失）——计分板 / 回合轴 / 发言流轮次 / M16 并行成组运行中即推进，不再等 run:end 全量刷新。
- **贴底跟随末端锚定**：虚拟化器启用 `anchorTo:'end'` + `followOnAppend` + `scrollEndThreshold`（库层按总量差补偿，不产生瞬时 gap）；手写补正层（多帧 rAF + `ResizeObserver` + `pinnedTopRef` 回声守卫）降为兜底；容器 `[overflow-anchor:none]` 消解浏览器原生滚动锚定竞争——流式收尾 / 收尾清单撑高后视口稳定贴底。
- **运行流订阅晚到兜底**（产品缺陷修复）：补全 `sse.ts` 既有契约（「404 交由调用方刷新会话兜底」）——HTTP 非 ok 且未见 `run:end`（闭包 `sawEnd`）且非主动取消（本流 controller 未 abort）时，走 `run:end` 同一口径本地收尾（`endRunLocally`：全量刷新 + 运行态清理；不伪造 `lastEndReason`）；「200 流异常自然结束」保持旧行为（真实链路 run:end 必达；vitest 镜像面「200 + 非 SSE 体」不误触发）。
- **E2E 口径与基建**：断言「流上方」文本先滚入渲染窗口（虚拟剪枝为正确行为；reload 走「滚顶 + 短断言」重试）；`m16-members` 邀请链路移出运行收束窗口（落库时序 +3.0s → ~+1.1s）；`playwright.config.ts` mock 节奏 `LLM_MOCK_DELAY_MS` 20→30ms/片（整轮 ~3.2s→~4.8s，系统性放宽运行收束竞态窗口；对等待式断言无影响）。
- 评测：mock 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 77 文件 / 1060 测试、client 56 文件 / 677 测试（本批新增：run-events 5 例 / m52-stage SideFeed 4 例）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 332.61 kB，较 M52-C 收尾 +0.30 kB = SideFeed + 兜底 + 回合号回填净增）；全量 E2E 六轮收口至 68/68 全绿（第五轮 7.3m；兜底收窄复验后第六轮 7.5m——账目见 design.md §70.6）。
- 相关文档：ADR 0114、design.md §70、`docs/adr/README.md` 索引。

### v41 — 既有场景接入：14 场景 stage 声明合入（M52-C，声明 / 验证批次）

- **动因**：M52-A 框架（§66）与 M52-B 点亮（§67）后，M51 既有 14 个场景（研讨 3 / 工作 6 / 生活 5）仍以 stream 形态运行——工作区收益未覆盖既有场景；本批按 `docs/scene-expansion-design.md §7.10` 逐场景接入，**零资产改动原则**（仅追加 `stage` 声明，不新增角色 / 技能 / 预设 / 协议）。**agents 资产零变更**（分批登记纪律照记）。
- **声明合入（14/14）**：C1 研讨域 `brainstorm` / `research` / `strategy`（roundtable·pool ×3，与 society 共用形态与面板）；C2 工作域 `sre` / `bi` / `marketing` / `sales` / `funding`（dock·console ×5）+ `invest`（dock·versus ×1）；C3 生活域 `health` / `learning` / `travel` / `wealth` / `personal`（dock·coach ×5）。至此 29 场景中 24 场景已声明，仅余 stream 四场景（development / finance / ops / home）零改动。
- **镜像面断言**：`m21.test.ts` 新增「M52-C 既有场景接入：14 场景声明合入」分组逐字段断言 + 全量总账（24 组已声明）；「stream 四场景缺省」断言同步。
- **E2E**：`e2e/m52-stage.spec.ts` 7 → 22 例（+15）：C1 ×3（席位环 4/4/3 席 + 议程 + 汇聚板）/ C2 ×6（console 五场景 + invest versus）/ C3 ×5（coach 五场景）/ roundtable 窄屏（席位横条 + 抽屉）。
- **逐场景细化（补 §67.2 遗留，收尾补办）**：面板空态文案逐场景化——board ×3（gamedesign「设计文档与数值表」/ writing「文稿结构与版本」/ housing「方案对比与预算测算」）+ coach ×7（health「打卡与周计划」/ learning「学习路径与打卡」/ travel「行程与预算」/ wealth「预算与目标进度」/ personal「事务清单与提醒」/ career「求职进度与产出物」/ care「照护排班与清单」），未收录场景均落中性默认；coach 内容区兜底标题同步场景化（checklist 容器无标题时按场景落「打卡 / 学习 / 行程 / 目标 / 事务 / 求职 / 照护清单」，未收录场景落中性「清单」）；组件测试补相应空态 / 兜底覆盖（`m52-stage.test.tsx` +5 → 34 例）；E2E 六处 coach 空态断言随场景语汇同步（用例数不变）。**测试覆盖补缺（收尾续办）**：面板内容态组件测试补齐——console 空态（原零覆盖）与管道/时间轴、board 目录树/版本线、versus 多空列/裁决卡、chartboard 盘面 tabs（`m52-stage.test.tsx` +5 → 39 例），兜底标题断言扩为 7 场景全轮询。
- 评测：mock 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1056 测试（m21 +1）、client 56 文件 / 660 测试（细化后 673，含并发会话增量；本批净 +10）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 331.29 kB，较 M52-B +0.39 kB 系并发会话 client 改动所致，本批零 src 变更）；E2E `m52-stage.spec.ts` 22/22 全绿（14 场景 + 窄屏 + A/B 回归）。
- **相邻回归说明（m16-serial，非本批）**：m16-brainstorm / m21-opc（×2）/ relay 全绿；m16-serial「默认串行」干净环境通过、「关闭串行」4 次复跑均失败（最近 2 次为无并发干净环境）——服务端 Run 全部正常收束（done + handed_to_user=1 + 完整消息落库），失败面为前端运行态滞留致尾条消息未进视口渲染（「你的回合」随之不渲染）；判定非本批回归（零 src 变更、改动零交集），引入点在并发会话 client UI 改动窗口内。**收尾复验：并发会话后续改动落盘后 2/2 全绿（27.5s），账目闭合；收尾门禁（逐场景细化后）：client 56/668、typecheck / lint / build 均通过，E2E `m52-stage.spec.ts` 22/22 全绿（复用并发会话 webServer 实例；coach 语汇同步后 50.6s、兜底标题后 55.0s 两轮复跑）；测试补缺后复验：client 56/673、typecheck / lint（0 错 13 警）通过，补缺为零 src 变更（仅测试文件与注释），build / E2E 结论沿用上轮实测。**
- 相关文档：design.md §69。（无新 ADR：本批为既有框架的声明接入，ADR 0112 决策覆盖。）

### v40 — 专业排盘卡增强：四张盘面卡专业化 · 契约测试 · 协议记录红线（M53，工具 / 协议批次）

- **动因**：用户反馈排盘输出信息量不足（紫微 tab 仅命宫 3 行、八字 tab 仅 5 行），要求「专业命理师」级盘面丰富度；同期两处关联问题——盘面卡无标题使多盘 tab 区分退化（两个卦盘均显示类型名「gua」）、模型仿写 `[工具调用]` 日志与虚假落盘声明——本批为四张专业盘面卡重写（计算层扩展 + 卡模板 + 契约测试）与协议纪律加固；零新增依赖（复用既有 lunar-typescript / iztro / astronomy-engine）。
- **计算层扩展**（`server/src/pan/`，纯函数）：bazi 补旬空 / 地势（十二长生）/ 胎元 · 胎息 · 命宫 · 身宫（含纳音）/ 生肖星座 / 起运交运日期与大运流年当前标记；ziwei 补四柱干支 / 生肖星座 / 来因宫 / 生年四化 / 十二长生 / 杂曜 / 当前大限标记；natal 补元素（火土风水）与模式（基本固定变动）分布；gua 补卦气（起卦四柱 / 日辰旬空 / 农历）/ 错卦综卦 / 卦体上下卦（卦象 · 五行）/ 旬空爻标记 / 动爻变爻（干支五行六亲）。
- **四张盘面卡重写**（`server/src/tools/pan.ts`；卡头标题 + `键：值` 字段行 + 单一连续 `- 键 | 值` 条目列表，与 remark-ext / chartboard 解析规则同源）：`四柱 庚午 辛巳 丁丑 丁未` / `紫微 土五局 ｜ 命宫 丙戌` / `本命盘 <出生时刻>` / `天雷无妄 → 天火同人`——卡头标题消解多盘 tab 退化（两个卦盘以卦名区分）；八字卡 11 字段 + 大运 8 步 + 流年 10 条（含当前标记）、紫微卡 6 字段 + 12 宫条目（主星亮度四化 · 辅星 · 杂曜 · 长生 · 大限）、星盘卡 3 字段 + 38 条目（10 行星 + 12 宫头 + 16 相位）、卦卡 9 字段 + 六爻条目（六神六亲 · 旬空 · 动爻变爻）；统一引导句「盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）」；四件套工具描述升级为「唯一口径」表述（盘面数据必须出自工具、禁止心算或凭记忆推算）。
- **契约测试**：新建 `server/tests/m53-pan-card.test.ts` 4 例（与 remark-ext 解析规则同源的卡格式不变量：卡头 kind / 标题非空 / 单一列表连续性 / 字段行正则 / 条目行格式 + 四卡丰富度基线）；`server/tests/m51-pan.test.ts` 21 例断言扩展（旬空 / 地势 / 胎元四宫 / 生肖 / 大运 toMatchObject / 生年四化 / 元素模式 / 卦气旬空 / 空亡爻 / 变爻）——两文件合计 25 例全绿。
- **协议纪律**（agents/）：`_protocol.md` tool_policy 新增「记录真实性（红线）」；`metaphysics` / `astrology` 协议 8 号追加盘面卡「整卡原样复制」（含卡头标题行，勿增删字段与条目——盘面板 tab 区分依赖它），新增 12（卡面复用：同参数不重复起卦 / 排盘，先查历史；多成员同波先声明分工）与 13（记录真实红线）。
- 评测：mock 28/28 ✅（协议追加条款不影响脚本链路，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 77 文件 / 1060 测试、client 56 文件 / 660 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；E2E `markdown-ext.spec.ts`（含盘面卡渲染用例）4/4 全绿。
- 相关文档：ADR 0113、design.md §68、`docs/adr/README.md` 索引。

### v39 — 新场景点亮走查：十个声明场景渲染验证（M52-B，验证 / 测试批次）

- **动因**：M52-A 交付场景工作区框架（design.md §66）后，M51 各批预写的十个 `stage` 声明（arena 2 / roundtable 1 / dock 7）需逐一实测「声明即渲染」；本批为**验证 + 测试批次**：零 src / 零资产 / 零协议改动（仅 `e2e/m52-stage.spec.ts` 与 `client/tests/m52-stage.test.tsx` 增补）。**agents 资产零变更**（分批登记纪律照记）。
- **点亮核对（10/10）**：arena `debate` / `negotiation`——席位分栏 + 计分板 + 回合轴随消息推进；roundtable `society`——席位环 4 席 + 议程波次 + 汇聚板；dock 7——board（`gamedesign` / `writing` / `housing`）/ coach（`career` / `care`）/ chartboard（`metaphysics` / `astrology`）工作区开合 / 拖宽 / 折叠记忆与面板渲染；同形态同面板组合以代表场景 E2E 全链 + 全量 yaml 静态核对（§7.5 矩阵逐字段）闭环。
- **E2E**：`e2e/m52-stage.spec.ts` 2 → 7 例（+5：roundtable 席位环与议程推进 / arena 全链「发消息 → 计分板轮次 + 回合轴 + 交还用户」/ dock·board / dock·coach / arena 窄屏 SeatStrip 与单流降级）。
- **vitest**：`client/tests/m52-stage.test.tsx` 22 → 25 例（+3 组件级走查：arena 席位分栏与计分板 / seats 成员不在场兜底「左席 · 右席 · 未开赛」/ roundtable 席位环 + 议程推进 + 汇聚板空态）。
- **走查发现**（均测试侧处理，零资产变更）：①「议题圆桌」为唯一预设（`issue-roundtable`）× 场景（`society`）同名对——创建对话框两来源区按钮 aria-label 相同，E2E 以场景行独有「∥ 并行协作」特征文案精确定位；② board 空态文案「文稿结构与版本将在这里显示」偏 writing 语境（三场景共用），记入 M52-C 逐场景细化事项。
- 评测：mock 28/28 ✅（零 agents 资产变更，baseline 未动、与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1055 测试、client 56 文件 / 656 测试（+3）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 330.90 kB，较 M52-A 持平——本批零 src 变更）；E2E `m52-stage.spec.ts` 7/7 + 相邻回归 relay / m21-opc / m16-serial（m16-serial 1 例浏览器会话崩溃偶发，复跑 2/2 全绿澄清非回归）。
- 相关文档：design.md §67（新章）、§66.5 指引更新、`docs/scene-expansion-design.md` §7、`e2e/m52-stage.spec.ts`。

### v38 — 场景工作区体系框架：四形态容器 · 六面板 · 12 元件库（M52-A，纯前端 / 类型批次）

- **动因**：场景生态（`docs/scene-expansion-design.md` §7）判定 29 场景共用同一种「聊天流」——对弈看不到席位与回合、圆桌看不到波次、工作型场景的产物散落；M51 各批已预写 `stage` 声明（arena 2 / roundtable 1 / dock 7）但消费端为零；本批落地框架，声明从注释语义变为运行时渲染。**agents 资产零变更**（协议 / 角色 / 预设未动，因分批登记纪律照记）。
- **类型层**：`GroupStageSchema`（layout 四枚举 / panel 六枚举 / seats left·center·right / parts 12 元件，全部可选）+ `AgentGroupSchema.stage`（未声明即 stream）；seats 引用角色存在性校验（m21 正负例 +2）。
- **四形态容器**：stream 零结构直通 / dock（右工作区 340px 拖宽 260–520 折叠关闭，`ma:sc:dock` 记忆）/ roundtable（席位环 + 汇聚板 + 波次进度）/ arena v1（席位分栏 + 回合轴 + 计分板，§7.9 口径）；`resolveStage` 降级链：未声明 / 非法 / arena 缺席位 / listMode → stream。
- **六面板 + 12 元件**：pool（条目卡墙 + 深入回填）/ versus（多空信号 + 裁决卡）/ board（目录树 + 版本线 + 交付件）/ console（看板 + 时间轴）/ coach（进度环 + 勾选）/ chartboard（多盘 tabs + PanBoard）；元件库 12 件（PART_NAMES 注册，空声明 = 全启用；空态统一 PanelEmpty）；纯前端派生（容器 / 盘行 / 裁决 / 清单 / 标题 / 波次）。
- **交互与性能**：面板 tabs / 勾选 sessionStorage（`ma:sc:*`）；「切回纯列表」开关（ChatArea 标题栏）；composerInsert 回填 + requestArtifact 打开交付件；500ms 节流 + 流式冻结 + 原始值 selector（流式 delta 不触发宿主重渲染）；quiet / reduced-motion 收敛；窄屏（<900px）抽屉 + 席位横条。
- 评测：mock 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1055 测试（+2 seats 校验正负例）、client 56 文件 / 653 测试（+22 m52-stage）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 330.91 kB，存量欠账持续关注）；E2E `m52-stage.spec.ts` 2/2 + 相邻回归 5/5（relay / m21-opc / m16-serial）。
- 相关文档：ADR 0112、design.md §66、`docs/scene-expansion-design.md` §7、`docs/adr/README.md` 索引。

### v37 — 命理占星专线：传统数术 · 星象占星两场景 + 排盘工具四件套与 `::: pan` 容器（M51-E，工具 / 容器 / 资产 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.5）判定「传统文化」方向全空白（传统数术与西方占星均无承接场景），且术数类内容的可信度来自「先盘后论」——盘面必须工具计算、参数可复现；本批落地第 28-29 个场景（`metaphysics` / `astrology`，11 新角色），把「表述纪律 / 排盘可验」两条领域红线写进协议，并新增排盘工具四件套与 `::: pan` 容器。
- **排盘工具四件套**（`server/src/tools/pan.ts` 注册 + `server/src/pan/` 计算模块）：`bazi_pan`（四柱 / 十神 / 藏干 / 五行 / 大运流年 / 真太阳时校正告警）/ `ziwei_pan`（十二宫 / 主星辅星 / 四化 / 五行局 / 大限）/ `natal_pan`（行星 / 宫头 / 相位矩阵 / 四轴；高纬降级等宫制）/ `gua_pan`（六爻 / 梅花，种子可复现）——全部 tier=deferred（`tool_search`「排盘 / 命盘 / 星盘」激活）、纯计算只读无审批、失败结构化报错（禁心算兜底）；golden 测试 `server/tests/m51-pan.test.ts` 21 例（八字 / 紫微 / 星盘各 ≥3 例 + 卦固定种子）。
- **`metaphysics` 传统数术（7 角色）**：order 118 / icon `moon` / theme 玄墨金 / `parallel: true`（parallelMax 4，多术可同波并行、各自落盘）/ `defaultSkills: [chinese-metaphysics]`——观复（四柱研习师 → `docs/八字命盘-<主题>.md`）/ 星垣（紫微研习师 → `docs/紫微命盘-<主题>.md`）/ 灼见（六爻研习师 → `docs/六爻卦解-<主题>.md`）/ 溯机（大六壬研习师 → `docs/大六壬课解-<主题>.md`）/ 心易（梅花研习师 → `docs/梅花卦解-<主题>.md`）/ 步天（七政研习师 → `docs/七政星盘-<主题>.md`）/ 奇正（奇门研习师 → `docs/奇门局解-<主题>.md`）；协议「表述纪律 + 排盘可验」（参考区间 / 禁恐吓话术与付费化解暗示 / 禁心算排盘或编造盘面 / 术语白话 / 生辰隐私 / 时辰存疑给敏感度说明 / 未工具化门类显式声明 / 起卦种子可复现）；`stage: {layout: dock, panel: chartboard}`。
- **`astrology` 星象占星（4 角色）**：order 120 / icon `star` / theme 星夜蓝紫 / `parallel: true`（parallelMax 4）/ `defaultSkills: [western-astrology]`——司辰（本命占星师 → `docs/本命盘报告-<主题>.md`）/ 星移（行运占星师 → `docs/行运报告-<主题>.md`）/ 合璧（关系占星师 → `docs/合盘报告-<主题>.md`）/ 问星（卜卦择时师 → `docs/择时报告-<主题>.md`）；协议「盘面为据」（时区显式 / 高纬降级等宫制如实告警 / 挑战相位表述为课题与成长点 / 合盘需知情前提 / 行运给时间窗不断言事件）；`stage: {layout: dock, panel: chartboard}`。
- **`::: pan` 容器**：remark-ext 新增 builder（`::: pan <bazi|ziwei|natal|gua> [标题]` + `键：值` 字段行 → `data-fields` + `- 键 | 值` 条目行 → `data-items`）+ 客户端 `PanCard` 渲染（四类型徽标 / 字段行 / 条目行 / raw 恒等兜底）；降级链：流式直接渲染（同 verdict 档）/ 未知类型通用「盘面」徽标 / 解析失败保持原文；M52-B 升级 PanBoard。
- **技能与预设**：新增 `skills/chinese-metaphysics`、`skills/western-astrology`；预设 `chart-combo`（order 240，观复 · 星垣）、`oracle-crossread`（order 250，灼见 · 心易）、`full-horoscope`（order 260，司辰 · 星移 · 合璧）。
- **镜像面七件套**：mock.ts 四件套 ×11（SCRIPTS 11 条 / artifactFor 11 case 与交付契约对齐 / DISPLAY_NAMES 11 / preferredOf 11）+ `TOPICS` 演示词表 +1（「前程」，尾部追加既有任务零回归）+ `e2e/helpers.ts` AGENT_NAME +11（全量 114 角色 id→name 逐一相等）+ `m21.test.ts`（29 场景 / 114 角色 / 26 预设 / 协议断言 +2 / 排盘工具绑定 it）+ `agents/README.md`（统计与预载表 +2 行）。
- 评测：mock 28/28 ✅（新增 `28-metaphysics`：四柱 → 紫微合参 → 本命盘（3 回合，3 交付件）；`--update-baseline` 后与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设（11 新头像 ✓）；check:skills 51 通过；server 全量 76 文件 / 1053 测试、client 全量 55 文件 / 631 测试全绿（含 m51-pan 21 例 / m51-md-pan 10 例）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E 回归 8/8 全绿（m12-interactions / m16-members / m21-opc / markdown-ext，含盘面卡用例）。
- 相关文档：ADR 0111、design.md §65、`docs/scene-expansion-design.md` §5.5、`docs/adr/README.md` 索引、`agents/README.md`。

### v36 — 生活安居专线：置业安家 · 家庭照护两场景落地（M51-D，资产 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.4）判定「置业决策链 / 家庭照护支持」两类需求无承接场景（置业散落在 home / wealth，照护散落在 health 但主体是家人且核心是事务协助而非健康干预）；本批落地第 26-27 个场景（`housing` / `care`，6 新角色），把「预算纪律 / 非医疗诊断」两条领域红线写进协议。
- **`housing` 置业安家（3 角色）**：order 114 / icon `map` / theme 砖橙 / 串行决策链（需求 → 测算 → 落地）——择邻（选房参谋 → `docs/选房对比-<主题>.md`）/ 家树（房贷顾问 → `docs/贷款方案-<主题>.md`，handoff → wealth / legal）/ 筑居（装修规划师 → `docs/装修方案-<主题>.md`）；协议「预算纪律」（月供收入比如实测算 / 数据来源与时效 / 决策框架不替拍板 / 合同条款提示）；`stage: {layout: dock, panel: board}`。
- **`care` 家庭照护（3 角色）**：order 116 / icon `heart-handshake` / theme 玫红 / 串行照护链——顾宁（照护规划师 → `docs/照护方案-<主题>.md`）/ 陪安（陪诊助手 → `docs/陪诊记录-<主题>.md`）/ 颐和（康养顾问 → `docs/康养建议-<主题>.md`）；协议「非医疗诊断」（不做诊断 / 不开药 / 不解读报告 / 异常症状直接建议就医；陪诊只做就医准备 + 记录；照护者不透支）；`stage: {layout: dock, panel: coach}`。
- **技能与预设**：零新建技能（按角色预载 deep-research / spreadsheet-modeling / financial-modeling / visual-design / process-improvement / doc-coauthoring / formal-document / source-verification）；预设 `home-purchase`（order 220，择邻 · 家树 · 筑居）、`care-plan`（order 230，顾宁 · 陪安 · 颐和）。
- **镜像面七件套**：mock.ts 四件套 ×6（SCRIPTS 6 条 / artifactFor 6 case 与交付契约对齐 / DISPLAY_NAMES 6 / preferredOf 6）+ `TOPICS` 演示词表 +2（「购房」「长辈」，尾部追加既有任务零回归）+ `e2e/helpers.ts` AGENT_NAME +6（全量 103 角色 id→name 逐一相等）+ `m21.test.ts`（27 场景 / 103 角色 / 23 预设 / 协议断言 +2）+ `agents/README.md`（统计与预载表 +2 行）。
- 评测：mock 27/27 ✅（新增 `26-housing`：选房 → 贷款 → 装修（3 回合，3 交付件）/ `27-care`：照护方案 → 陪诊准备 → 康养建议（3 回合，3 交付件）；`--update-baseline` 后与基线零回归）；check:agents 27 场景 / 103 角色 / 23 预设（6 新头像 ✓）；check:skills 49 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E 回归 4/4 全绿（m12-interactions / m16-members / m21-opc）。
- 相关文档：ADR 0110、design.md §64、`docs/scene-expansion-design.md` §5.4、`docs/adr/README.md` 索引、`agents/README.md`。

### v35 — 工作创作专线：创作工作室 · 职业发展 · 游戏工坊三场景落地（M51-C，资产 / 技能 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.3）判定「长篇创作链 / 求职陪跑 / 游戏内容设计」三类需求无承接场景（写作散落在 marketing.content / ops.assistant，求职与 hr 视角相反，游戏设计与 development 工程实现不同）；本批落地第 23-25 个场景（`writing` / `career` / `gamedesign`，12 新角色），把「原创底线 / 履历真实 / 核心循环先行」三条领域红线写进协议。
- **`gamedesign` 游戏工坊（4 角色）**：order 108 / icon `flame` / theme 紫粉 / chain `[game-designer, balance-designer, narrative-designer, playtester]` / `parallel: true`（parallelMax 3，三路设计并行 + 验证收口）/ `rounds: false`——游心（玩法策划 → `docs/游戏设计文档-<主题>.md`）/ 千衡（数值策划 → `docs/数值平衡表-<主题>.md`）/ 织境（叙事策划 → `docs/世界观设定-<主题>.md`）/ 百试（玩法验证 → `docs/玩法测试报告-<主题>.md`）；`_protocol.md` 11 条（铁律 7 + 工具 2 + 交接 / 声明 2）；`stage: {layout: dock, panel: board}`。
- **`writing` 创作工作室（4 角色）**：order 110 / icon `pen-tool` / theme 纸墨褐 / 串行创作链——曲径（选题策划 → `docs/选题大纲-<主题>.md`）/ 文藻（主笔 → `docs/文稿-<主题>.md`）/ 锦言（编辑 → `docs/定稿-<主题>.md`）/ 书远（出版顾问 → `docs/出版方案-<主题>.md`，handoff → ip / pr）；协议「原创底线」+ 编辑边界（不越权改写）；`stage: {layout: dock, panel: board}`。
- **`career` 职业发展（4 角色）**：order 112 / icon `target` / theme 青绿 / 串行陪跑——程途（职业顾问 → `docs/职业规划-<主题>.md`）/ 履新（简历顾问 → `docs/简历-<主题>.md`）/ 问达（面试教练 → `docs/面试手册-<主题>.md`）/ 薪言（薪酬顾问 → `docs/offer评估-<主题>.md`，handoff → negotiator / career-advisor）；协议「履历真实」+ 候选人视角；`stage: {layout: dock, panel: coach}`。
- **技能与预设**：新增 `skills/game-design`（设计分层 / 核心循环画法 / 数值体系 / 叙事咬合 / 玩法验证）；预设 `writing-sprint`（order 190，曲径 · 文藻 · 锦言）、`job-hunt-sprint`（order 200，程途 · 履新 · 问达 · 薪言）、`game-kickoff`（order 210，游心 · 千衡 · 织境 · 百试）。
- **回填台账关闭**：`tactician.handoff` 追加 `comp-advisor`（AGENT.md + mock preferredOf + m21 断言三处同步）——谈薪彩排从职业发展转谈判桌；M51 回填台账全部关闭。
- **镜像面七件套**：mock.ts 四件套 ×12（SCRIPTS 12 条 / artifactFor 12 case 与交付契约对齐 / DISPLAY_NAMES 12 / preferredOf 12）+ `TOPICS` 演示词表 +1（「求职」，尾部追加既有任务零回归）+ `e2e/helpers.ts` AGENT_NAME +12（全量 97 角色 id→name 逐一相等）+ `m21.test.ts`（25 场景 / 97 角色 / 21 预设 / 协议断言 +3）+ `agents/README.md`（统计与预载表 +3 行）。
- 评测：mock 25/25 ✅（新增 `24-career`：定位 → 简历 → 面试 → offer 评估（4 回合，4 交付件）/ `25-gamedesign`：核心循环 → 数值 → 世界观 → 玩法验证（4 回合，4 交付件）；`--update-baseline` 后与基线零回归）；check:agents 25 场景 / 97 角色 / 21 预设（12 新头像 ✓）；check:skills 49 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E 回归 4/4 全绿（m12-interactions / m16-members / m21-opc）。
- 相关文档：ADR 0109、design.md §63、`docs/scene-expansion-design.md` §5.3、`docs/adr/README.md` 索引、`agents/README.md`。

### v34 — 议题圆桌：社会研讨协议与第 22 场景落地（M51-B，资产 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.2）判定「一个社会议题想看全」无承接场景（辩论场做对抗裁决、深度研究做单一课题查证）；本批落地第 22 个场景 `society`（4 新角色），把「事实核查 + 立场图谱 + 政策伦理」的多视角研讨落成可交付成果，收敛口径为「共识与分歧 + 可行建议区间」（并列收敛，不判胜负）。
- **`society` 议题圆桌（4 角色）**：order 106 / icon `globe` / theme 青蓝青绿 / chain `[moderator, fact-checker, stakeholder, policy-advisor]` / rounds + parallel（parallelMax 2）——齐观（议题主持 → `docs/议题观察报告-<主题>.md` 开场版 + 终局收口）/ 尚真（事实核查 → `docs/事实基线-<主题>.md`，skills source-verification）/ 方衡（立场图谱 → `docs/立场图谱-<主题>.md`，含间接相关方与沉默方，skills deep-research）/ 允中（政策伦理 + 可行建议区间并入观察报告终局版，skills formal-document）；`_protocol.md` 铁律 9 条 + 工具纪律 4 条（议题边界红线 / 事实分级 / 立场并列 / 政策伦理三框架 / 收敛口径 / 模拟声明）。
- **观察报告两版覆盖**：moderator 开场版（议题与边界 / 研讨轮次记录 / 共识与分歧初稿 / 模拟声明）→ policy-advisor 收口版（议题与边界 / 共识与分歧 / 政策伦理 / 可行建议区间 / 模拟声明）后者覆盖前者；mock `artifactFor` 两处同路径，eval 以「政策伦理」「可行建议区间」校验终局版。
- **回填台账关闭**：`judge.handoff` 追加 `moderator`（AGENT.md + mock preferredOf + m21 断言三处同步）——辩论需要多方视角时按 handoff 转 @齐观（议题圆桌）组织多方研讨；`tactician → career.comp-advisor` 仍待 M51-C 回填。
- **镜像面七件套**：mock.ts 四件套（SCRIPTS 4 条 / artifactFor 4 case / DISPLAY_NAMES 4 / preferredOf 4）；`e2e/helpers.ts` AGENT_NAME +4（全量 85 角色 id→name 逐一相等）；`m21.test.ts`（22 场景 / 85 角色 / 18 预设 / 协议断言 +1）；`agents/README.md`（统计与预载表 +1 行）。
- **`stage` 预写（M52-B 消费）**：`{layout: roundtable, panel: pool}`——围桌研讨语义区别于 arena 对席；本批零前端 / 零引擎改动。
- 评测：mock 23/23 ✅（新增 `23-society`：事实核查 → 立场图谱 → 政策伦理收口（4 回合，3 交付件）；`--update-baseline` 后与基线零回归）；check:agents 22 场景 / 85 角色 / 18 预设（4 新头像 ✓）；check:skills 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；build 通过；相邻 E2E 回归 4/4 全绿（m12-interactions / m16-members / m21-opc）。
- 相关文档：ADR 0108、design.md §62、`docs/scene-expansion-design.md` §5.2、`docs/adr/README.md` 索引、`agents/README.md`。

### v33 — 辩论场与谈判桌：PK 对弈协议泛化与双场景落地（M51-A，资产 / 技能 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2）判定 invest 的「多空对弈」玩法（回合制对抗 + 证据挂载 + `::: verdict` 终局裁决，M34）未泛化——通用议题的观点对抗（辩论）与利益博弈（谈判彩排）无承接场景；本批把对弈协议泛化为三场景共用模板，落地首批双场景（第 20 / 21 个场景，7 新角色）。
- **`debate` 辩论场（4 角色）**：order 102 / icon `scale` / 红蓝对撞 / chain `[judge, affirmative, negative, evidence]` / rounds + parallel（正反同波立论）——立言（正方辩手 → `docs/正方立论-<主题>.md`，skills 含 red-team）/ 砺锋（反方辩手 → `docs/反方立论-<主题>.md`）/ 昭实（证据官，中立供弹药 → `docs/证据清单-<主题>.md`）/ 明断（裁判 → `docs/辩论裁决-<主题>.md`）；`_protocol.md` 铁律 8 条（观点与证据分离 / 对事不对人 / 不偷换概念 / 回合纪律 / 诚实边界 / 中立纪律 / 模拟声明 / 议题边界）。
- **`negotiation` 谈判桌（3 角色）**：order 104 / icon `handshake` / `parallel: false`（严格串行出价）——谭成（谈判手 → `docs/谈判策略-<主题>.md`，handoff → legal / finance）/ 祁弈（对手模拟，按设定立场真实还价 → `docs/对手档案-<主题>.md`）/ 苏纵（教练复盘 → `docs/谈判复盘-<主题>.md`）；`_protocol.md` 铁律 7 条（三桩先行 / 严格串行 / 每轮记录 / 对手真实 / 模拟声明 / 合规边界 / 隐私纪律）。
- **对弈五条（三场景共用）**：回合制（默认 3 轮、每轮必须回应上一轮、禁复读）/ 挂证据与置信度 / `::: verdict` 终局复用（辩论「胜负 + 置信度 + 核心依据 + 翻盘条件」；谈判「成交区间（ZOPA）+ 得失评分 + 改进点」）/ 模拟推演声明与统一收尾 / 并行纪律按场景定；`stage: {layout: arena, seats}` 预写（M52-A 消费，零前端改动）；头像 ×7（512px 风格化 3D 卡通 v2）。
- **handoff 台账**：辩论转 `research.scout`（补证据）、谈判转 `legal` / `finance`（条款与金额）本批落地；`judge → society.moderator`（M51-B 后）、`tactician → career.comp-advisor`（M51-C 后）延后回填（validate 全局校验，先写可用目标）。
- **技能与预设**：`skills/debate`（立论反驳模板 / 逻辑谬误清单 / 裁判裁量口径）、`skills/negotiation`（三桩 / ZOPA 与锚定 / 让步纪律 / 对手建模）；预设 `classic-debate`（order 160，明断 · 立言 · 砺锋 · 昭实）、`negotiation-rehearsal`（order 170，苏纵 · 谭成 · 祁弈）。
- **镜像面**：mock.ts 四件套（SCRIPTS 7 条 / artifactFor 7 case / DISPLAY_NAMES 7 / preferredOf 7）；`e2e/helpers.ts` AGENT_NAME +7（全量 81 角色 id→name 相等）；`m21.test.ts`（21 场景 / 81 角色 / 17 预设 / 协议断言 +2）；`agents/README.md`（统计与本包预载表 +2 行）。
- 评测：mock 22/22 ✅（新增 `21-debate`：正反交锋 → 证据归拢 → 裁决（4 回合）/ `22-negotiation`：三桩 → 还价 → 复盘（3 回合）；`--update-baseline` 后与基线零回归）；check:agents 21 场景 / 81 角色 / 17 预设 通过；check:skills 48 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；build 通过；相邻 E2E 回归 7/7 全绿（m16-members / m21-opc / m26-console / m48-routing / m50-blank）。
- 相关文档：ADR 0107、design.md §61、`docs/scene-expansion-design.md` §5.1 / §5.6、`docs/adr/README.md` 索引、`agents/README.md`。

### v32 — 空场景专项：单 Agent 直聊模式全链落地（M50，资产 / 引擎 / 前端 / 评测修订）

- **动因**：用户需求「空场景指的是不引入任何角色 agent，只使用一个通用的 harness agent 对话，单 agent 模式」——M48 空编制创建是「交给平台组队」（多 Agent），业务角色单聊又携带业务人设，两条路径均不满足「不要角色分工、一个人干完」；新增第 19 个场景 `blank`「空场景」与第 74 个角色 `general`「通用助手」，补齐「零选择」路径的第三种形态（空编制 = 交给平台组队；空场景 = 一个人干完）。
- **资产**：`agents/blank/` 三件套——`_group.yaml`（order 1 / `chain: [general]` / guide「直接说出你的需求，由通用助手独立完成」/ 4 条 agenda）；`general/AGENT.md`（无业务人设 / 无 souls / 无 `handoff`，白名单 = 全量 − `handoff`：54 精确项 + `fin_*` / `mcp__*` 通配；运行时复用 M28 分层：20 项 core 常驻 + 34 项 deferred 经 `tool_search` 按需激活，零新增机制）；`_protocol.md`（单助手规则：独立完成 / 工具直用 / 交付清晰 / 收尾直接 / 汇报诚实）；`agents/README.md` 计数与 handoff 说明适配（`general` 为唯一无 handoff 例外）。
- **引擎**：`shared` 导出 `BLANK_SCENE_ID`；`launch()` 单助手直通——编制恰为 `[general]` 且场景 blank 时未 @ 消息直达本人（跳过 PRS：零 `routing:dispatched` / 零 `__router__` 用量；实时派生，加人即退出）；三层隔离——`buildRosterCatalogBlock` 目录不列 / `knownIds` 丢弃幻觉召集 / `resolveAgent` 拒「不在场」（用户手动邀请保留）；收尾零改动（单成员波波末兜底 → `turn:end.mentions=['user']` + `notify:awaiting-user`）。
- **前端**：组队台「来源」栏顶部「空场景」独立卡（微标「单 Agent · 1 位成员」）+「按场景组队」列表过滤 blank（去双入口）；命令面板 / @ 列表 / 成员选择器零特判（资产型自然生效）。
- **mock / eval**：范式信号适配（bug 修复）——`write_plan` / `submit_review` 分支原以「工具清单含该工具」判定 M24 规划 / 评审范式，而 general 白名单常驻这两者（core 分层不折叠）→ 普通消息被误判 → 发出 `write_plan` 挂起、Run 永不结束（eval `artifact_exists` 失败根因）；修复为范式信号仅对业务角色成立（`meta.agentId !== 'general'`），业务角色语义零变化；剧本镜像面（SCRIPTS / artifactFor / DISPLAY_NAMES / e2e AGENT_NAME 的 general 条目）已随 v31 登记；eval 断言器新增 `no_invite`（「`routing:dispatched` 轨迹中不存在 members 非空条目」，覆盖 PRS 召集与 handoff 增援）；新增 `evals/tasks/20-blank-scene.json`。
- 评测：mock 20/20 ✅（含新增 `20-blank-scene`：单助手直聊 → 交付件 → 交还用户；与基线对比无回归）；check:agents 19 场景 / 74 角色 通过；server 全量 75 文件 / 1031 测试全绿（含新增 `m50-blank` 9 例）；client 全量 54 文件 / 621 测试全绿（含 `m50-blank-frontend` 5 例）；E2E 新增 `m50-blank` 全绿（独立卡 → 直聊 → 反向断言无「平台 召集了 …」→ 收尾与交付件），对照回归 `m48-routing` 全绿；全量 E2E 43 条全绿（4.2m）——`m27-mcp` 三处断言按 M50 新语义适配（`general` 的 `mcp__*` 通配使「N 个工具零可达」警示对新增服务器不再出现：改反向断言 + 授权矩阵命中徽章）；四包 typecheck 0 错误。
- 相关文档：ADR 0103–0106、design.md §60、docs/blank-scene-design.md、agents/README.md。

### v31 — Mock 镜像面全量对齐：74 角色剧本与交付件补齐、防回归守护建立（实现层适配）

- **动因**：用户要求「所有的 agent 都应该符合 harness agent 的实现标准」——对全量角色做实现层镜像面审计（`server/src/llm/mock.ts` 测试替身 + `e2e/helpers.ts` 转交断言镜像），发现两类历史失配：① v14 / v15 / v16 扩张引入的 34 个角色缺 SCRIPTS 演示剧本与 artifactFor 交付件——静默走 backend 兜底（非研发角色口吐「接口我定了 3 个端点」，交付件路径缺省为通用工作笔记）；② `sre`（v16 / M32）另有三处缺失（DISPLAY_NAMES / preferredOf / e2e AGENT_NAME），五处镜像全缺。
- **mock.ts 补齐（35 角色）**：SCRIPTS 补 35 条专属剧本（development 补位 6：security / tech-writer / ai-engineer / data-engineer / ux-researcher / ux-writer；生活与职能 28：quant 之后的全部角色；blank 空场景 general——单助手直聊、无 handoff）；artifactFor 补 35 个 case，交付路径逐一与该角色 `AGENT.md`「交付契约」对齐（如 `docs/安全审计报告-<主题>.md` / `docs/事故复盘-<主题>.md` / `docs/交付件-<主题>.md`）；DISPLAY_NAMES 补 `sre: 江屿`、`general: 通用助手`；preferredOf 补 `sre: [devops, backend, qa]`（缺表条目时转交随成员顺序漂移）。
- **e2e 镜像**：`e2e/helpers.ts` 的 AGENT_NAME 补 `sre` / `general`，与 74 角色 id→name 全量相等（转交断言字面量镜像的中文名单一事实源）。
- **防回归守护（新建 `server/tests/mock-coverage.test.ts`，4 例）**：断言动态取 `lib.list()` 全量角色（不写死计数，新角色自动纳入）——① artifactFor 命中专属交付件且路径与 AGENT.md 契约对齐（占位符 `<主题> / <议题> / <课题>` 兼容）；② SCRIPTS 输出不含 backend 兜底特征串、单成员编制交还用户；③ preferredOf 正 / 逆序注入转交不漂移、首选属 handoff 且显示中文名（DISPLAY_NAMES 生效）；④ E2E AGENT_NAME 与角色 id→name 逐一相等。
- **空场景配套**：`agents/blank/general/AGENT.md` 交付契约补充默认路径 `docs/交付件-<主题>.md`（与 mock 镜像一致）。
- 评测：mock 19/19 ✅（与基线对比无回归）；check:agents 19 场景 / 74 角色 通过；server 全量 75 文件 / 1030 测试全绿（含本批新增 mock-coverage 4 例）。
- 相关文档：agents/README.md（交付件命名规范章节增补一致性守护）、design.md §7.3（镜像面标准固化）。

### v30 — Agent 级工具可达性修复与「工具-正文-协议」三方对齐（人设修订）

- **动因**：v29 场景层专业化落盘后，对全部 73 角色做双向工具审计——正向（正文提及工具但白名单未授权）与反向（白名单持有但正文未形成使用纪律）双查，消除「工具在手不知道怎么用」与「正文声明了却拿不到」两类静默失配；审计口径升级为三方对齐（角色正文 ↔ tools 白名单 ↔ 场景协议）。
- **白名单修复（13 角色）**：invest 全组 5 角色（invest-lead / analyst-fa / analyst-ta / analyst-news / quant）补画布 / 媒体四件套（canvas_read / canvas_write / media_generate / media_video；v25 多空对弈「送上画布」链路依赖）；ux-researcher / ip / fundraiser / brand / assistant / recruiter 6 角色补工具可达性缺口；fitness / wellness 补 calc（训练容量 / 睡眠债核算口径）。
- **「工具-正文」对齐（约 33 文件 / 36 处）**：把白名单已授权但正文未形成纪律的工具写进「工作方式」段，例——legal「法律依据先 web_search 找官方入口、web_fetch 拉取原文核对」；bd「合作方背景先 web_search 核实，谈判节点 date_calc 排期，合作方案 template_fill 渲染」；fitness「训练容量（组 × 次 × 负重）与热量估算用 calc 核算」；travel「预算表用 csv_analyze 汇总」；ux-writer「无障碍用词与平台文案规范先 web_search / web_fetch 核实并标注来源」。
- **审计终态**（三方口径全量复跑）：反向残留仅 canvas / media 四件套（平台系统面——引擎注入的画布与媒体能力，全员持有、按需使用，不逐一人设声明）与 10 处场景协议覆盖项（marketing 数据来源条款 ×6 / invest 数字纪律 ×3 / ops 时间纪律 ×1）；正向残留仅 bi「只读取数不写库（无 db_execute）」职责边界声明（有意为之）。
- 评测：mock 19/19 ✅（与基线对比无回归）；check:agents 18 场景 / 73 角色 / 15 预设 通过；server 全量 73 文件 / 1018 测试全绿。
- 相关文档：本日志 v29（场景层同批）、agents/README.md 工具白名单章节。

### v29 — 场景资产全量专业化：18 场景协议补齐与描述 / 引导 / 议程细化（资产修订）

- **动因**：用户要求「列举所有支持的场景，对每个场景进行专业化、细化、丰富的优化」。横向对标发现专业化程度参差：8 个场景有专属协议（strategy / development / sre / brainstorm / research / finance / invest / bi），其余 10 个场景仅有元数据无协议；部分场景 description 偏简、agenda 仅 3 条、guide 未场景化。
- **场景协议补齐（10 新增，18/18 全量具备）**：对齐既有「铁律 / 协作 / 交付」三段式，逐场景定制——funding（材料真实性 / 披露纪律 / 估值与条款 / 沟通节奏 / 数字纪律 / 不越权承诺）、marketing（指标口径先行 / 数据与来源 / 合规红线 / 品牌一致性 / 实验纪律 / 发布节奏）、health（医疗红线 / 渐进原则 / 不承诺数字 / 数字纪律 / 安全查证 / 隐私保护）、home（安全第一 / 清单化 / 预算意识 / 家庭协作 / 低负担 / 隐私）、learning（目标先行 / 输出检验 / 循序渐进 / 练习设计 / 正向反馈 / 内容准确性）、ops（流程可执行 / 时间纪律 / 承诺边界 / 隐私保护 / 数据纪律）、sales（承诺边界 / 报价纪律 / 客户信息保护 / 服务口径 / 跟进纪律 / 数据真实）、personal（陪谈边界 / 不评判 / 最小行动 / 隐私保护 / 事务可闭环 / 提醒纪律）、travel（时效信息必核实 / 不代办预订 / 预算透明 / 节奏留白 / 安全预案）、wealth（不推产品 / 不承诺收益 / 风险匹配先行 / 数字纪律 / 财务隐私 / 边界声明）；每份协议含成员分工、跨场景交接与成员各自落盘的交付件路径。
- **_group.yaml 细化（17 个）**：description 全量充实（18 场景统一切面：定位 + 能力清单 + 原则 / 边界）；guide 空态引导场景化（如「开始第一次研发接力」「说说你的健康目标与现状」「交办一件家里的事」）；agenda 议程 3→4 条、prompt 专业化细化（覆盖各场景高频任务；development 首条「需求澄清」原文保留以兼容 e2e 断言）。
- **角色人设专业化（13 个）**：ux-researcher / ip / fundraiser / fitness / wellness / brand / assistant / recruiter 与 invest 五角色（invest-lead / analyst-fa / analyst-ta / analyst-news / quant）的 description 与职责条目细化（补齐工具纪律、职责边界与协同接口）。
- **镜像面适配**：`agents/README.md` 场景协议条目更新为「本包 18 场景已全量具备」；`server/tests/m21.test.ts` 协议断言 +sales（报价纪律）；m29 / m30 回归断言 +sales，m32 / m35 回归断言 +marketing（实验纪律）。
- 评测：mock 19/19 ✅（与基线对比无回归）；check:agents 18 场景 / 73 角色 / 15 预设通过；server 73 文件 / 1018 测试、client 51 文件 / 602 测试全绿（含协议断言 m21 / m29 / m30 / m32 / m35 / m48-roster）；E2E `m37-scene-chat` 2/2 通过（议程 chips / 结构化容器断言兼容）。
- 相关文档：agents/README.md、design.md §52（场景资产 guide / agenda 机制）。

### v28 — 调度平台化：撤销调度官「知舟」，调度上收引擎（M48，资产 / 引擎 / 接口 / 前端修订）

- **动因**：用户反馈——调度官「引入了一个新角色，感觉怪怪的」；原则「所有 agent 都应是单一业务 harness agent」——意图识别与阵容召集是**平台能力**，不应人格化为资产角色；M46 系列的 `dispatch` 特例税（资产 schema / 校验 / 控制台 round-trip / 前端徽标）与机制噪音（接手护栏 / 恒 execute / 收口波等三轮补丁）同步清零。
- **资产修订**：删 `agents/harness/`（「智能协作」场景 + 「知舟」人设）；`dispatch` front-matter 字段从 `AgentDefinition`（shared）/ `check:agents` 校验 / 控制台编辑 round-trip 全链移除；计数 19→18 场景、74→73 角色；`_presets.yaml` 无引用（预设 15 不变）。
- **引擎修订**：新模块 `server/src/orchestration/platform-router.ts`（**平台路由步 PRS**）——未 @ 消息 / 空编制开场由引擎执行一次结构化 LLM 调用（json_schema `platform_route`、`__router__` 哨兵、`kind='turn'` 用量、非角色回合：不产生消息 / 不占波次 / 不进交接队列），输出「members 召集 + assignments 派发（1–4 位有序）+ reason」；启动三分支（@ 直达 / 显式 plan·review 直投编制首位 / 路由）；引擎应用 = 召集先落库（`inviteMembersCore`，actor「平台」）+ 任务便条注入（from「平台」）+ 队列填充；降级（有编制 → 在场首位接手；空编制 → 系统事件条提示收尾，绝不静默）；handoff 未在场目标**自动召集**（source='handoff'）；trace `routing:dispatched` 三形状（召集 / 派发 / 降级），复用 ADR 87 目录注入与 ADR 89 惰性 participants。
- **接口 / 工具面**：`POST /sessions` 空编制合法（`participantIds: []` 不再填充调度官）；`invite_members` 工具移除（56→55）；召集三路（PRS / handoff 增援 / 成员 API）共用 `inviteMembersCore`。
- **前端**：删 `DispatchBadge` 与调度官预选；空编制建会话流（0 人提交 = 「空编制创建 · 交给平台组队」，提示「未选成员：首条消息将由平台自动组队并派发任务」）；CommandPalette 快捷新建直建空编制会话；空态引导「直接描述你的需求，平台将自动组队并派发任务」；TraceDrawer 三形状渲染。
- **影响面**：`agents/` 资产、`server` 引擎（platform-router 新建 + engine / assembler / registry 清理）、`shared` 类型、`client` 组件与测试、`evals`（任务重写）、`e2e`；M46 系列 ADR 82–91 / 95 中 8 条 Superseded、3 条 Amended（见 ADR 0101）。
- 评测：mock 19/19 ✅（`18-platform-routing`：零编制三回合——平台召集 → 接力 → 交付；与基线对比无回归）；check:agents 18 场景 / 73 角色 通过；check:skills 46 通过；server 1018 / client 602 测试全绿（新增 `m48-routing` / `m48-roster` / `m48-frontend`）；E2E 全量 41 条全绿（`m48-routing` 2 条）；四包 typecheck 0 错误。
- 相关文档：ADR 0101、design.md §57、docs/harness-dispatch-design.md（收档注记）。

### v27 — 工具可用性门控与失败语义收敛（M47，引擎 / 工具层修订）

- **动因**：生产库 `tool_metrics` 全量取证（593 次调用 / 17 次失败）定位六类系统性失败根因——环境未启用但清单可见（web_search / web_fetch）、整组关闭 + 泛化「未知工具」（fin_*）、正常态被记为失败（tool_search）、中断被计入失败（write_file / remember）、报错不可行动（calc）、负向业务结果（write_plan，保持原语义）。用户侧表现为网络工具与 fin_* 反复红卡失败、停止运行也算「工具失败」。
- **可用性门控**（`server/src/tools/availability.ts` 新建）：`toolUnavailableReason` 集中判定 web_search / web_fetch / run_command 三类环境门（统一 DISABLED_SUMMARY 文案含「改哪个配置后重启」指引）；`GIT_TOOL_NAMES` / `isGitToolName` 供会话模式门复用；引擎清单过滤——未启用工具不进模型 schema 与 `tool_search` 可发现范围（执行期守卫保留作双保险）。
- **引擎修订**：`EngineDeps.isGitMode` 会话模式门（sandbox 无仓库 → git 6 工具不进清单；缺省 = 不判定，eval / 单测零差异）；`discoveryGate` 仅对本回合可发现范围内的延迟工具给检索引导；中断语义收敛——新增 `'stopped'` 状态（用户停止 / 回合超时：不落失败指标 + trace `aborted:true`），停止导致的审批取消同归，用户驳回 / 审批超时仍为 `error`。
- **registry 修订**：`markUnavailable`（整组关闭登记「已知但未启用」→ 执行期返回精确配置指引）、`unavailableNames`（控制台白名单校验合并该清单，编辑引用 `fin_*` 的角色不再误报）、`describeParamIssue`（zod 必填中文化）；`tool_search` 未装配 / 发现未启用 → `direct:true` 非失败语义；`calc` 函数报错附 usage 签名（参数个数类错误一步自愈）。
- **共享类型与前端**：`ToolCallRecord.status` 新增 `'stopped'`（shared）；ToolCard 琥珀 `CircleSlash` 呈现（不再是红卡）；`index.ts` 装配 isGitMode 与控制台 toolNames 合并。
- **影响面**：`server` 引擎 / registry / 工具层与 `shared` / `client` 共享类型；**未触碰 `agents/` 资产与提示词**（check:agents 19 场景 / 74 角色 / 预设 15、check:skills 46 均通过，不受影响）。
- 评测：mock 19/19 ✅（与基线对比无回归）；server 全量 1027 测试全绿（新增 `m47-tool-availability` 9 例，m28 / m7 适配）；client 571 全绿；E2E 全量 41 条全绿；四包 typecheck 0 错误。
- 相关文档：ADR 0099、design.md §56。

### v26 — 撤除主区「行情」Tab（M34 呈现形态修订，纯前端）

- **动因**：承接 v25 / ADR 97「独立面板是功能孤岛」的复盘结论——「行情」Tab 的自选列表与盯盘轮询发生在会话之外，与「证据 → 讨论 → 交付件」协作主线无交集；K 线的看盘诉求已由会话 ```kline 块 / 画布 KlineNode / Agent canvas_write 三形态覆盖。用户明确要求删除行情面板。
- **前端**（无 agents 资产变更）：移除 `FinanceView` / `KlinePanel` / `trading-hours` 组件与 AppLayout Tab 触发（含懒加载）、Command Palette「行情 / 自选」入口、`MainTab` 的 `'finance'`、`.finance-kline-canvas` 样式；`finance-api` 收缩为仅 runGame 通道（面板专用端点封装与 `useFinanceEnabled` 移除）；面板单测删除、runGame 契约测试迁移至 `m34-finance-api.test.ts`。服务端网关 / `fin_*` 工具 / `finance_watchlist` 存储 / `FINANCE_ENABLED` 门控原样保留（`fin_watch` 工具文案同步去掉「行情 Tab」字样）。
- 评测：纯前端视图层收缩，未触碰 agents/ 资产与提示词；check:agents / eval mock 基线不受影响（未重跑）。
- 相关文档：ADR 0098、design.md §53.3 修订注记、docs/finance-invest-design.md §6.2、README。

### v25 — M34 呈现形态修订：K 线 / 博弈入会话与画布、多空对弈协议链路（协议 / 预设修订）

- **动因**：产品形态纠偏——K 线 / 博弈应是 chat / 画布上的特殊交互（不是单独面板、不是单机沙盘），博弈要让 agent 之间真实对抗、输出可追责的终局结果。原主区「博弈」Tab + GameLab 面板是功能孤岛（结果要人肉搬回对话、无 agent 参与），**修订**为：撤「博弈」Tab 与 GameLab；K 线 / 博弈收敛为「会话内块 × 画布节点 × Agent 通道」三形态（块含「送上画布」，节点含 GameNode / KlineNode，通道为 canvas_write 的 game / kline 类型）；博弈升级为协议驱动的 agent 对抗链路。
- **协议修订**（`agents/invest/_protocol.md` +4 条「多空对弈」）：① 触发与阵容——fa 持多方 × ta 持空方正面对抗；news 只供双方证据弹药（附信源等级）不站队、不预判；quant 用 `fin_game` 逐轮量化走子；lead 终局裁决；② 回合纪律——每轮 = 多方立论 → 空方立论 → quant 走子 → lead 记录；立论须挂证据与置信度、回应对方上一轮论据；默认 3 轮，可指定轮数或叫停；③ 走子口径——取双方认可参数（对抗收益 matrix / 攻守次序 sequence / 筹码情绪 evolve·simulate），争议按区间或情景双跑并列，附种子复现；④ 终局裁决——胜负（多方 / 空方 / 僵持）+ 置信度 + 核心依据 + 翻盘条件，以 `::: verdict` 容器落卡并声明「模型推演，非涨跌预测」。
- **资产修订**（`agents/invest/`）：`_group.yaml` agenda 增「多空对弈」入口；`_presets.yaml` 预设 14 → 15 增 `bull-bear-duel`「多空对弈」（五角色全链，order 150）；无角色人设改动。
- **mock 剧本**（`server/src/llm/mock.ts`）：新增 `DUEL_SCRIPTS` 对弈专属剧本（多方 / 空方立论对峙、证据弹药按双方归堆、走子「对抗矩阵 0.62:0.38 + 序贯逆向归纳」、主管 verdict 裁决卡）与「博弈推演」交付件（`docs/博弈推演-<主题>.md`）。
- **工具面**：`canvas_write` / `canvas_read` 支持 `game` / `kline` 节点类型（zod 枚举 + 摘要 digest：博弈「有结果 / 配置态」、K 线「标的 / 名称 / 周期 / 根数」）——Agent 可把 `fin_game` / `fin_kline` 产物直接落画布。
- **前端**：画布新增 `GameNode`（配置态：模型 / 标的 / 话题 / 场景预设 / 高级参数（种子 + 模型参数）→「运行推演」直连纯计算；结果态与消息块共用 `GameResultView`内核；agent 或「送上画布」写入自动切结果态）与 `KlineNode`（空态「拉取行情」/ 结果态周期复权切换 + 刷新，写回节点）；创建菜单 +2（博弈推演 / K 线行情）；GameBlock / KlineBlock 工具条新增「送上画布」；新增 `::: verdict` 终局裁决卡（remark 解析 + VerdictCard 渲染 + raw 兜底）；撤「博弈」Tab 与 GameLab（AppLayout / CommandPalette / ui-store 同步，测试适配）。
- 评测：mock 19/19 ✅（新增 `19-bull-bear-duel`：三路交锋并行 → 量化走子 → 终局裁决，turns_lte 7；断言含 5 交付件 / 翻盘条件 /「模型推演」标注；与基线对比无回归）；check:agents 19 场景 / 74 角色 / 预设 15 通过；check:skills 46 通过；E2E 全量 41 条全绿（m34-invest 3 条 + markdown-ext verdict 用例，真实浏览器）；四包 typecheck 0 错误；server 1017 / client 583 测试全绿。
- 相关文档：design.md §53（修订注记）、docs/finance-invest-design.md §6.4、ADR 0097、README。

### v24 — 调度派发修复、收口波与串行执行（M46-2，协议 / 人设修订）

- **动因**：M46 上线后的真实故障修复批次（头脑风暴会话连续三次复现，run_7b3fda05 / run_43713c38 / run_78ecb13b）——调度官同一条消息「先派发成员、末尾 @用户 报备」被波合并误判为全员交还，accepted 静默丢弃、Run 结束、交付件从未产出（用户反馈「没有汇总给我」）。
- **协议修订**（`agents/harness/_protocol.md` 调度纪律第 5 条）：收口语义对齐收口波机制——业务收尾由成员各自完成，全链交还用户后调度官还会收到一次「收口汇总」回合（核对关键交付件、向用户交摘要并以 @用户 结尾）；收口回合不再派发新任务。
- **人设修订**（`agents/harness/harness/AGENT.md`）：职责段收口汇总同步（系统追加「收口汇总」回合的语义）；协作接口段新增「用户交互节奏」行——确认（我理解的任务）→ 派发（谁来做）→ 收口（做完了什么）。
- **引擎侧**（同批落地，见 ADR 94–96）：派发优先于交还报备（mergeWaveSchedule 先收集 accepted 再判交还）；调度收口波（engine `maybeAppendDispatchCloseout` + assembler【收口汇总】指令 + `dispatch:closeout` trace，每 Run 一次）；会话级串行执行默认开启（迁移 v12 + PATCH API + TaskView 芯片）。
- 评测：mock 19/19 ✅（`harness-dispatch` 剧本更新为含收口波的 5 回合链路，turns_lte 8；与基线对比无回归）；`check:agents` 19 场景 / 74 角色通过；server 1017 / client 583 测试全绿（含 `applySession` 缺省语义字段回归 1 例）；E2E 新增 `m16-serial` 2 条 + `m46-harness` 增收口波与交付件断言 + 并行专项 `disableSerial` 适配（全量 41 条全绿）；四包 typecheck 0 错误。
- 相关文档：design.md §55、ADR 0094–0096。

### v23 — 调度官头像资产（M46 收尾）

- **新增 `agents/harness/harness/avatar.png`**：512×512，v2 风格化 3D 卡通口径（成人比例约 1:4 / 半身像居中 / 纯白背景 / 柔和棚拍光 / 哑光黏土质感）——35 岁东亚男 · 从容沉着；黑色利落短发（清爽侧分）、深灰西装 + 靛蓝衬衫 + 挂绳工牌，持节点连线平板；靛蓝主题色 `#4f46e5` 呼应 harness 场景（`waypoints` 图标同源）。
- **同步资产面**：design.md §19.3 设定表新增 `harness · harness` 行；§19.1 / §19.2 计数同步（19 场景 74 角色、头像 74/74 齐备，暂缺标记移除）。
- **评测**：头像为静态图片资产、不入提示词（v17 先例）；`npm run check:agents` 19 场景 / 74 角色通过。

### v22 — 投研协作链修订与 golden 任务（M34 批 D）

- **动因**：把投研小队从「资产就位」推进到「协作链可验证」——两条预设链路（投研快评 / 策略研究）全部脚本化，进入 eval 与 E2E 常驻基线。
- **协作编排修订**：`invest/_group.yaml` 增 `parallelMax: 4`（四路分析同波上限 = 全组）；`_presets.yaml` 两条预设 prompt 重写——分析师显式 @（快评 = 雷动 + 闻笛两路；策略研究 = 秦砚 + 雷动 + 方程三路），主管不由 @ 入波、独立成收敛波，并内嵌主题词（「业绩增长」/「增长主线」）使 mock topic 提取稳定命中。
- **mock 剧本（确定性基线）**：`server/src/llm/mock.ts` 新增 5 角色剧本与 5 份交付件 case（投研报告 / 基本面分析 / 技术面分析 / 舆情简报 / 策略方案，路径与 AGENT.md 交付契约一致）。
- **golden 任务（15 → 17）**：invest-quick-review（3 回合：主管 → 技术面 → 舆情面 → 交还；turns_lte 4）、invest-strategy-research（4 回合：主管 → 基本面 / 技术面 / 量化 → 交还；turns_lte 5）；断言链含交付件存在 / 关键节 / handoff_targets / 无回环。
- **E2E 新增 `m34-invest`（2 条）**：preset 建会 → 草稿预填 → 两路 / 三路并行（并行协作组「雷动、闻笛」/「秦砚、雷动、方程」）→ 主管收口 → 交还用户 → 3 / 4 份交付件；`openApp` 增首载兜底（webServer 冷启动竞态重载一次）。
- 评测：mock 17/17 ✅（新增 2 任务，基线已刷新）；check:agents 19 场景 / 74 角色通过；check:skills 46 技能通过；server 987 测试全绿；E2E 全量 34 条全绿。

### v21 — 通用调度官与意图路由（M46，+1 场景 / +1 角色 / +1 工具）

- **动因**：M46 通用调度官与意图路由专项上线——新会话可不选成员直接开聊，由「调度官」接手意图识别、阵容召集与任务派发；此前无 @ 消息盲投编制链首位（engine.ts 首发队列），不做任何意图识别。
- **新增场景 harness（智能协作，order 1 置顶）**：单角色编制「知舟（总调度 / Dispatcher）」——持 `dispatch: true`（新增 front-matter 字段，全局至多一个，`validate()` 与 `check:agents` 双层校验）；四段骨架（职责 / 工作方式 / 交付契约 / 协作接口）+ `_protocol.md` 调度纪律 6 条（意图四分类 / 最少必要召集 / 派发必附期望产出 / 闲聊直答交还 / 不越权替成员干活 / 调度说明 ≤120 字）。
- **工具白名单（最小协作集）**：只读检索（`tool_search` / `memory_search`）+ 协作原语（`handoff` / `invite_members` / `remember` / `write_todos` / `request_approval` / `load_skill`）；不持写类与业务工具（`calc` / `template_fill` / 文件写类等一律不给），确保调度官不越权产出业务交付件。
- **dispatch 字段全链路**：`AgentDefinition.dispatch?: boolean`（shared 类型）→ AGENT.md schema（prompts.ts）+ 唯一性校验 → 控制台字段序与 round-trip 保留（编辑不丢 / 复制不继承，manager.ts）→ `check:agents` 输出 `dispatch:✓`。
- **引擎路由（四分支）**：@ 直达（零变化）→ 消息级显式 plan / review 直投首位业务成员 → 无 @ 交调度官 → 兜底编制链首位；插话补位同优先级（@ > 调度官 > 首位未发言者 > 编制链首位）；调度波恒 execute（planFirst 顺延业务首波消费）；接手护栏同 Run ≤3 次，超出按缺席路径兜底、不中断 Run。
- **召集闭环**：新工具 `invite_members`（core tier，仅调度官白名单可见；`agent_ids` ≤20 / `scene_id` 整链，已含成员幂等跳过）+ 共享内核 `inviteMembersCore`（与成员 API 同源：校验 / 排序 / 事件条 / 广播；措辞「召集了」）；工具运行时惰性 `participants`（getter）支持同回合「先召集后派发」；调度官回合注入 `roster_catalog`（未在场角色目录，LRU 32 + 内容签名热更新）。
- **前端**：三步流默认预选调度官（可取消；0 人提交「交给调度官 · 0 位成员」）；CommandPalette「新会话」由全量编制改为仅调度官（修复 68 人全会话缺陷）；`DispatchBadge`「调度」徽标四处复用（AgentPicker / 三步流提示条 / 成员卡 / 消息头）。
- **影响面**：`agents/harness/` 三资产新建；`server/tests/m21.test.ts`（场景 19 / 角色 74 / 协议断言 / M46 dispatch 唯一性两用例）；`agents/README.md`（dispatch 字段说明 + 74 角色协作基线 + 技能表 harness 行）；`client/src/lib/avatar-icons.ts`（waypoints 图标注册）；无既有角色 / 协议 / 技能改动。
- **测试**：server 2 套件 34 例（`m46-dispatch` 12：四分支路由矩阵 / planFirst 顺延 / 接手护栏 / 成员增援回路；`m46-roster` 22：内核分支 / 工具契约 / 目录渲染与缓存 / 调度回合指令与成员增援行）；client 1 套件 9 例（`m46-frontend`：三步流 / CommandPalette / 徽标）；e2e `m46-harness` 2 条；tools 计数 56（core 22 / deferred 34）。
- 评测：mock 18/18 ✅（新增 18-harness-dispatch：调度官召集 → 三交付件 → 交还；基线已刷新）；check:agents 19 场景 / 74 角色通过；check:skills 46 通过；server 1012 / client 572 测试全绿；E2E 全量 36 条全绿；四包 typecheck 0 错误。
- 相关文档：design.md §54、ADR 0082–0091、docs/harness-dispatch-design.md。

### v20 — 投研场景与角色资产（M34，+1 场景 / +5 角色 / +5 技能 / +2 预设）

- **动因**：M34 金融投研专项上线（`fin_*` 12 工具 + 行情 Tab + 博弈实验室），需要一支投研小队把工具链沉淀为「四路独立分析 → 交叉检验 → 主管收口」的协作资产，产出数据可溯、观点与事实分离的投研成果。
- **新增场景 invest（投资研究，order 62，finance 之后 bi 之前）**：theme `#dc2626`（A 股涨色，与 finance 绿区分），`parallel: true`（四路分析可同波并行），chain `[invest-lead, analyst-fa, analyst-ta, analyst-news, quant]`；场景协议「投研纪律九条」（数据可溯 / 不臆造 / 观点与事实分离 / 概率思维 / 风险先行 / 免责声明 / 工具纪律 / 分工与裁决 / 模拟推演不越界）。
- **新增 5 角色**：invest-lead 祝衡（投研主管，报告收口）、analyst-fa 秦砚（基本面）、analyst-ta 雷动（技术面）、analyst-news 闻笛（舆情面）、quant 方程（量化策略师：策略回测 + 博弈推演）；四段骨架（职责 / 工作方式 / 交付契约 / 协作接口）+ 独立交付件（投研报告 / 基本面分析 / 技术面分析 / 舆情简报 / 策略方案·博弈推演）。
- **工具绑定（可达性纪律）**：12 个 `fin_*`（tier=deferred，经 `tool_search` 检索激活）按职责分权——invest-lead 全量 12 个；analyst-fa 7 个（fundamental/fund 子集）；analyst-ta 6 个（indicator 子集）；quant 9 个（indicator/backtest/screen/fund/game）；analyst-news 4 个；全部含协作基线 `handoff`，正文带「先 `tool_search` 检索激活」引导。
- **新增 5 技能（41 → 46）**：technical-analysis（K 线语言 / 指标误区 / 多周期共振）、fundamental-analysis（三表 / 估值三口径 / 排雷清单）、investment-strategy（规则化 / 回测口径七要素 / 参数敏感性）、market-news-analysis（事件分级 / 预期差 / 信源等级）、game-theory-trading（博弈映射 / 纳什速算 / ABM 参数化 / 反模式）。
- **新增 2 预设（12 → 14）**：invest-review「投研快评」（invest-lead + analyst-ta + analyst-news）、strategy-research「策略研究」（quant + analyst-fa + analyst-ta + invest-lead）。
- **头像 5 张**：512×512，v17 风格化 3D 卡通（祝衡深蓝西装 + 趋势线平板 / 秦砚金丝眼镜 + 财报册 / 雷动卫衣 + K 线平板 / 方程黑框眼镜 + 回测曲线 / 闻笛耳麦 + 快讯屏）；客户端图标注册表新增 `candlestick-chart` / `calculator` / `newspaper`。
- **影响面**：`server/src/llm/mock.ts`（DISPLAY_NAMES +5、preferredOf +5，与 AGENT.md handoff 一致）；`server/tests/m21.test.ts`（场景 18 / 角色 73 / 预设 14 + M34 工具绑定断言）；`agents/README.md`（统计与预载表）；无既有角色 / 协议 / 技能改动。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 18 场景 / 73 角色通过；check:skills 46 技能通过；server typecheck 0 错误。

### v19 — 8 角色定时任务能力绑定（M35）

- **动因**：M35 会话级定时任务上线（创建 / 查看 / 管理三件套 + 右栏「定时」面板 + 到点注入消息的「定时」徽章），让「到点自动推进」成为协作原语；时间敏感型角色按可达性纪律获得调度能力。
- **绑定角色（8）**：ops/assistant（日程与催办）、ops/ops（例会与检查点）、sre（观察窗口与巡检）、finance/compliance（申报与整改节点）、marketing/content（发布节奏与定稿审查）、sales/success（续费窗口与陪跑节点）、research/scout（长周期课题巡检）、personal/life-admin（账单与证件到期）——tools 追加 `schedule_task` / `list_schedules` / `manage_schedule`（插入于 `load_skill` 前）；其余 60 角色不持有（能力不扩散：deferred 可发现范围 = 白名单）。
- **工具语义**：`schedule_task` 建任务（run = 到点让目标成员开工，目标须为会话内成员；remind = 纯提醒零 token）；`list_schedules` 清单（只读）；`manage_schedule` pause / resume / remove / run_now。三者 `tier=deferred`（经 `tool_search` 检索激活，渐进披露）。
- **护栏**：每次触发 / 变更发 `notify:schedule-changed` 与 `notify:schedule-reminder`（右栏面板实时可见，透明可审计）；cron 最小间隔 5 分钟（高频轮询拒绝）；会话忙时自动 skip 留痕、连续失败 3 次自动暂停；跨会话任务一律拒绝。
- **引导（三处，对齐 v16 ssh 先例）**：① 8 角色正文各补一句场景化用法 + 「先 `tool_search` 检索激活」；② 全局协议 `<tool_policy>` 补定时任务纪律（激活方式 / 最小间隔 / 与 `write_todos` 区隔——会话内待办用 todos、跨时间的自动化用定时）；③ 场景协议 sre（观察窗口纪律）/ finance（申报与整改节点）/ research（长周期课题）各补一条场景化纪律（编号顺延）。
- **影响面**：8 角色 tools 字段 + 3 项与正文职责句；`agents/_protocol.md` + 1 条；3 个场景协议各 + 1 条；无角色职责边界、人设与 handoff 变化。
- **测试**：新增 `m35-schedule-bindings.test.ts`（11 断言：白名单可达性 / 持有者集合精确匹配 / 非绑定角色抽查 / deferred 与只读契约 / 正文·全局·场景三处引导在场 / 运行时绑定 / plan 范式收敛）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 17 场景 / 68 角色通过；server typecheck 0 错误。

### v18 — 全角色工具白名单补入画布创作四件套（M31）

- **动因**：M31 无限画布与媒体创作工作台上线（会话级画布 Tab / 脑图工坊 / 媒体生成面板），新增 4 个工具 `canvas_read` / `canvas_write` / `media_generate` / `media_video`；协作与创作能力为场景无关，按可达性纪律补入全部 68 角色 tools 白名单（含后续里程碑新增角色）。
- **工具语义**：`canvas_read` 读画布摘要（节点 / 连线 / 单节点详情）；`canvas_write` ops 批量写入（add_node / update_node / remove_node / connect / remove_edge，经 CanvasStore 版本化落盘并广播前端合流）；`media_generate` 文生图・图生图；`media_video` 文生・图生・首尾帧视频。四者 `tier=deferred`（经 `tool_search` 检索激活，渐进披露）。
- **护栏**：媒体创作以「会话显式绑定媒体连接」为最小权限前提——未绑定 / 未声明能力时工具返回「去连接中心绑定」引导（与画布生成面板同一纪律）；任务可见可取消（生成面板进度 / 取消 / 再生成），生成量由用户控制；输入素材限定工作区相对路径且必须真实存在；媒体任务「创建即返回」（异步长任务不经工具通道同步等待），产物落位由任务 canvasTarget 驱动前端自动放置。
- **影响面**：68 角色 tools 字段统一追加 4 项（插入于 `load_skill` 前）；无角色职责、协议与人设正文变化。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 17 场景 / 68 角色通过；server typecheck / lint 0 错误。

### v17 — 全角色头像重设计：风格化 3D 卡通（68 张）

- **动因**：后续批次新增角色面部同模（同一「大眼 + 光滑脸 + 微笑」模板），「很多脸都长的一样」；全量升级为更卡通、更可辨的第二版形象系统（风格与设定表见 design.md §19）。
- **风格升级（v2）**：从「准写实 3D 电影质感」重设计为「风格化 3D 卡通」——成人比例（约 1:4 头身，非 Q 版）、五官圆润简化、眼神略夸张、哑光黏土质感、色彩明快；统一纯白底 + 半身构图（头部占画面高约 55%）+ 柔和棚拍光，16–96px 小尺寸可辨识性提升。
- **脸部差异化**：以「年龄 × 性别 × 脸型 × 发色发型 × 眼镜 / 胡须 × 肤色 × 职业道具」七维设定逐一区分（68 角色设定表已同步 design.md §19.3）；西式命名角色保持欧美面孔、中文命名角色保持东亚面孔，年龄带 24–52 岁错开。
- **覆盖范围**：17 场景 68 张全量替换（含 M32 新增 sre/江屿——炭灰技术卫衣 + 青柠挂饰 + 脉冲监控手持终端，替换 v16 初版形象）；无图 / 加载失败仍回退渐变 + 图标，回退链不变。
- **资产与备份**：512×512 PNG（1024px 生成后压缩）；`agents/<场景>/<id>/avatar.png` 自动发现与 `/api/agents/:id/avatar` 直出不变；旧头像备份于 `data/avatar-backup-2026-09-17/`（本仓无 Git，替换不可逆，清理前先确认范围）。
- 评测：mock 15/15 ✅（与基线无回归；头像为静态资产、不入提示词）；check:agents 17 场景 / 68 角色通过；client 头像组件测试 5/5 全绿。

### v16 — SRE 场景与 SSH 事故响应管道（M32，+1 角色 / +1 场景）

- **新场景 sre（站点可靠性）**：单角色编制「江屿（SRE 工程师 / Site Reliability Engineer，temperature 0.3）」——把 M23 已建成的 SSH 远程执行能力（会话绑定 / allowExec 开关 / 审批门 / 30s 超时与输出截断）组合为 **生产事故响应管道**（分级 → 止血 → 证据采集 → 定位 → 修复验证 → 复盘）；交付件 `docs/事故复盘-<主题>.md`（时间线含证据出处）与 `docs/可靠性方案-<主题>.md`（SLI / SLO / 容量）；与 devops（发布交付）/ backend（代码修复）/ qa（回归验证）职责切割（运行态保障归 sre、变更交付归 devops、代码修复归 backend、回归验证归 qa）。
- **工具白名单（运行态只读边界）**：`ssh_exec`（远程诊断核心通道）+ `run_command` + git 只读三件套 `git_status` / `git_diff` / `git_log`（变更定位；不含写类——SRE 不提交代码）+ 文件集 + `calc` / `date_calc` / 检索 + 协作基线；handoff `[devops, backend, qa]`；不持 `db_*`（取数归 bi 场景）。
- **场景协议 `sre/_protocol.md`**（第五个场景协议）：七条铁律 + 协作三条（证据先行 / 止血优先变更报批 / SSH 使用纪律 / 变更即可疑 / 时间线纪律 / 复盘无责 / 数据安全脱敏 / 分工 / 与 development 交接 / 数据丢失风险先 @用户）；含 `ssh_exec`「先 `tool_search` 激活」的引导条（deferred 工具在角色正文 / 协议 / 技能三处引导）。
- **新技能 incident-response**（41 技能库）：事故响应手册——SEV1-3 分级表 + 五步响应 + SSH 诊断命令库（systemctl / journalctl / df / free / dmesg / top / ss / curl / lsof）+ 定位检查表 + 时间线与度量（MTTD / MTTA / MTTR）+ 无责复盘模板 + SLO / 错误预算基础 + 反模式；sre 预载 `[incident-response, debugging]`（debugging 复用 M29 缺陷定位六步法）。
- **预设 +1**：incident-response（线上故障响应：sre 止血 → devops 回滚 → backend 修复 → qa 回归），预设 11 → 12 条。
- **图标注册表 +1**（avatar-icons.ts）：activity；sre 头像 512×512 3D 卡通（深色夹克 + lime 内搭 + 手持监控仪表盘笔记本，主题色 lime `#84cc16`）。
- **测试**：新增 `m32-sre.test.ts`（16 断言：白名单可达性 / 只读边界 / deferred 契约 / 运行时绑定与范式收敛 / 方法论文档在场 / devops 发布通道不回退）；`m21.test.ts` 适配 17 场景 / 68 角色 / 12 预设 / 场景协议断言 +sre。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 17 场景 / 68 角色通过；check:skills 41 技能；server + client 测试全绿。

### v15 — BI 场景与 NL2SQL 取数管道（M30，+1 角色 / +1 场景）

- **新场景 bi（商业智能）**：单角色编制「沈析（BI 分析师 / BI Analyst，temperature 0.3）」——把 M22/M23 的数据库连接能力（连接中心 / 只读护栏 / 审批门）与 M21 业务工具（csv_analyze / calc）组合为 **NL2SQL 取数管道**（口径 → 库表探索 → SQL → 校验 → 解读）；交付件 `docs/BI分析-<主题>.md`（附录含 SQL 原文与口径，可复现）；与 insight（经营解读）/ finance（财务口径）/ data-engineer（管道治理）职责切割（取数归 bi、解读归 insight、治数归 data-engineer、财务口径归 finance）。
- **工具白名单（只读取数）**：db 只读三件套 `db_list_connections` / `db_schema` / `db_query`（不含 `db_execute`，与 qa 同先例）+ 文件集 + `csv_analyze` / `calc` / `date_calc` + 协作基线（`handoff` / `remember` / `request_approval` / `write_todos` / `load_skill`）；handoff `[insight, finance, data-engineer]`。
- **场景协议 `bi/_protocol.md`**（第四个场景协议）：取数纪律六条铁律（口径先行 / 只读取数 / SQL 纪律 / 结果校验 / 数据安全脱敏 / 可复现）；含 db 工具「先 `tool_search` 激活」的引导条（deferred 工具在角色正文 / 协议 / 技能三处引导）。
- **新技能 nl2sql**（40 技能库）：NL2SQL 取数手册——六步法 + SQL 生成规范（显式列 / JOIN 验键 / 时区 / LIMIT）+ 执行校验清单（行数 / 交叉 / NULL / 去重 / 单位 / 边界）+ 常见陷阱表 + 工具衔接；bi 预载 `[nl2sql, data-visualization, spreadsheet-modeling]`。
- **预设 +1**：data-briefing（数据快报：bi 取数 → insight 解读 → finance 核口径），预设 10 → 11 条。
- **图标注册表 +1**（avatar-icons.ts）：database；bi 头像 512×512 3D 卡通（粉西装 + 手持图表平板，主题色 pink `#ec4899`）。
- **测试**：新增 `m30-bi-nl2sql.test.ts`（12 断言：白名单可达性 / 只读边界 / deferred 契约 / 方法论文档在场）；`m21.test.ts` 适配 16 场景 / 67 角色 / 11 预设 / 场景协议断言 +bi。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 16 场景 / 67 角色通过；check:skills 40 技能；server + client 测试全绿。

### v14 — 全域扩展：生活场景与职能角色（+32 角色 / +6 场景）

- **场景与角色扩张**：9 场景 34 角色 → **15 场景 66 角色**。① 生活侧新增 6 个场景（health 健康生活 / learning 学习成长 / travel 出行旅行 / wealth 财富管理 / home 家庭生活 / personal 个人管理）与 14 角色（fitness / nutrition / wellness / tutor / language / reading / travel / wealth / chef / home / pet / parenting / coach / life-admin）；② 工作侧补位 18 角色：研发与产品（ux-researcher / ux-writer / ai-engineer / data-engineer / security / tech-writer）、商业洞察（insight）、市场增长（ads / pr / social / video / influencer / localizer）、销售客户（bd）、组织人事（hr / trainer）、合规与知产（compliance / ip）。全部四段骨架并新增 32 种不重叠交付件（如训练计划 / 学习计划 / 行程计划 / 人事方案等），统一 `docs/<文档类型>-<主题>.md`。
- **默认编制保持核心主路径**：六场景 chain 不变（chain = 建会话默认预选 + 接力主路径，纳入全部新角色会使默认会话过重并打散接力叙事）；新角色经「成员微调」按需勾选；生活 6 个新场景 chain = 全成员。
- **预设扩至 10 条**：新增 health-sprint（健康打卡方案）/ learning-season（学习成长季）/ trip-planning（出行规划）/ growth-localization（出海本地化）。
- **白名单可达性**：新角色 tools 均含 `handoff`（对齐 M29 协作基线，66/66）；生活角色不硬配技能预载（39 技能库均为工作向方法论，按需 `load_skill`），travel / wealth 例外（spreadsheet-modeling / financial-modeling）。
- **图标注册表 +23**（avatar-icons.ts）：megaphone / message-circle / video / star / globe / users / clipboard-check / stamp / dumbbell / apple / moon / graduation-cap / languages / piggy-bank / utensils / house / paw-print / baby / brain / calendar-check / heart-pulse / plane / coins。
- **新头像 32 张**（512×512，统一 3D 卡通风格；缺失时回退 gradient + icon）。
- **测试夹具适配**：context 端到端验收夹具预算 10k → 12k（M29 新增 development 场景协议后系统层实测 ~9.8k，10k 已无窗口余量）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 15 场景 / 66 角色通过；server 604 + client 373 测试全绿。

### v13 — 研发场景能力强化与编码代理能力基线（M29）

- **可达性修复**：`handoff` 补入全部 34 角色白名单（此前零绑定——ADR 2 的「工具优先、文本 @ 回退」在 execute 范式下实际只剩文本回退，`reason` / `expected_output` 指派闭环与多目标 fan-out 从未在真实运行中触达）；`remember` 补入研发 7 角色（对齐其余 6 场景与协议 `<context_semantics>`）。白名单语义不变：先定可发现范围，`tier='deferred'` 只影响初始可见性。
- **研发 7 角色能力矩阵**（ADR 55）：pm + `calc` / `date_calc`（排期与指标口径）；designer + 浏览器只读子集（`browser_open` / `navigate` / `snapshot` / `screenshot` / `console` / `wait` / `close`，走查取证不操作页面）；frontend / backend + `run_command` + 写类 git（`git_branch` / `git_commit`，审批门）；qa + `run_command` + db 只读三件套（`db_list_connections` / `db_schema` / `db_query`，不含 `db_execute`）；devops 补齐 `remember` / `handoff`。职责边界不变：designer 只「看」、qa 只「查」、发布仅 devops。
- **场景协议**：新增 `agents/development/_protocol.md`（六条工程纪律：代码改动纪律 / 共享文件所有权 / 验证闭环 / 缺陷回交 / 提交与发布纪律 / 依赖与配置纪律）。
- **技能层**：新增 `skills/debugging`（缺陷定位六步法，预载 frontend / backend / qa）；`code-review` 升级为完整评审手册（六组清单 + 严重度口径 + 输出模板，维持按需加载）；技能库 38 → 39。
- **零工具代码改动**：全部为授权接通与资产更新；`run_command` 仍受 `ALLOW_RUN_COMMAND` 开关 + 审批 + 白名单前缀三重约束；默认命令白名单不扩展（`npx <任意包>` 供应链风险，改用 package.json scripts）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 39 通过；新增 `server/tests/m29-code-bindings.test.ts` 可达性断言；server 604 + client 373 测试全绿（context 预算夹具随系统层扩容上调 10k→12k：39 技能索引 + development 场景协议约 1.2k 后系统层约 9.8k）。
- 相关文档：design.md §45、ADR 55、agents/README.md「研发场景能力基线」、`development/_protocol.md`。

### v12 — 数据库与 SSH 工具对 Agent 开放（可达性修复 + SQL 护栏加固）

- **可达性修复**：`backend` 白名单新增 `db_list_connections` / `db_schema` / `db_query` / `db_execute` 四个数据库工具，`devops` 新增 `ssh_exec`。此前 34 角色零绑定（`agents/` 全目录无 `db_*` / `ssh_exec` 引用），M22 / M23 建成的 Agent 侧能力（会话绑定 + 只读护栏 + 允许写入 / 允许执行开关 + 审批门）从未真正接通；对齐分工：backend = 数据模型与 SQL 实现（先 `db_schema` 核对表结构再写查询），devops = 运行手册与日志排查（`ssh_exec` 查看服务状态 / 拉取日志 / 部署脚本）。其余 32 角色白名单不变；plan / review 范式下 `db_*` 只读工具按只读集合自动可见。
- **SQL 护栏加固**（`guard.ts`，三项绕过修复）：① 危险关键字匹配大小写不敏感（此前小写 `delete` / `into` 等可绕过骨架检测，在「允许写入」连接上经 `db_query` 免审批执行写）；② PRAGMA 赋值判定覆盖任意大小写与括号赋值形式（`pragma writable_schema=1` / `PRAGMA journal_mode(wal)`），只读名单外一律按写拒绝；③ MySQL / MariaDB 可执行注释（`/*!` / `/*M!`）内容改为按代码参与分析（服务器会真实执行，不得当普通注释剥离）。
- **纵深防御**（`manager.ts`）：`mode='query'` 恒按只读执行——即使连接开启「允许写入」，也只读事务（PostgreSQL `BEGIN READ ONLY` / MySQL `START TRANSACTION READ ONLY`）/ 执行层写拒绝兜底，`db_query` 的只读契约不再依赖单一护栏。
- **可观测性**（`sqlite.ts`）：SQLite 只读打开失败回退读写打开时输出告警日志（此前静默降级）；清理 `mysql.ts` 两处死导入（lint 警告）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 38 通过；server 546/547（唯一失败为 M27 外部 MCP 迁移计数遗留，与本批无关）+ client 343 全绿（新增 m22 护栏绕过回归 + m21 backend/devops 绑定断言）。

### v11 — 浏览器工具对 Agent 开放（M22 可达性补强 + 控制台采集）

- **可达性修复**：`qa` / `frontend` 白名单新增 13 个 `browser_*` 工具。此前 34 角色零绑定——`webapp-testing` 技能以「若工具未接入」降级描述等待接入，从未真正接通；本次接通后定位：qa = 浏览器自动化实测（功能验证 / 缺陷复现 / 截图取证），frontend = 页面改完自测。其余 32 角色白名单不变；plan / review 范式下按只读集合自动可见 `browser_snapshot` / `browser_console`。
- **控制台能力补齐**（此前完全缺失）：浏览器会话采集 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded` → 环形缓冲（`console.clear` 与主帧导航清空），新增只读工具 `browser_console`（level / limit 过滤，输出 `[时间] [级别] 文本`）——Agent 排查页面报错、验证前端脚本行为的第一手段。
- **输入链路缺陷修复**（session.ts）：① `fill` 全选清空失效——带修饰键的 'a' 误走 `insertText` 插入字符，从未触发 Meta/Ctrl+A（修正为带修饰键走 `dispatchKeyEvent`）；② `type='char'` 只触发 keypress 不触发 keydown 监听器（React onKeyDown / 表单 Enter 提交会漏，改走 keyDown + text）；③ `fill submit` 缺 keyUp（补成对 keyDown/keyUp）；④ `press` 键名大小写不敏感（'enter' → Enter）。
- **工具行为对齐**（browser.ts）：`browser_open` 复用已有会话时按目标 URL 对齐（此前 `startUrl` 被静默忽略，Agent 以为打开了新页面）；`browser_snapshot` 新增 `include_text`（读页面正文文本，读长文 / 列表不用 `browser_eval`）。
- 技能同步：`skills/webapp-testing/SKILL.md` 侦察步骤补 `browser_console`（页面报错先看控制台）与 `include_text` 用法；工具族清单补 `browser_console`。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 38 通过；server 497 + client 343 测试全绿（新增 `tests/browser-console.test.ts` 16 条回归 + qa/frontend 绑定断言）。

### v10 — 协作范式（规划 / 执行 / 评审）与计划审批（M24）

- `_protocol.md` 新增 `<paradigm_modes>` 协议段：三范式契约，**与角色正交**、工具白名单即范式边界（看不见 `write_plan` 说明本轮不是规划范式）、Agent 无权重自行切换。规划（plan）范式只读 + `write_plan` —— 提交后本回合挂起等待用户批准 / 驳回，驳回按反馈修订后重提（新版本并再次等待），批准后引擎按步骤负责人派发；评审（review）范式只读 + `submit_review` —— 对 `plan:` / `step:` / `artifact:` / `message:` 目标给出 pass / conditional / fail 判定与发现、证据，fail 阻塞对应步骤或计划（修复后可复审）；执行（execute）范式为默认零差异行为，收到「你负责的计划步骤」时用 `update_plan_step` 汇报进度（blocked 必须给 note），全部步骤完成 / 跳过后计划作者获得一次收口回合。
- `agents/README.md` 新增「协同范式（M24）」小节：触发规则（显式 opt-in——Composer 消息级选择 > 会话「规划先行」开关 > 计划步骤声明 mode > 默认 execute）；34 个 AGENT.md 无需逐个修改（范式与角色正交，registry 白名单交集自动生效：plan / review = 只读工具 ∪ `write_plan`|`submit_review`，写工具与审批门自然不触发）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 38；server 469 + client 332 测试全绿；E2E 26 条全绿（新增 m24-plan 2 条）。
- 相关文档：design.md §40 / §41、ADR 48 / 49、docs/api.md §3.1、agents/README.md「协同范式」。

### v9 — 技能库扩展：外部源适配 + 全角色预载（M23）

- 技能库 9 → 38（新增 29）：① 官方与社区源适配 25 个职能技能（skill-authoring ← skill-creator、deck-authoring ← pptx、formal-document ← docx、spreadsheet-modeling ← xlsx、comms-writing ← internal-comms、brand-system ← brand-guidelines、visual-design ← canvas-design、doc-coauthoring / webapp-testing / frontend-design / mcp-server-building 等）；② UI 四件套（design-system / interaction-motion / ui-review ← Vercel 界面指南 + AccessLint、react-performance ← Vercel react-best-practices）；业务向技能（销售 / 客服 / 招聘 / 采购 / SEO 等）来自社区职能库。pdf 技能因无二进制解析能力弃用。
- 34 角色全部显式配置 `skills:`（1–4 个/角色）：research 4 角色共用 deep-research 底线；designer 四件套（visual-design / design-system / interaction-motion / ui-review）；frontend 增 react-performance；qa 增 ui-review；marketing 组 content-marketing 显式化继承（brand 改配 brand-system + visual-design）；组 `defaultSkills` 仅作兜底。
- 存量复检：13 个技能文件补工具兜底（如 recruiter / supply 无 date_calc → 「如可用」；webapp-testing 未接入浏览器 → 人工步骤单降级模式）。
- 技能纪律：单文件中文 60–150 行；只引用真实工具与 Markdown 容器（::: kpi / timeline / mail / option / cols / details、chart / mermaid）；交付路径统一 `docs/<文档类型>-<主题>.md`。
- 断言同步：`tests/m21.test.ts` 技能断言更新为新映射；`tests/context.test.ts` 预算夹具 6k → 10k（38 技能索引 + pm 预载后系统层实测 8.3k）。
- 评测：mock 14/14 ✅（与基线无回归）；check:skills 38 / check:agents 34 / server 369 + client 258 测试全绿。
- 相关文档：design.md §37、ADR 45、agents/README.md「技能库与预载」。

### v8 — OPC 业务场景扩展与业务工具纪律（M21）

- 新增 6 个业务场景（strategy 商业战略 / marketing 市场增长 / sales 销售客户 / finance 财务法务 / ops 运营行政 / funding 融资资本）与 19 个角色（全局 9 场景 34 角色）；全部四段骨架，交付契约统一 `docs/<文档类型>-<主题>.md`（经营简报 / 商业分析 / 定价方案 / 增长方案 / 内容日历 / 搜索投放 / 品牌规范 / 销售话术 / 客户成功 / 客服手册 / 财务测算 / 税务清单 / 合同审阅 / 运营SOP / 会议纪要 / 招聘方案 / 供应链方案 / 融资材料 / 投资人简报），与 mock 剧本 / 评测基线三方对齐。
- `_protocol.md <tool_policy>` 新增业务纪律四条：金额 / 比例 / 利率必须 `calc`（禁止心算）；日期与排期必须 `date_calc`；表格数据必须 `csv_analyze`（禁止目测汇总）；合同 / 报价 / 邮件等批量文档走 `template_fill`。
- 场景协议：`strategy/_protocol.md`（例会纪律：数字口径以 finance 为准 / 方案带成本与优先级 / 决策记录留痕）与 `finance/_protocol.md`（合规红线：不背书法律意见 / 风险三级标注 / 敏感信息不外发 / 不臆造法规条款）。
- 灵魂 4 个：chief advisor（谋士）/ steward（管家）、content muse（灵感）/ data（数据派）；技能 4 个：business-review / content-marketing（marketing 场景 defaultSkills）/ financial-modeling（finance、tax、pricing 预载）/ contract-review（legal 预载）。
- 快速组队预设资产 `agents/_presets.yaml`（6 条跨场景编制：周经营例会 / 内容营销战役 / 产品发布冲刺 / 报税合规检查 / 融资冲刺 / 外包与招聘）；`check:agents` 增加预设校验与清单打印。
- 新头像 19 张（统一提示词模板批次生成，512×512）；生成失败回退 gradient + icon。
- 评测：mock 14/14 ✅（新增 13-opc-weekly-review / 14-content-campaign 两个 golden 任务；baseline 12 → 14）

### v7 — 逐角色专业化设计（职责 / 方法 / 交付契约 / 协作接口）

- 全部 15 个角色（development 7 + brainstorm 4 + research 4）人设正文升级为四段骨架：`## 职责`（含职责边界）→ `## 工作方式`（可执行步骤与决策规则）→ `## 交付契约`（产物路径 + 章节结构 + 完成定义）→ `## 协作接口`（上游 / 下游 / 升级路径）；front-matter 的 description / capabilities 同步专业化。
- 交付件路径规范化并与 mock 剧本 / 评测基线对齐：`docs/<文档类型>-<主题>.md`（需求 / 架构设计 / 交互设计 / 接口设计 / 测试计划 / 创意方案 / 点子池 / 红队报告 / 评分矩阵 / 研究报告 / 交叉分析 / 核查记录）、`deploy/部署说明-<主题>.md`、`web/src/README-实现说明.md`、`docs/来源清单.md`；补齐此前缺失的独立交付件约定（点子池 / 红队报告 / 评分矩阵 / 交叉分析 / 核查记录，保证并行波不写同一文件）。
- 方法论细节新增：pm 用户故事与优先级口径；architect 架构驱动与决策记录（背景 / 决策 / 后果）；designer 状态矩阵与可访问性底线；frontend 接口对接与自测清单；backend 端点四类响应与安全约定；qa 必测五类与发布判定；devops 环境矩阵与渐进发布；brainstorm 停车场机制与 ICE 信心校准；research 证据分级与引用对照。
- backend `skills: [api-design]` 预载（接口契约主责）；其余角色维持按需 `load_skill`。
- `agents/README.md`：正文骨架规范升级，新增「交付件命名规范」小节；brainstorm / research 场景协议「交付」节补充成员独立交付件清单。
- 评测：mock 12/12 ✅（与基线一致，无回归）

### v6 — 联网检索授权与反爬协议（M20）

- 新增 `web_search` 工具（百度检索，双模式：官方 API / 结果页抓取 + 反爬）：6 个持有 `web_fetch` 的角色（architect / backend / devops / frontend / qa / scout）同步授权。
- `_protocol.md <tool_policy>`：新增联网规则——获取外部资料先 `web_search` 再对具体页面 `web_fetch`（限白名单）；未启用 / 被风控拦截 / 被拒时不反复重试，如实说明限制并改用工作区材料。
- `research/_protocol.md`：「来源可追溯」与「无外网检索条件」口径纳入 `web_search`（含被风控拦截的降级路径）。
- scout 人设：检索流程改为「先 `web_search` 拿候选来源 → 对白名单域名再 `web_fetch` 抓正文」；抓取/检索失败如实记录不编造。
- 评测：mock 12/12 ✅

### v5 — Agent 包化与多场景扩展（M15–M18）

- 目录重构：`prompts/*.md` 平铺 → `agents/<场景>/<agent>/` 自包含包（AGENT.md + souls/ + avatar.png），新增 `agents/README.md` 操作手册；`migrate:agents` 幂等迁移，`check:prompts` 升级为 `check:agents`（旧名保留别名）；加载器双轨回退一个版本周期。
- 场景分组：新增 `brainstorm`（头脑风暴，4 角色：facilitator / ideator / challenger / refiner）与 `research`（深度研究，4 角色：lead / scout / analyst / verifier）；`_group.yaml` 场景元数据（chain / parallel / rounds / defaultSkills）。
- 协议分层：全局协议 + 场景协议（`<scene_protocol>` 追加在全局之后）+ 灵魂层（可选）；全局协议新增 `<parallel_waves>` 并行协作约定与 `<soul_priority>` 灵魂优先级护栏。
- 灵魂层：ideator `wild` / `zen` / `scholar`（默认 wild）、facilitator `energetic`、qa `strict` / `friendly`（默认 strict）；会话内可 PATCH 随时换装（成员事件条可见）。
- 新技能：`brainstorm-facilitation`（发散引导 + ICE 打分）、`deep-research`（研究流程 + 来源与置信度规范）。
- 新头像：8 张 AI 生图形象照（白板马克笔 / 灯泡 / 靶心 / 清单 / 地图 / 望远镜 / 图表 / 放大镜+印章），与前 7 张同风格。
- 评测：mock 脚本覆盖 15 角色（含灵魂风格变体与并行剧本）；golden 任务扩展到 12 个（brainstorm / research 各 1 个，详见 evals/）。

### v4 — 工具与安全语义补齐（M5–M7）

- `_protocol.md <tool_policy>`：补充「覆盖写优先 apply_patch/edit_file、`dry_run` 预览、敏感文件拒绝不绕路、高风险操作走审批、被拒后不重试同一动作、repo/worktree 模式先 `git_status`」。
- `_protocol.md <safety>`：补充 `git_restore` 仅限单文件、禁止 `git push` / 强制重置 / 越界访问。
- 评测：mock 10/10 ✅ · judge 待跑（无外网模型 key）

### v3 — 记忆与压缩语义（M2）

- `_protocol.md` 重写为标签分层：`<role_contract>` / `<collaboration_rules>` / `<context_semantics>` / `<output_contract>` / `<tool_policy>` / `<safety>`。
- 新增 `<context_semantics>`：明确「历史会被摘要替代；关键约束/口径/决策必须 `remember` 或写入文件」。
- `<tool_policy>` 写入反模式：大文件分页读、先 `grep` 再 `read`、小改用 `apply_patch`、不重复读自己刚写的文件。
- 新增 `remember` / 技能加载 / 工具报错自我修正（连续两次失败换思路）规则。
- 评测：mock 10/10 ✅（基线初建于本版本之后）

### v2 — 交付件主通道（M6）

- `<tool_policy>`：明确「正式成果用 `write_file` 写入工作区、相对路径、先看后写避免覆盖他人成果」。
- repo / worktree 模式提示接入工具集（`git_status` / `git_diff` / `git_commit`）。
- 评测：未留档（评测框架 v4 起建立）

### v1 — 初始版本

- 单文件 `_protocol.md`（协作协议）+ `agents/<role>.md`（7 角色人设：pm / architect / designer / frontend / backend / qa / devops）。
- 转交规则：行首 `@id` / `@名字`；交还用户 `@用户`；不 @ 自己、不空转。
- 校验：`npm run check:prompts`（front-matter 与结构校验，CI 常驻）

## 当前基线

| 项 | 值 |
| --- | --- |
| 基线文件 | `evals/baseline.json` |
| 模式 | mock（确定性断言，CI 常驻） |
| 结果 | 22/22 通过（22 个 golden 任务） |
| 运行方式 | `npm run eval`（回归则非零退出码） |
| 刷新基线 | `npm run eval -- --update-baseline` |
| judge 评分 | `npm run eval -- --judge`（需 `LLM_API_KEY`，手动 / 夜间） |
