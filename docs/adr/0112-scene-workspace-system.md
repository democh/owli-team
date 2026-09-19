# ADR 0112：场景工作区体系——四形态容器 · 六面板注册表 · 12 元件库（M52-A）

- 状态：Accepted
- 引入：M52-A
- 相关：[design.md §66](../design.md)、[docs/scene-expansion-design.md §7](../scene-expansion-design.md)、[shared/src/schemas.ts](../../shared/src/schemas.ts)（GroupStage）、[client/src/components/scene/](../../client/src/components/scene/)、ADR 0111（M51-E，stage 预写先例）

## 背景

- 29 个场景的消息流此前是同一种「聊天流」：对弈类只看得到文字交替、圆桌研讨看不到席位与波次、工作型场景（写作 / 排盘 / 陪跑）的产物散落在长对话里——不同协作结构被同一呈现抹平；
- M51 各批已按 §7.2 判定为全部场景预写 `stage: {layout, panel}` 声明（arena 2 / roundtable 1 / dock 7 / stream 其余），但消费端为零——声明只是 yaml 里的注释语义，没有任何运行时效果；
- 形态层必须是纯前端呈现：不改消息数据层与虚拟列表结构键契约、不改引擎协议、不新增后端接口——否则 29 场景的零回归承诺无法兑现。

## 决策

1. **类型层（向后兼容）**：`GroupStageSchema`——`layout` 四枚举（stream / dock / roundtable / arena）、`panel` 六枚举（pool / versus / board / console / coach / chartboard）、`seats`（left / center / right 角色 id 数组）、`parts`（12 元件名数组）；`AgentGroupSchema` 挂可选 `stage` 字段，未声明即 stream；`validate` 补 seats 引用角色存在性校验（m21 正负例 +2）；
2. **四形态容器**（`client/src/components/scene/`）：stream 零新增结构直通；dock「左对话 + 右工作区」（默认 340px，拖宽 clamp 260–520、折叠、关闭，localStorage `ma:sc:dock` 记忆）；roundtable「顶席位环 + 中消息流 + 右汇聚板」（AgendaTrack 波次进度）；arena v1 按 §7.9 口径「席位分栏 + 回合轴 + 计分板」（左右 SeatCard 栏 + 中轴 center 席与 RoundTrack + 顶 Scoreboard 多空计数）；
3. **六面板注册表**（§7.4，与容器解耦）：pool 汇聚板（容器条目卡墙 + 深入回填）/ versus 局势面板（多空信号 + MomentumBar + 裁决卡）/ board 工序面板（标题目录树 + 版本线 + 交付件）/ console 看板面板（KanbanBoard 列 + 时间轴）/ coach 陪跑面板（ProgressRing + CheckGrid 勾选覆盖）/ chartboard 盘面板（多盘 tabs + PanBoard）；面板以 element 注入容器（`panel?: React.ReactNode`），切断 registry ↔ 容器→面板的循环导入；
4. **12 元件库**（§7.6，kebab-case 注册于 `PART_NAMES`，`parts` 空声明 = 全启用）：MomentumBar / Scoreboard / RoundTrack / SeatRing / SeatCard / AgendaTrack / KanbanBoard / ClaimTree / ProgressRing / CheckGrid / VerdictPart / DeliveryPanel——空态一律 PanelEmpty（「不空白、不报错」，§7.3-3）；
5. **降级链（resolveStage 纯函数）**：未声明 / 非法 layout / arena 缺席位 / listMode → stream；非法 panel 忽略（保留 layout）；parts 过滤非法项；异常回退标记 `fallback: true`，`listMode` 回退不算异常（fallback: false）；宿主异常一律回退 stream；
6. **纯前端派生**（`derive.ts`，零新增数据通道）：parseContainers（行级 `::: name arg` 块扫描，未闭合忽略）/ panRowsOf（字段行 + 条目行）/ verdictsOf（多方·空方·僵持·正方·反方 → long / short / draw）/ checklistItemsOf / headingsOf（跳过代码围栏）/ wavesOf · speakingIdOf（turnIndex 波次分组）；工作区数据 = 消息流 + artifacts 的投影；
7. **交互与持久化**：面板交互态 sessionStorage（`ma:sc:tab:<sid>:<key>` 面板 tabs、`ma:sc:checks:<sid>` 勾选覆盖）；「切回纯列表」开关 localStorage `ma:sc:list`（ChatArea 标题栏，仅声明 stage 的会话组显示）；回填统一 composerInsert 语义（深入展开 / 看解读 / 汇报进度 → Composer 草稿）；交付件打开走 ui-store.requestArtifact（live-panel 订阅链复用）；
8. **性能红线**：工作区数据订阅 500ms 节流 + 流式冻结（status=streaming 期间不更新工作区，完成态才刷新）；busy 状态 selector 全部返回原始值（Object.is 稳定，流式 delta 不触发宿主重渲染）；虚拟列表 / 消息数据层零改动；
9. **可达性收敛与窄屏（<900px）**：quiet-mode 与 prefers-reduced-motion 下场景过渡 / 脉冲 / 入场动画全关（index.css 收敛块）；dock 右区收起为底部抽屉（默认收起）；roundtable / arena 席位环降为 SeatStrip 横条、arena 降级单流 + 席位高亮 + 回合轴。

## 理由

- **声明与实现分离是本批的骨架**：M51 六批预写的 10 个 stage 声明（M52-B 点亮对象）在类型层先行校验（seats 正负例）、渲染层再消费——「先声明、后点亮」的批次节奏不需要返工任何场景资产；
- **四形态 × 六面板 × 12 元件是组合而非枚举**：29 场景各自定制组件会失控；注册表 + 声明式组合让「换形态 / 换面板 / 关元件」都是改一段 yaml；
- **面板 element 注入解决工程约束**：registry 依赖容器与面板、容器不反向依赖 registry——ArenaStage 内联 partEnabled 判断同样为切断循环；
- **流式冻结 + 原始值 selector 是长会话的护栏**：工作区随每条 delta 重算会在 29 场景并行的长会话里放大成可感卡顿；500ms 节流（MessageRail 先例）+ 完成态刷新把工作区开销与消息流解耦；
- **回退链保证「最差情况等于今天」**：任何解析失败 / 未声明 / 窄屏 / 用户关开关，都回到已存在的聊天流——形态层引入的上限风险是零。

## 被否决的方案

- **形态判定放引擎 / 会话元数据**：形态是「场景怎么被看」的呈现问题，放引擎会引入协议与迁移成本；前端读 group.stage 声明即时生效、改声明即改形态；
- **为每个场景写独立布局组件**：29 个定制组件不可维护；四形态 + 注册表已覆盖全部判定（§7.2 判定原则）；
- **面板 tabs 用 localStorage 持久**：面板 tabs 是会话内工作上下文，跨会话透视会串场景；会话级 sessionStorage（`ma:sc:tab:<sid>`）语义正确；
- **工作区数据订阅复用实时 store（无节流 / 无冻结）**：违反长会话性能红线（见理由）；
- **窄屏维持「右栏压缩」形态**：900px 以下右栏挤压消息流可读性；底部抽屉（默认收起）在移动语义下更成立（M8/M14 先例）；
- **arena v1 同时拆虚拟列表虚拟化席位分栏**：消息数据层改动会破坏结构键契约；§7.9 明确「席位分栏 + 回合轴 + 计分板」先行，虚拟化留待后续专项；
- **「切回纯列表」放设置页 / 全局偏好**：误触成本低的会话内开关最直觉（标题栏胶囊），且回退视图与未声明场景完全一致（stream 直通）。

## 适用与失效条件

- 适用：M52-B 点亮 10 个新场景（arena 2 / roundtable 1 / dock 7）与 M52-C 既有 14 场景接入均消费本框架；「声明 → 注册表 → 容器 / 面板 / 元件」组合模式适用于后续任何新形态需求（新增形态须同时改 schema 枚举 + resolveStage + registry）；
- 失效条件：`GroupStageSchema` 增改枚举 / 字段时须同步 `resolveStage`、`registry.ts` 与 m21 正负例；`PART_NAMES` / `STAGE_PANEL_COMPONENTS` 增项须核对 §7.4 / §7.6 契约与 index.css 样式族；storage 键（`ma:sc:*`）语义变更须迁移兼容；主包 gzip 已 330.91 kB（存量欠账），后续面板增重须评估懒加载拆分；
- 测试镜像面：`client/tests/m52-stage.test.tsx`（22 例：resolveStage 降级链 6 / derive 纯函数 6 / 面板空态 4 / pool 集成 2 / SceneStage 宿主 4）；`e2e/m52-stage.spec.ts`（2 例：dock 工作区与切回纯列表 / 窄屏抽屉）；`server/tests/m21.test.ts`（seats 校验正负例 +2）。
