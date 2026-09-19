# ADR 0059：无限画布与媒体创作工作台（Infinite Canvas & Media Studio）

- 状态：Accepted
- 引入：M31
- 相关：[design.md §49](../design.md)、design.md §21（工具系统与 Harness）、ADR 6（JSON 会话文件：原子写模式）、ADR 14（工作区沙箱）、ADR 32（协作图谱：React Flow 选型与受控更新纪律）、ADR 42（连接中心：凭据加密 / 会话绑定）、ADR 46（交付件多格式预览）、ADR 54（工具按需发现：渐进披露）、ADR 58（专业级附件体系与多模态通道）

## 背景

- 项目已有对话 / 交付件 / 数据库 / 终端四大主区 Tab，但「创作」仅存在于对话消息流中：agent 产出的图片只能以交付件形式在右侧面板查看，无法摆放 / 连线 / 迭代；脑图只能以 mermaid 代码块呈现，无法结构化编辑；生图 / 生视频能力完全缺位（工具与连接均无）。
- 用户诉求：画布 = **会话级空间化工作台**（主区新增「画布」Tab，与既有四大 Tab 并列），全场景通用（任何场景任何角色可用）。四大用途：**无限脑图**（对话 / 计划 / 任务 / 记忆 → 结构化脑图，Xmind 式编辑与导出）、**媒体创作**（文生图 / 图生图 / 文生视频 / 图生视频 / 首尾帧视频，画布上直生 + 批量变体 + 历史再生成）、**Agent 协作**（新工具接通全角色，agent 产出自动上画布、画布节点可引用回对话）、**素材墙**（拖拽上传 / 交付件引用 / 消息「送上画布」，统一落交付件体系）。
- 硬约束：
  1. **零新增核心依赖**：前端复用协作图谱已引入的 `@xyflow/react` v12；四个媒体适配器全部用 Node 原生 `fetch` / `FormData`；撤销栈 / 对齐参考线 / 剪贴板自制；
  2. **全场景通用**：创作与协作能力与场景无关，护栏 = 会话显式绑定媒体连接 + 任务可见可取消 + 生成量由用户控制；
  3. **最小权限不变式**：媒体连接未绑定时，工具与生成面板均给「去绑定」引导而非静默失败；
  4. **零回归**：不破坏协作图谱既有 E2E 断言类名；新增动效全部响应 `.quiet-mode`；
  5. **渐进披露纪律**（ADR 54）：4 个新工具全部 `tier='deferred'`，经 `tool_search` 激活。

## 决策

1. **技术底座：复用 React Flow v12**（与协作图谱同栈）——画布文档为用户数据（非推导视图），受控更新纪律沿用协作图谱踩坑经验：重建节点列表复用未变节点引用、更新时保留 `measured`、拖拽起点前压栈。
2. **画布粒度：会话级单文档**——`data/canvas/<sessionId>.json`（JSON 单文档 + `version` 乐观锁 + tmp/rename 原子写 + debounce flush，对齐 ADR 6 / settings 模式）；`PUT` 带 `baseVersion`，冲突 `409` 回传服务端最新版；预留全局素材库扩展位（本期不实现）。
3. **数据模型**：`CanvasDoc { v, sessionId, version, updatedAt, viewport, nodes, edges }`；**7 类节点**（image / video / note / prompt / mind / artifact / group；节点类型注册表可扩展 = 联合类型 + 渲染器 + 校验矩阵三处同步）；**边三分语义**——`flow` 实线流动（生成数据流）/ `mind` 层级曲线 / `ref` 虚线关联（视觉语言与协作图谱同源）。
4. **媒体生成：适配器注册表 + 首批四适配器**——ComfyUI HTTP（本地生图 / 生视频 / 首尾帧；工作流 JSON 占位符 `{{prompt}}/{{image}}/{{first_frame}}/{{last_frame}}` 深替换 + `/interrupt` 取消）、Stable Diffusion WebUI（本地生图）、OpenAI 兼容图像 API（云端生图）、通用异步任务模板（云端视频 API：提交-轮询-取件三段式 + 点路径提取，变量插值）；适配器契约 `MediaProviderAdapter { kind, capabilities, test, run(job, ctx) }`，产物经 `ctx.saveOutput` 统一落盘。
5. **任务管线「创建即返回」**——`MediaJob` 状态机 `queued → running → succeeded / failed / canceled`；队列并发上限默认 2；超时护栏（图像 5min / 视频 10min，连接可覆盖）；产物统一落盘 `workspace/<sid>/canvas/media/gen-*.ext` 成为普通交付件（`video` kind 新增，`ArtifactKind` 同步）；工具侧同步入队后**立即回灌 job id** + 「完成后产物在 …，可用 canvas_write 放上画布」提示——分钟级任务与工具执行窗口正确解耦，完成态经 WS 推送 + `job.canvasTarget` 驱动前端 media-store 自动放置节点。
6. **连接中心扩展 `media` 类**——config = `{ provider, baseUrl, models?, defaultModel?, capabilities, workflows?, template?, timeoutMs? }`，secret = `{ apiKey? }`（复用 SecretVault 加密与「明文永不回传」纪律）；未绑定会话在工具与生成面板均给「去绑定」引导。
7. **脑图工坊**——服务端 `POST /sessions/:id/canvas/mind` 按来源（conversation / plans / tasks / memory / topic）组装上下文 → summaryModel 结构化 JSON 树（失败给明确错误）；前端 `lib/mind.ts` 纯函数树操作（加子 / 加兄弟 / 删除子树 / 重挂 / 扁平化 / dagre 布局 / markdown 大纲解析与导出）；`MindDialog` 生成入口 + Xmind 式快捷编辑（Tab 子节点 / Enter 兄弟 / 折叠 / 一键整理 / 导出 Markdown）。
8. **Agent 闭环四工具**——`canvas_read`（只读；节点 / 边摘要 + 单节点 JSON 详情）/ `canvas_write`（ops 批量：add_node / update_node / remove_node / connect / remove_edge；缺省 id 与服务端 `autoPosition` 自动补并回灌生效 id，写入广播 `by='agent'`）/ `media_generate` / `media_video`；全部 `tier='deferred'`（ADR 54）；补入全部 68 角色 `tools` 白名单（协作机制与创作能力为场景无关）。
9. **通知双通道**——`notify:media-job`（任务创建 / 状态 / 进度节流 / 终态）与 `notify:canvas-changed`（agent 写入后 version 同步）；前端 canvas-store 收远端变更且本地空闲时拉取合流；媒体完成 toast + 画布自动落节点。
10. **前端联动双入口**——消息交付件 chip hover「送上画布」与交付件面板「画布」按钮共用 `sendArtifact`（扩展名分类 → 图片 / 视频直出节点、其余 artifact 引用节点；落位与 server `autoPosition` 同语义：右缘 +80、纵向对齐最上方）；画布节点右键「引用到对话」走既有 `insertToComposer` 通道；命令面板「画布」组（打开 / 新建便签 / 生成脑图 / 适应视野）经 pendingAction 动作通道驱动（lazy chunk 挂载后消费，不丢动作）。

## 理由

- **复用 React Flow v12**：协作图谱（ADR 32）已建成同栈使用经验与受控更新纪律，白板细节（撤销栈 / 对齐参考线 / 剪贴板 / 连线校验矩阵）自制成本远低于引入新库的学习与包体成本；且节点化数据模型使 `canvas_read / canvas_write` 能直接读写画布——**节点 = 可被 agent 操作的数据载体**是本设计区别于白板库的核心。
- **会话级而非全局画布**：创作素材绝大多数来自会话上下文（对话 / 计划 / 任务 / 记忆 / 交付件），会话级边界使「上下文注入脑图生成」「agent 写入画布」的权限与数据自然收敛。
- **JSON 单文档 + 乐观锁**：画布是低频写、整体读的用户数据；`version` 乐观锁防止多端（用户 + agent）并发写互相覆盖（409 + 前端拉取合流），比 CRDT 简单两个量级。
- **适配器注册表 + 四件套**：本地（ComfyUI / SD WebUI）与云端（OpenAI 兼容 / 通用任务模板）覆盖「无网可用、有网可用、任意异步 API 可接」三档；注册表模式使新增提供方零改动核心。
- **「创建即返回」而非等待完成**：视频生成分钟级，工具执行窗口无法承载；同步返回 job id 使 agent 立即继续（可继续写画布 / 回答用户），完成态经 WS 推送与前端自动落位闭环——这是「Agent 协作」与「任务管线」的正确耦合方式。
- **工作流模板占位符替换**：ComfyUI 用户既可用内置默认 txt2img 工作流一键填充，也可粘贴自定义（含视频 / 首尾帧模板），`{{prompt}}` 等深替换覆盖主流节点图定制。
- **工具白名单全角色 + 渐进披露**：创作与协作是场景无关能力（development 角色照样可以画图），前置授权 + `tier='deferred'` 使「有能力」与「不干扰」兼得。
- **产物回归交付件体系**：生成产物 / 上传素材统一落 `canvas/media/` 纳入交付件（`artifact:updated` 广播），历史浏览 / 下载 / 其他面板复用零改动；`video` kind 与 ADR 58 的视频预览互通（Range 直出）。

## 被否决的方案

- **Excalidraw / tldraw 等白板库**：手绘 / 套索 / 形状库为重的白板范式与「节点化工作台」诉求不匹配（自由图形不可被工具读写）；且引入新库违背零新增核心依赖纪律；
- **全局跨会话画布**：权限模型（哪个会话的 agent 能写哪个画布）与上下文注入（脑图来源）边界立即复杂化；本期以会话级收敛，全局素材库留作扩展位；
- **画布协作多人实时**：本地单用户产品形态（与既有 ADR 一致），CRDT / OT 复杂度与收益不成比例；
- **工作流自动连跑（run-all）与参数级联重算**：生成图（DAG）存在环 / 多入边 / 人工挑选的现实，自动级联会放大失败面与成本；「手动触发 + 上游 prompt 自动取用」已覆盖高频路径；
- **手绘 / 套索 / 形状库与自由标注**：以节点化为先（nodes = agent 可操作数据）；自由标注留作节点类型注册表扩展位；
- **音频生成 / 配音与视频理解抽帧**：媒体能力以图像 / 视频为先（用户明确诉求），音频与抽帧留作适配器 / 管道扩展；
- **为媒体任务单独建表持久化**：任务为内存态（每会话最近 50 条供历史再生成），产物以交付件为持久真相——避免与交付件体系双轨；
- **等待式工具（阻塞到生成完成）**：分钟级任务会让 agent 长时间挂起且撞工具超时护栏；「创建即返回」语义使长任务与 agent 交互正确解耦；
- **在协作图谱组件上改造成画布**：协作图谱是 run 事件推导视图（只读），画布是用户可写文档——同一库（React Flow）但受控模式与数据源完全不同，共用组件会引入双向特判；仅复用视觉语言（Background Dots / RelayEdge 技法 / FIT_MAX_ZOOM 口径）。

## 适用与失效条件

- 适用：本地单用户部署（与既有 ADR 同一产品形态）；媒体生成依赖用户自行配置 ComfyUI / SD WebUI / 云端 API 连接——**未配置时画布、脑图、笔记、上传、交付件功能完全可用（媒体生成为增强）**。
- 失效条件：
  - 若需要全局跨会话素材库 / 画布模板市场，`data/canvas/<sessionId>.json` 的会话级边界需重新设计（全局文档 + 引用计数）；
  - 若媒体任务需要跨重启恢复 / 队列持久化，内存态任务表应迁移为 DB 表（含队列位次重建）；
  - 若画布需要多人实时协作，React Flow 受控模式 + 单文档 JSON 方案应评估 CRDT 化（本 ADR 的「本地单用户」前提失效）；
  - 若引入对象存储（S3 / OSS），`canvas/media/` 落盘路径与产物下载通道需重新设计（预签名 URL）；
  - 若视频理解 / 抽帧 / 配音成为核心诉求，需新增媒体处理管道（ffmpeg / Whisper），「零新增依赖」前提失效，`media/types.ts` 的适配器契约需扩展后处理阶段。
