# ADR 0102：建会话「组队台」三栏重设计（M50）

- 状态：Accepted
- 引入：M50
- 相关：[design.md §59](../design.md)、[design.md §34.2](../design.md)（三步流 Step 0，本批修订）、[client/src/components/sessions/CreateSessionDialog.tsx](../../client/src/components/sessions/CreateSessionDialog.tsx)、[client/src/components/sessions/SessionList.tsx](../../client/src/components/sessions/SessionList.tsx)、[client/src/components/agents/AgentPicker.tsx](../../client/src/components/agents/AgentPicker.tsx)、ADR 0040（快速组队预设）、ADR 0101（空编制创建语义，本批沿用）

## 背景

- M21 把建会话升级为「快速组队优先」后，M16 的两步向导（选场景 → 配成员）持续承载预设 / 场景 / 成员池 / 灵魂 / 标题五类信息：15 个预设 + 18 个场景堆在同一滚动页（`max-h-[62vh]`），微调成员后回看来源必须「重选场景」往返；
- **用户反馈（本里程碑动因）**：用户提出「现在一个版面不便于使用，多 tab 切换，还是可以学习游戏的交互？」——经交互方向确认，采用**三栏组队台 + 轻度游戏化**：左「来源」→ 中「角色池」→ 右「编制」，一次成局取消向导；游戏感仅体现在入选态、编制计数、成员行入场动效；
- 约束：纯前端（server / 协议 / DB / zustand store 零变更）、零新增依赖、行为语义与既有 e2e 锚点全保留（30+ 个 spec 走 helper，仅 4 处 inline 流程）。

## 决策

1. **交互形态**：三栏组队台一次成局取代两步向导——左「来源」（`w-[236px]`：来源搜索 + 「快速组队」preset 行 + 「按场景组队」group 行 + 底部「自由组合」虚线按钮）→ 中「角色池」（`AgentPicker` 填满列高）→ 右「编制」（来源徽标 + `已选 N 位` + 成员行 + 标题 + 创建）。删除副标题「新建会话 · 选场景/配成员」、「重选场景」按钮与两步向导状态；
2. **响应式收敛**：桌面（≥1024px，`useMediaQuery('(max-width: 1023px)')` 判定）三栏常驻；窄屏收敛为「来源 / 角色池 / 编制」三页签——条件渲染单面板，桌面/窄屏共享同一份 pane JSX（零双份实现）；点来源行后自动切「编制」页；390×844 抽屉内嵌套 Dialog 路径保持可用；
3. **来源语义**：点来源行 = 以推荐编制（preset `members` / group `chain` ∩ 已知角色）**整体替换**编制并清 souls（不保留追加成员）；「自由组合」清来源与编制；空推荐 = 空编制（合法，沿 M48 空编制创建语义）；池卡 = 单成员增删（`aria-pressed` 保留）；编制行移出按钮 `aria-label="移出编制"`（不含角色名——池卡保持「唯一含角色名的按钮」，避免 Playwright 严格模式二义）；清空编制保留来源（徽标呈「已微调」态，「已微调」为独立 span 不拼进 chip 文本）；
4. **选择器锚点**：来源行 `aria-label="组队来源：{name}"`——来源名称（如「研发团队」）与同屏 AgentPicker 分组 Tab 的可访问名（`研发团队 7`）二义，e2e / 单测统一以该锚点定位（`m26-console` 同屏断言同步适配）；
5. **轻度游戏化**：游戏感仅体现在状态可见性——来源行入选态（边框 / 底色 / 勾选）、编制计数徽标 `已选 N 位` 的 `badge-pop` 动画（`key={picked.length}` 重触发）、成员行 `.lineup-enter` 入场（320ms）；措辞保持专业（不引入等级 / 积分 / 大厅话术）；两个动画均加入 `@media (prefers-reduced-motion: reduce)` 与安静模式（`.quiet-mode`）双清单 `animation: none` 降级；
6. **行为等价不变量（全保留）**：空编制创建（`空编制创建 · 交给平台组队` + 0 人提示原文案）、`preset.prompt` → `ma:draft:<sessionId>` 草稿键、souls 仅保留最终编制（过滤逻辑照搬）、`pendingCreate` 通道（SessionList 消费后经 `initialSource` 传入，无效 id 回退无来源）、对话框无障碍名「新建会话」（DialogTitle 在头部保持不变）、全部原文案锚点（`已选 N 位` 仅右栏一处 / `快速组队 · {name}` / `会话标题（可选，默认自动生成）` / `创建并进入（N 位成员）` / `∥ 并行协作 · N 位推荐` / `目标：` / `N 人` 等）；
7. **组件边界**：新建 `CreateSessionDialog`（props：`open` / `onOpenChange` / `initialSource?` / `onCreated`，承载组队台全部状态与提交逻辑）；`SessionList` 瘦身（删除约 280 行旧创建逻辑与 JSX，仅留列表 CRUD / FTS 搜索 / pendingCreate 消费与对话框装配）；`AgentPicker` 新增 `fill?: boolean`（默认 false 保持 `max-h-72`——TeamPanel 邀请对话框零影响；true 时 `min-h-0 flex-1` 填满中栏）；`index.css` 新增 `.lineup-enter`；
8. **验证面**：client 新增 `m50-frontend` 5 例（来源搜索 / 来源切换重置编制与 souls / 编制行移出 / 清空编制 / 窄屏三页签）并适配 `m16` / `opc` / `m48-frontend` 锚点；e2e `helpers.ts` 的 `createSession` / `createSessionByPreset` 重写（打开 → 点来源行 → 断言 `/已选 \d+ 位/` → 标题 → unpick 点池卡 → 创建），30+ 走 helper 的 spec 零改动，inline 流程适配 `m14-responsive` / `m48-routing` / `m26-console` 三处。

## 理由

- **一次成局消除往返**：两步向导中「来源与成员池不共屏」，微调后回看来源需往返；三栏把「选来源 → 挑人 → 定编制」压缩为同屏一局，来源行重复点击即可回到推荐编制；
- **信息架构对齐决策顺序**：左到右即「参考什么（模板/场景）→ 谁能上（池）→ 定了谁（编制）」，15 预设 + 18 场景的堆叠被收进可搜索的窄栏，滚动压力大幅下降；
- **共享 pane JSX 的响应式**：桌面三栏与窄屏三页签共用同一份 pane 定义，窄屏不是「另一套实现」，只切换容器与可见性，维护面减半；
- **回归面压到最小**：锚点不变量全保留（原文案 / 无障碍名 / 草稿键 / souls 过滤 / pendingCreate），30+ e2e spec 零改动；选择器二义以 `组队来源：` 前缀锚点系统性解决（而非逐条 test 打补丁）；
- **游戏化收敛在状态可见性**：入选态 / 计数 / 入场三类纯 CSS 动效即提供「组队感」，不改变专业措辞与无障碍语义，安静模式 / reduced-motion 静态降级成本为零；
- **纯前端零依赖**：风险面仅在 client 一个组件域，server / 协议 / store 零变更意味着失败可整体回滚。

## 被否决的方案

- **仅多 Tab（现有版面 + Tab 切换）**：Tab 只隐藏信息、不减少步骤——来源与编制仍不同屏，微调后回看与切换仍是往返成本，未解决「一版面不便于使用」的根因；
- **全屏游戏大厅路由页**：新建会话是高频轻量入口，独占主区 / 引入路由与懒加载面与收益失配；大厅形态的强沉浸感也超出「轻度游戏化」的确认边界；
- **强游戏措辞（等级 / 积分 / 开黑话术）**：与产品专业协作定位冲突，且会破坏既有文案锚点与 e2e 断言；
- **编制拖拽排序**：零新增依赖约束下拖拽需自研手势（成本高），且编制顺序语义 = `participantIds` 链序（场景 chain 序 + 追加选择序）已自然成立，排序需求未经验证——本期不做；
- **以来源名称直接做选择器（不加 `组队来源：` 前缀）**：桌面三栏同屏下来源名与 AgentPicker 分组 Tab 名二义（Playwright 子串匹配 / RTL 直接文本匹配都会误配），加前缀锚点是与用户可见文案解耦的系统解法；
- **编制预设另存 / 池内角色详情浮层**：前者是资产面（`_presets.yaml`）扩展、后者与 AgentPicker 现有交互重叠——均属下一批范围。

## 适用与失效条件

- 适用：全部新建会话入口（左栏按钮 / 空态按钮 / 命令面板 `pendingCreate`）与全部视口宽度；@ 直达、空编制创建、草稿键、souls 语义零变化；
- 失效条件：若引入池内拖拽排序 / 编制预设保存 / 来源推荐成员计算口径变更（`members` / `chain`），需同步「已微调」判定与 `badge-pop` 触发；`pendingCreate` 契约（`{kind, id}`）扩展时需同步 `initialSource` 类型；
- 测试镜像面：client `tests/m50-frontend.test.tsx`（搜索过滤 / 来源切换 / 移出 / 清空 / 窄屏页签）+ `m16-frontend` / `opc-frontend` / `m48-frontend` 适配；e2e `helpers.ts`（锚点重写）+ `m14-responsive`（窄屏页签）/ `m48-routing`（组队台预选）/ `m26-console`（同屏断言）。
