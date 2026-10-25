# ADR 0225：交付件索引 + handoff 交接包（M87）

- 状态：Accepted（2026-10-25）
- 关联：ADR 0017（交付件浏览）・ADR 0092 / 0123（收尾交付清单）・ADR 0002（handoff 工具优先）・ADR 0046（多格式预览）・ADR 0223（接力控制 M86）・ADR 0224（意图判定 M88）・design.md §22 / §10.4・docs/api.md §6

## 背景

交付件的读取链路长期是「每次全量扫盘」：

1. **回合装配**：`ContextService.describeWorkspace` 每成员每回合调用 `ArtifactStore.list()`（递归 readdir + 每文件 stat，上限 501）。典型 sandbox 会话只有 7–9 个文件，开销尚可；但 repo / worktree 模式扫的是**整个仓库**，与「交付件 = git 变更集」的语义冲突，且在流式期间同步阻塞事件循环。
2. **路由去重**：`Engine.listDeliverables` 是第二份手写遍历（深度 2 / 上限 30），按遍历序取数而非最近，且读路径带 `ensureSessionDir` 建目录副作用。
3. **交付件面板**：`GET /artifacts` 再扫一遍；git 模式每次请求起一个 `git status` 子进程。
4. **前端放大**：`useArtifactMeta` / `ArtifactsView` / `ArtifactFeedView` 三份缓存各自拉全量；`artifact:updated` 经 SSE + WS 双通道各递增一次版本，一轮 N 个产物 → O(3N) 次全量请求（git 模式下即 O(3N) 个 git 子进程）。
5. **折叠自相矛盾**：工作区清单超过 20 行时折叠为「docs/：30 个文件」，模型失去文件名锚点，必然再 `list_dir` 全量盘点。
6. **交接信息缺失**：`handoff` 只传 `reason / expected_output`，接手方不知道上一棒产出了哪些文件，只能重新扫盘；`expected_output` 也无法与真实落盘校验。
7. **作者归属易失**：`ArtifactStore.authors` 为内存 Map，重启即丢；而 `artifact_versions.author_agent_id` 已有持久事实。

## 决策

### 1. 交付件索引（`artifacts` 表）成为元数据事实源

- 正文唯一真相仍在磁盘；DB 只存元数据（`kind / size / mtime / dir / author / origin / delivery_class / run_id / message_id / version / revision / deleted_at`）。
- 会话内 `revision` 单调递增：列表、增量、ETag 共用同一版本号；扫描无变化不推进，避免客户端无谓刷新。
- `delivery_class` 服务端单点判定：`uploads/` = attachment、`canvas/` = media、`charts|data|raw|cache|tmp|temp|logs` = process、其余 = final。客户端 `PROCESS_DIRS` 仅作旧服务端回退。
- 迁移 35；`artifact_index_state` 保存 `revision / last_full_scan_at`。

### 2. 写时登记（write-through），扫描只做低频校准

- 工具写（`applyToolResult`）、上传（attachments / legacy uploads）、画布素材、媒体产物、设计场景保存：一律 `index.upsert`（一次事务、一次 revision 推进）。
- `handoff.artifacts` 的 `version / size` 来自同一次 `artifact_versions.record` 读取，避免索引二次读盘。
- 校准只在三种时机：会话首次访问、面板刷新（`refresh=1`）、距上次校准超过 TTL（10 分钟）。校准受 **3000 项 / 300ms** 预算约束，异步 `opendir` + 分批，不阻塞流式；未完成时不回收删除项，防误删。
- repo / worktree 模式不遍历仓库：注入 `WorkspaceService.changedArtifacts`，索引以 git 变更集为准，消失条目软删。
- 未知路径 / 外部手工放入：`read_file` 命中未登记路径时可由后续校准或写入路径补齐；索引不可用时静默退化为空摘要，不阻断协作。

### 3. 工作区上下文：摘要 + 本轮增量

- 系统提示的「当前工作区」改为 3 行内摘要（`server/src/context/workspace-digest.ts`）：
  - 已有 N 个交付件 + 最近 4 个**文件名**（体积 / 作者 / 版本）；
  - 本轮新增/变更（按 `run_id` 查询，≤5）；
  - 「读单个文件用 read_file；需要完整目录树时再用 list_dir」。
- 每回合零文件系统调用；作者 id → 展示名在装配侧解析；`foldWorkspaceListing` 删除。
- 路由输入 `deliverables` 改为索引查询（本轮产出在前 + 最近 12 条 + 作者），不再建目录、不再扫盘。

### 4. handoff = 交接包

- 工具参数新增（均可选，向后兼容）：
  - `artifacts: string[]`（≤8）：接手方要用的交付物路径；省略时引擎用本轮 `message.artifacts` 自动补齐（零 IO）；
  - `notes: string`（≤300）：交接口径 / 验收 / 已知坑。
- 工具执行时按索引校验路径（未装配索引回退磁盘存在性）；未知路径忽略并回灌「已忽略 N 个」，不拖累转交本身。
- 引擎 `HandoffEntry` 增 `artifacts / notes`；`run_events` 写 `handoff:package`（来源 / 目标 / 路径 / 口径）供审计。
- 接收方回合指令新增：
  - `上一棒交付物（来自 X）：a（v3 · 12KB）、b——直接 read_file，无需 list_dir 全盘盘点`
  - `交接口径（来自 X）：…`
  - 无包时文本零差异（兼容旧快照）。
- resume 时从该 Run 已完成消息的 `handoff` 工具调用重建未消费便条（以 `message.mentions` 的已解析成员键为准）。
- `agents/_protocol.md` 同步：转交必须写交接包；收到交接包直接读指定文件，不再默认全量 `list_dir`。

### 5. 前端单一数据源 + 事件合并

- 新增 `client/src/stores/artifact-store.ts`：`artifacts / byPath / revision / loading` 一份，面板、实况面、消息元数据共享。
- `artifact:updated` 只触发 **250ms trailing 合并**，随后按 `revision` 拉 `/artifacts/changes`；增量截断（≥500）或旧服务端（无 revision）自动回退全量。
- WS 侧用既有 `handledBySse` 去重，同一 Run 不再双通道递增。
- 面板刷新改为 `ensure(sessionId, { force: true })`（强制校准）；消息行 / 收尾卡只读共享表，不再各自请求。

## 被否决

- **只加 TTL 缓存、不建索引**：能缓解但无法提供增量 / 按 Run 归集 / 精确 paths / 删除墓碑；git 模式仍是每请求子进程。
- **正文入库**：破坏「大文件 / 二进制走磁盘」边界，迁移与体积风险高，收益为零。
- **`fs.watch` 递归监听**：容器 / 网络盘不可靠、句柄成本高、事件风暴；写时登记 + TTL 校准已覆盖正常路径。
- **彻底移除工作区清单**：模型失去已有产出锚点，重复造件率上升；改为「文件名摘要 + 增量」更稳。
- **把 handoff 包做成必填**：多数转交无需文件指针；缺省自动带出本轮产出即可，避免模型为满足 schema 编造路径。

## 验收

- `server/tests/m87-artifact-index.test.ts`：revision 单调 / 元数据去重 / 分层 / 软删墓碑 / TTL 与 force 校准 / git 变更集回收。
- `server/tests/m87-handoff-package.test.ts`：工具路径校验与未知路径回灌；回合指令注入（含零差异分支）。
- `server/tests/m87-handoff-flow.test.ts`：真实引擎端到端（写文件 → handoff 自动带出 → 接手方指令含路径 / 版本 / 口径）。
- `client/tests/m87-artifact-store.test.ts`：一轮多次事件合并为一次增量请求；会话切换重置。
- 回归：server 全量 **137 文件 / 1614 例全绿**；client 全量 126/130 文件通过（4 个失败文件为 TaskView / 面板注册 / 画布 Tab / 快捷键，属工作区既有 M88 / UI 改动，与本次无关）；`typecheck`（server + client + e2e）与 `check:agents` 通过。
- API：`GET /artifacts?paths=` / `refresh=1` / ETag 304 / `GET /artifacts/changes?since=`（docs/api.md §6）。
