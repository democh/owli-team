# ADR 0025：前端性能架构——byId+order / 虚拟列表 / 节流

- 状态：Accepted
- 引入：M8
- 相关：[design.md §10](../design.md)、ADR 9

## 背景

v1 的 session-store 以数组存消息：每条流式 delta 触发数组拷贝与全列表重渲染，500 条消息 + 流式输出时输入卡顿、滚动掉帧。消息操作（编辑 / fork / 删除）也让整列表失效。

## 决策

**store 结构改造 + 渲染管线优化**：

1. **`byId: Map<string, ChatMessage>` + `order: string[]`**：列表项按 id O(1) 订阅（`useSessionStore(s => s.byId.get(id))`），单条消息更新只重渲染该条；保留 `messages` 只读派生 selector 兼容既有测试（两步迁移）；
2. **虚拟列表**（`@tanstack/react-virtual`）+ `MessageItem` `React.memo` + 自定义比较器；
3. **两层节流**：数据层 40ms 合并（保留，ADR 9）+ 渲染层 150ms 节流（流式消息内容）；
4. **Markdown 缓存**：完成态消息按 `contentHash` 缓存渲染结果（LRU 200）；流式期间代码块用纯文本，完成后高亮；
5. **Shiki 单例 + 按语言动态 import**：仅对完成态消息高亮；
6. **滚动**：`overflow-anchor` + 贴底时 `scrollIntoView({ block:'end' })`，用户上滑时不打断。

## 理由

- 性能瓶颈的根源是「数据结构放大失效范围」：数组结构让单条更新波及全列表，Map + order 从结构上消除；
- 虚拟列表把 DOM 数量从 O(消息数) 降到 O(视口)；memo 让单条 delta 只重渲染一条消息；
- Markdown 解析与 Shiki 高亮是单次 flush 中最重的同步任务，缓存 + 延迟高亮把成本从「每 flush」降到「每消息一次」。

## 被否决的方案

- **一次性切换全部调用点到 Map**：62 例既有测试全量爆改，迁移风险高；两步走（selector 兼容层过渡）每步保持全绿；
- **仅加大节流窗口**：延迟感明显，且不解决全列表重渲染。

## 影响

- 验收指标：500 条消息 + 流式输出时单次 flush 重渲染消息数 ≤ 1；
- 单测覆盖：byId+order 归约、虚拟列表窗口计算、diff 渲染；
- 右栏接力 / 战绩视图按需派生数组（`messagesOf({ byId, order })`），不做逐条订阅。
