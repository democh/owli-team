/**
 * 协议单一事实源：客户端 / 服务端共享的全部类型。
 * 修改本文件即同时约束两端（TS 穷举 switch 会强制清单完整性）。
 */

// ---------- 角色 ----------

/** M50：空场景（单助手直聊）场景 id —— 单成员编制时未 @ 消息直达本人，不进入平台路由 */
export const BLANK_SCENE_ID = 'blank'

export interface AgentAvatar {
  /** 形象图（agents/<场景>/<id>/avatar.png 自动发现为 /api/agents/<id>/avatar；也可显式配置路径） */
  image?: string
  /** 回退方案：渐变 + lucide 图标（图片缺失 / 加载失败时） */
  gradient?: [string, string]
  icon?: string
}

/** 灵魂（Soul）元数据（§26）：可选人格变体，只影响表达风格与互动方式 */
export interface SoulMeta {
  id: string
  name: string
  tagline: string
  /** 前端徽标图标（lucide 名） */
  icon?: string
  traits: string[]
  tone: string
}

/** M52：场景工作区形态（scene-expansion §7.2/§7.8）——按场景定制的四形态；未声明 / 未命中一律回退 stream */
export type StageLayout = 'stream' | 'dock' | 'roundtable' | 'arena'

/** M52：工作区面板类型（dock 右区 / roundtable 汇聚板；§7.4 六类注册表）；M65-B：+ studio（设计工作室 3D 工作台） */
export type StagePanel = 'pool' | 'versus' | 'board' | 'console' | 'coach' | 'chartboard' | 'studio'

/** M52：四形态合法值（前端形态注册表联动；服务端 schema 与之一致） */
export const STAGE_LAYOUTS: readonly StageLayout[] = ['stream', 'dock', 'roundtable', 'arena']

/** M52：六类面板合法值（前端面板注册表联动）；M65-B：+ studio（设计工作室 3D 工作台） */
export const STAGE_PANELS: readonly StagePanel[] = ['pool', 'versus', 'board', 'console', 'coach', 'chartboard', 'studio']

/** M52：arena 席位分组（仅 arena 生效；成员 id 须存在，check:agents 校验） */
export interface StageSeats {
  left?: string[]
  right?: string[]
  center?: string[]
}

/** M52：场景工作区声明（_group.yaml 可选字段，向后兼容——未声明即 stream） */
export interface GroupStage {
  layout: StageLayout
  /** 仅 dock / roundtable：工作区面板类型（§7.4） */
  panel?: StagePanel
  /** 仅 arena：席位分组 */
  seats?: StageSeats
  /** 启用元件清单（缺省 = 场景默认集；值域见 client/src/components/scene/parts 注册表） */
  parts?: string[]
}

/** P4：仪式化订阅声明（_group.yaml ritual 块；一键订阅 = 建会话 + cron 定时任务） */
export interface RitualDeclaration {
  /** 仪式标题（订阅后作为会话与任务标题） */
  title: string
  /** cron 5 段表达式（分 时 日 月 周；时区缺省 = 服务器默认） */
  cron: string
  /** IANA 时区（可选） */
  timezone?: string
  /** 到点注入的开场指令（run 任务 instruction） */
  opener: string
  /** 参与成员（角色 id；缺省 = 场景 chain） */
  members?: string[]
  /** 订阅入口展示文案 */
  description?: string
}

/** P4：仪式订阅（ritual_subscriptions 表投影；一键订阅落库，调度 tick 到点建会话并注入 opener） */
export interface RitualSubscription {
  id: string
  /** 订阅者（多用户 userId；兼容模式 'local'） */
  userId: string
  /** 来源场景（agents/<id>/_group.yaml） */
  sceneId: string
  /** 系统仪式 id（存在 = 来自内置清单而非场景声明；去重键与 sceneId 独立） */
  ritualId?: string
  title: string
  /** cron 5 段表达式（分 时 日 月 周） */
  cron: string
  /** 归一化后的 IANA 时区 */
  timezone: string
  /** 到点注入的开场指令（用户消息；不含 @，走 PRS / 编制语义） */
  opener: string
  /** 建会话参与成员（订阅时快照：声明 members ?? 场景 chain） */
  members: string[]
  /** 订阅时的空间归属（建会话随行；缺省 = 我的空间） */
  spaceId?: string
  enabled: boolean
  nextRunAt?: string
  lastRunAt?: string
  /** 最近一次生成的会话（留痕） */
  lastSessionId?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

/** 场景（分组）元数据：agents/<场景>/_group.yaml（§25） */
export interface AgentGroup {
  id: string
  name: string
  description: string
  /** 场景徽标（lucide 名） */
  icon: string
  /** 主题色（前端点缀） */
  theme: [string, string]
  objective: string
  /** 默认接力链（有序编制；建会话时按此排序落库） */
  chain: string[]
  /** 场景默认技能（agent 未显式配置 skills 时生效） */
  defaultSkills: string[]
  /** 场景内允许自动成波并行（默认 false） */
  parallel: boolean
  /** 允许多人多轮交替（放宽循环检测阈值，默认 false） */
  rounds: boolean
  /** 场景并行上限（覆盖全局 PARALLEL_MAX） */
  parallelMax?: number
  /** M37：空态引导标题（缺省回退前端内置文案） */
  guide?: string
  /** M37：空态议程 chips（点击预填 Composer 草稿） */
  agenda?: { label: string; prompt: string }[]
  /** 展示排序（越小越靠前） */
  order: number
  /** M52：场景工作区形态声明（未声明即 stream；前端 scene 注册表消费，异常一律回退 stream） */
  stage?: GroupStage
  /** P4：仪式化订阅声明（可选；一键订阅 = 按 members/chain 建会话 + cron 定时任务注入 opener） */
  ritual?: RitualDeclaration
}

export interface AgentDefinition {
  id: string
  name: string
  /** 角色徽标，如「产品经理」 */
  role: string
  title: string
  description: string
  capabilities: string[]
  avatar: AgentAvatar
  /** 所属场景 id（由 agents/<场景>/ 目录名推导；旧 prompts/ 回退模式为 development） */
  group: string
  /** 可用灵魂变体（无 souls/ 目录时缺省；非必配） */
  souls?: SoulMeta[]
  /** front-matter 显式指定的默认灵魂 id（未写时取 souls/default.md） */
  soul?: string
  /** 默认灵魂 id（front-matter soul > souls/default.md；都没有 = 无灵魂） */
  defaultSoul?: string
  /** 常见交接对象（引导模型选择下游） */
  handoff: string[]
  /** 工具白名单（缺省 = 全部可用工具） */
  tools?: string[]
  /** 预载 Skill 名（正文直接进系统提示） */
  skills?: string[]
  model?: string
  temperature?: number
}

/** 快速组队预设：agents/_presets.yaml（可选资产；缺失时前端自动隐藏该区块） */
export interface RosterPreset {
  id: string
  name: string
  description: string
  /** 预设徽标（lucide 名） */
  icon: string
  /** 主题色（前端点缀） */
  theme: [string, string]
  /** 成员（角色 id，可跨场景；须已存在） */
  members: string[]
  /** 开场指令模板（建会话后预填为 Composer 草稿） */
  prompt: string
  /** 展示排序（越小越靠前） */
  order: number
}

// ---------- 会话与消息 ----------

export type MessageStatus = 'streaming' | 'complete' | 'error' | 'stopped'

export interface Session {
  id: string
  title: string
  /**
   * 在场成员（有序 = 编制顺序）。M77 起条目为「成员键」：
   * 经典实例 = `agentId`（灵魂走 memberSouls 覆盖）；分身实例 = `agentId~soulId`（灵魂内嵌）。
   * 存量数据（纯 agentId）天然合法，零迁移。
   */
  participantIds: string[]
  /** M57（多用户）：会话属主（users.id）；缺省 = 单用户兼容模式（无账号体系时创建的历史数据） */
  ownerId?: string
  /** M79：会话社会形态（team = 以 agent 编制为核心的协作；direct/group = 以人为核心的聊天；缺省 = team） */
  kind?: SessionKind
  /** M79：触发策略（auto = 无 @ 消息交给平台路由组队（现状）；mention = 仅点名唤起；缺省 = auto） */
  routeMode?: SessionRouteMode
  /** M86：接力控制（auto = 成员可自动转交下一棒；manual = 仅用户点按派发才接棒；缺省按会话形态推导，见 resolveRelayMode） */
  relay?: SessionRelayMode
  /** M79：持球方（被 agent 点名待回复的 userIds；空/缺省 = 无） */
  waitingOn?: string[]
  /** 会话级灵魂覆盖（经典成员键 = agentId → soulId；空 = 用角色默认；M16 起支持随时换装） */
  memberSouls?: Record<string, string>
  /** M24：规划先行（会话级开关；用户未显式指定范式时首波默认进入 plan 范式；默认关闭） */
  planFirst?: boolean
  /** M88：自动编排策略（auto = 按意图判定；always-plan / never-plan = 强制；缺省 = auto） */
  autonomy?: SessionAutonomy
  /** M46-2：串行执行（会话级开关；开 = 波次逐位出场，便于跟进与查看；缺省开启；关闭 = 场景可并行成波） */
  serial?: boolean
  /** 关联项目（M6：真实仓库挂载）；缺省 = 会话级沙箱工作区 */
  projectId?: string
  /** 所属空间（Space.id；缺省 = DEFAULT_SPACE_ID 我的空间，存量零迁移） */
  spaceId?: string
  /** 会话工作区绝对路径（worktree / sandbox / repo 三种模式统一落这里） */
  workspaceDir?: string
  createdAt: string
  updatedAt: string
}

export interface SessionSummary extends Session {
  messageCount: number
  /** M57 P2：当前请求者相对会话的角色（owner / editor / viewer；单用户兼容模式缺省不标注） */
  role?: SessionAccessRole
  /** M79：服务端权威未读数（当前请求者视角；缺省 = 无未读语义） */
  unreadCount?: number
  lastMessage?: {
    /** system（成员变更事件条等）也会出现在摘要预览中 */
    role: 'user' | 'agent' | 'system'
    agentId?: string
    /** M77：说话成员键（分身 = `agentId~soulId`；列表预览署名可分辨实例） */
    memberKey?: string
    content: string
    createdAt: string
    /** M57：人类消息作者（共享会话列表预览署名；兼容模式 / 历史数据缺省） */
    userId?: string
    userName?: string
  }
}

// ---------- M57 P2：会话共享协作 ----------

/** 共享角色（owner 由 sessions.owner_id 承载，不进成员表） */
export type SessionShareRole = 'editor' | 'viewer'

/** 当前请求者的会话权限角色（列表 role 标注 / 前端写操作 gating） */
export type SessionAccessRole = 'owner' | SessionShareRole

// ---------- M57 P3：配额与用量 ----------

/** 用户配额上限（undefined = 不限；maxConcurrentRuns 缺省回退系统 RUN_MAX_PER_USER） */
export interface QuotaLimits {
  maxConcurrentRuns?: number
  /** 日 token 配额（prompt + completion 合计） */
  dailyTokens?: number
  /** 月成本配额（美元） */
  monthlyCostUsd?: number
  maxSessions?: number
  /** 存储上限（MB；工作区目录总体积） */
  maxStorageMb?: number
}

/** 用量与配额汇总（GET /api/usage/me；admin 逐用户见 GET /api/users/:id/usage） */
export interface UsageSummary {
  userId: string
  /** 今日 token（prompt + completion；服务器本地时区日界） */
  todayTokens: number
  /** 本月成本（美元；本地时区月界） */
  monthCostUsd: number
  /** 会话数（不含已删除） */
  sessions: number
  /** 工作区存储（MB，保留一位小数） */
  storageMb: number
  /** 生效中的配额上限（未配置项缺省） */
  limits: QuotaLimits
}

/** M57 P3：用户 LLM 凭据（BYOK）状态投影（绝不含密钥） */
export interface LlmCredentialStatus {
  /** 是否已配置（false = 使用系统默认模型与 Key） */
  configured: boolean
  /** 自定义接入地址（缺省 = 系统默认） */
  baseUrl?: string
  /** 自定义模型（缺省 = 系统默认） */
  model?: string
  updatedAt?: string
}

/** 会话共享成员（GET /sessions/:id/shares 投影；用户名 / 昵称随行返回便于前端直接渲染） */
export interface SessionShare {
  userId: string
  username: string
  displayName: string
  /** M79-B：画像投影（头衔 / 头像；缺省 = 未设置） */
  headline?: string
  avatar?: UserAvatar
  role: SessionShareRole
  /** 邀请人（users.id；可空：历史 / 系统） */
  invitedBy?: string
  createdAt: string
}

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  /** M47：'stopped' = 运行中断（用户停止 / 回合超时），非工具失败 —— 前端琥珀色呈现，不计入失败指标 */
  status: 'running' | 'ok' | 'error' | 'stopped'
  summary?: string
  /** M31 修订：工具结构化元信息（如 canvas_write / media_* 的 canvasNodes 节点 id 清单——消息侧「在画布查看」精确定位依据） */
  meta?: Record<string, unknown>
  startedAt: string
  endedAt?: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  runId?: string
  /** M33：消息附件（上传的图片 / 视频 / 文档；用户消息为主，发送时随消息持久化） */
  attachments?: MessageAttachment[]
  /** 本 Run 内的波次序号（0 基；同波消息共享；用户消息为 -1；M16 波次化后语义升级） */
  turnIndex?: number
  /** 会话内单调递增序号：分页、压缩水位、增量拉取的唯一依据 */
  seq?: number
  /** system = 成员变更等系统事件条（持久化可回放，但不进 LLM 窗口） */
  role: 'user' | 'agent' | 'system'
  agentId?: string
  /** M77：说话成员键（分身 = `agentId~soulId`；经典实例 = 与 agentId 相同；存量消息缺省） */
  memberKey?: string
  /** M57（多用户）：人类消息作者（users.id；agent / system 消息为空） */
  userId?: string
  content: string
  /** 持久化：交还用户时恒为 ['user']；否则为调度器实际接手的成员 */
  mentions: string[]
  /** M79：人类定向（userIds；@在场人类 / 行首 @用户 解析结果——与 agent mentions 隔离） */
  humanMentions?: string[]
  status: MessageStatus
  createdAt: string
  /** 本条消息产出的交付件（工作区相对路径） */
  artifacts?: string[]
  /** 工具调用记录 */
  toolCalls?: ToolCallRecord[]
  /** 推理模型（deepseek-reasoner 等）的思考内容：不进入正文，可折叠展示 */
  reasoning?: string
  /** M24：本条消息所属回合范式（规划 / 评审；缺省 = 执行） */
  mode?: TurnMode
  /** M88：范式来源（user = 用户显式选择；rule / router = 自动判定；plan = 计划派发；缺省 = 未判定） */
  modeSource?: IntentSource
  /** M35：本条消息由定时任务注入时 = 任务 id（UI 渲染「定时」徽章并可回链任务；缺省 = 普通消息） */
  scheduleId?: string
  /** M80-B：表情回应聚合（服务端投影；mine 按请求者计算；缺省 = 无回应） */
  reactions?: ReactionSummary[]
}

/** M80-B：单条消息的单 emoji 回应聚合 */
export interface ReactionSummary {
  emoji: string
  count: number
  /** 回应者 userIds（悬停名单；含本人时 mine=true） */
  userIds: string[]
  /** 当前请求者是否已挂（服务端按 viewer 投影） */
  mine: boolean
}

/** M80-C：会话成员已读水位（GET /sessions/:id 投影；仅含开启已读展示的成员） */
export interface MemberReadState {
  userId: string
  lastReadSeq: number
}

// ---------- M33：消息附件（上传通道） ----------

/**
 * M33：消息附件（上传的文件 / 图片 / 视频 / Office 文档）。
 * - kind 与交付件 ArtifactKind 同口径（扩展名映射），前端复用同一套渲染分支；
 * - 多模态通道：kind='image' 且 mime 受视觉支持时，随对话窗口注入 image_url；
 * - 识别管道：office / pdf 内容经 read_file 提取文本；视频以 duration 元数据感知。
 */
export interface MessageAttachment {
  /** 会话工作区内相对路径（uploads/<ts>-<name>） */
  path: string
  /** 原始文件名（展示用） */
  name: string
  /** 附件类别（image / video / office / pdf / data / code / markdown / other…） */
  kind: ArtifactKind
  /** MIME 类型（视觉通道 image_url 构造依据） */
  mime: string
  size: number
  /** 图片：像素宽度（服务端解析文件头；SVG 等无法解析时缺省） */
  width?: number
  /** 图片：像素高度 */
  height?: number
  /** 视频 / 音频：时长（毫秒；上传时由客户端读取媒体元数据提交） */
  durationMs?: number
  uploadedAt: string
}

// ---------- SSE 运行事件（RunEvent：一次运行的内容流） ----------

export type RunEndReason = 'completed' | 'stopped' | 'error' | 'turn-limit' | 'interrupted' | 'quota'

export type RunEvent =
  | { type: 'user:message'; message: ChatMessage }
  | { type: 'run:start'; runId: string; sessionId: string; queue: string[]; intent?: TurnIntent }
  /** M88：编排判定（首波前 / PRS 合并后；携带可解释理由与派生范式） */
  | { type: 'intent:decided'; runId: string; sessionId: string; intent: TurnIntent; mode: TurnMode }
  /** M88：运行期纠偏建议（写扩散到多成员/多文件 → 建议下一条改用「规划」；仅提示，不强制改判） */
  | { type: 'intent:suggest-plan'; runId: string; sessionId: string; writes: number; agents: string[] }
  /** M16：波次启动（串行波也发，members 长度 1；前端统一处理；M24 起携带本波默认范式） */
  | { type: 'wave:start'; runId: string; sessionId: string; waveIndex: number; members: string[]; mode?: TurnMode }
  | { type: 'turn:start'; runId: string; agentId: string; messageId: string; turnIndex: number; mode?: TurnMode; memberKey?: string }
  | { type: 'message:delta'; messageId: string; delta: string }
  | { type: 'reasoning:delta'; messageId: string; delta: string }
  | { type: 'tool:call'; messageId: string; call: ToolCallRecord }
  | { type: 'tool:result'; messageId: string; call: ToolCallRecord }
  | { type: 'artifact:updated'; path: string; authorAgentId?: string }
  | {
      type: 'turn:end'
      messageId: string
      agentId: string
      mentions: string[]
      queue: string[]
      status: MessageStatus
      /** M77：说话成员键（分身实例；经典实例缺省 = 与 agentId 相同） */
      memberKey?: string
    }
  | { type: 'run:end'; runId: string; sessionId: string; reason: RunEndReason; error?: string }
  | { type: 'error'; message: string }
  /** M2：上下文压缩发生（前端展示「已压缩 N 条历史」） */
  | {
      type: 'context:compressed'
      sessionId: string
      untilSeq: number
      beforeTokens: number
      afterTokens: number
      degraded: boolean
    }
  /** M3：任务清单更新 */
  | { type: 'task:updated'; tasks: TaskItem[] }
  /** M7：审批请求 / 结果 */
  | { type: 'approval:requested'; approval: ApprovalRequest }
  | { type: 'approval:resolved'; approval: ApprovalRequest }
  /** M4：token 用量（每回合一次） */
  | { type: 'usage'; usage: UsageSnapshot }
  /** M3：运行中用户插话被消费 */
  | { type: 'user:injected'; message: ChatMessage }
  /** M14：指挥台重排排队（仅未出手顺序变化；认领语义不变） */
  | { type: 'queue:updated'; runId: string; sessionId: string; queue: string[] }
  /** M24：计划提交（plan 范式产出）/ 变更（编辑、步骤进度、状态迁移） */
  | { type: 'plan:submitted'; plan: Plan }
  | { type: 'plan:updated'; plan: Plan }
  /** M24：评审提交（review 范式产出） */
  | { type: 'review:submitted'; review: ReviewRecord }

// ---------- WebSocket 通知（NotifyEvent：跨会话生命周期信号） ----------

export type NotifyType =
  | 'notify:run-started'
  | 'notify:turn-end'
  /** M79-X：消息删除（payload: { messageId }）——同会话即时移除；跨会见列表对账 */
  | 'notify:message-deleted'
  /** M79-X：会话删除（owner 操作；payload: {}）——共享成员与多标签列表即时移除 */
  | 'notify:session-deleted'
  /** M79-Y：指挥台队列重排（payload: { queue }）——触发者之外的其他端/成员实时对齐 */
  | 'notify:queue-updated'
  /** M79-Z：旁观端流式（节流聚合；payload: { messageId, agentId, memberKey, delta }）——非触发者同会话实时打字机 */
  | 'notify:message-delta'
  | 'notify:run-completed'
  | 'notify:run-error'
  | 'notify:awaiting-user'
  | 'notify:agent-status'
  | 'notify:artifact-updated'
  | 'notify:task-updated'
  | 'notify:approval-requested'
  | 'notify:approval-resolved'
  /** M24：计划提交 / 变更（payload: { plan }） */
  | 'notify:plan-submitted'
  | 'notify:plan-updated'
  | 'notify:context-compressed'
  /** M16：会话成员变更（添加 / 移出 / 换灵魂；payload: { session, message }） */
  | 'notify:members-changed'
  /** M57 P2：会话共享变更（邀请 / 改角色 / 移出 / 自助退出；payload: { sessionId, userId, role?, action }） */
  | 'notify:share-changed'
  /** M26：资产变更（Agent / Skill / 场景；保留会话主题 __assets__；payload: { kind, id, action }） */
  | 'notify:assets-changed'
  /** M27：MCP 服务器 / 工具变更（保留会话主题 __mcp__；payload: { serverId?, action }） */
  | 'notify:mcp-changed'
  /** M22：操作事件（连接 / 查询 / 远程命令 / 浏览器动作；payload: OpEvent） */
  | 'notify:op'
  /** M22：连接状态变化（测试 / 健康检查；payload: { connectionId, status, error? }） */
  | 'notify:connection-status'
  /** M22：浏览器会话状态变化（payload: { browserSessionId, sessionId, state }） */
  | 'notify:browser-status'
  /** M31：媒体生成任务状态变化（payload: MediaJob；画布进度与历史消费） */
  | 'notify:media-job'
  /** M31：画布文档变更（payload: { sessionId, version, by: 'agent' | 'user' }；agent 写入后同步前端） */
  | 'notify:canvas-changed'
  /** M35：定时任务创建 / 更新 / 删除 / 触发 / 跳过 / 暂停（payload: { action, scheduleId?, schedule? }） */
  | 'notify:schedule-changed'
  /** M35：定时提醒到点（remind 型任务；payload: { scheduleId, title, instruction }） */
  | 'notify:schedule-reminder'
  /** M79：收件箱事件实时投递（用户主题；payload: { item: InboxItem }） */
  | 'notify:inbox'
  /** M79：本用户其他端已读推进（payload: { sessionId, lastReadSeq }） */
  | 'notify:read-state'
  /** M79：在线状态聚合（payload: { users: [{ userId, online, lastSeenAt }] }） */
  | 'notify:presence'
  /** M79：好友关系变化（payload: { userId, action: 'request'|'accepted'|'removed'|'blocked' }） */
  | 'notify:friends-changed'
  /** M79：会话元数据变更（waitingOn / 标题 / routeMode；payload: { session }） */
  | 'notify:session-meta'
  /** M80-B：消息表情回应变更（payload: { sessionId, messageId, reactions: ReactionSummary[] }——全量替换该消息投影） */
  | 'notify:reaction'
  /** M80-C：成员已读水位推进（会话主题；payload: { sessionId, userId, lastReadSeq }；仅开启已读展示的用户产生） */
  | 'notify:read-receipt'

export interface NotifyEnvelope {
  v: 1
  id: string
  /** 每会话递增序号（重连补发游标） */
  seq: number
  type: NotifyType
  ts: string
  sessionId: string
  runId?: string
  payload: Record<string, unknown>
}

export interface NotifyListResponse {
  notifications: NotifyEnvelope[]
  cursor: number
  truncated?: boolean
}

// ---------- 交付件 ----------

/**
 * M24：交付件类型（渲染器选择依据，由扩展名映射）。
 * - markdown：.md/.markdown，富渲染（M19 扩展全套）；
 * - code：源码 / 配置 / 文本，shiki 高亮；
 * - html：.html/.htm，沙箱 iframe 预览 + 源码模式；
 * - chart：.mmd/.mermaid 与 *.chart.json，mermaid / echarts 渲染；
 * - data：.csv/.tsv，解析为表格；
 * - image：图片直出（png/jpg/gif/svg/webp/avif/bmp…）；
 * - video：视频直出（mp4/webm/mov/m4v，M31 画布媒体创作）；
 * - office：doc/docx/xls/xlsx/ppt/pptx（docx/xlsx/pptx 服务端轻量解析预览，旧格式下载）；
 * - pdf：.pdf，浏览器内置预览；
 * - other：其余（下载引导）。
 */
export type ArtifactKind =
  | 'markdown'
  | 'code'
  | 'html'
  | 'chart'
  | 'data'
  | 'image'
  | 'video'
  | 'office'
  | 'pdf'
  | 'other'

/** 交付件来源（索引登记时的写入通道；scan = 低频校准发现的外部文件） */
export type ArtifactOrigin = 'tool' | 'upload' | 'media' | 'canvas' | 'git' | 'scan'

/**
 * 交付件分层（服务端单点判定）：
 * - final：结论性交付；process：行情快照 / 中间态数据；
 * - attachment：用户上传附件；media：画布素材与媒体生成产物。
 */
export type DeliveryClass = 'final' | 'process' | 'attachment' | 'media'

export interface Artifact {
  /** 会话工作区内的相对路径 */
  path: string
  size: number
  mtime: number
  kind: ArtifactKind
  authorAgentId?: string
  updatedAt: string
  /** M6：repo / worktree 模式下来自 git 变更集的变更类型（A 新增 / M 修改 / D 删除 / R 重命名…） */
  gitStatus?: string
  /** 交付件索引：来源 / 分层 / 归属（旧服务端响应缺省这些字段，前端按路径启发式回退） */
  origin?: ArtifactOrigin
  deliveryClass?: DeliveryClass
  runId?: string
  /** 会话内单调递增的索引版本（增量同步与 ETag 依据） */
  revision?: number
}

// ---------- 交付件预览（M24：Office 服务端轻量解析） ----------

/** xlsx 单个工作表预览（rows 首行为表头行） */
export interface OfficeSheetPreview {
  name: string
  rows: string[][]
  truncated?: boolean
}

/** pptx 单页幻灯片大纲（标题 + 正文行） */
export interface OfficeSlidePreview {
  title?: string
  lines: string[]
}

/** `GET /api/sessions/:id/artifacts/preview` 响应（按 kind 判别的联合类型） */
export type ArtifactPreview =
  | { kind: 'docx'; html: string; truncated?: boolean }
  | { kind: 'xlsx'; sheets: OfficeSheetPreview[]; truncated?: boolean }
  | { kind: 'pptx'; slides: OfficeSlidePreview[]; truncated?: boolean }

// ---------- Skill ----------

export interface SkillMeta {
  name: string
  description: string
  tags: string[]
}

// ---------- M26：资产控制台（Agent / Skill 管理） ----------

/** 资产引用清单（删除 / 修改前的影响面提示；文案已本地化） */
export interface AssetRefs {
  items: string[]
}

/** 控制台 Agent 摘要（列表卡片） */
export interface ConsoleAgentSummary {
  id: string
  name: string
  role: string
  title: string
  description: string
  group: string
  avatar: AgentAvatar
  /** 目录内存在 avatar.png（自动发现生效中） */
  hasAvatar: boolean
  /** 预载技能数（-1 = 未配置，继承场景 defaultSkills） */
  skillCount: number
  /** 工具白名单数（-1 = 未限制，全部工具） */
  toolCount: number
  soulCount: number
  handoffCount: number
  /** 影响面引用总数（handoff / 编制链 / 预设 / 会话成员） */
  refCount: number
}

/** 灵魂全文（管理面专用：含 quirks 与正文） */
export interface ConsoleSoulDetail {
  id: string
  name: string
  tagline: string
  icon?: string
  traits: string[]
  tone: string
  quirks: string[]
  body: string
  isDefault: boolean
}

/** 控制台 Agent 详情（编辑器数据源） */
export interface ConsoleAgentDetail extends ConsoleAgentSummary {
  /** 结构化 front-matter（写回仅接受白名单字段） */
  meta: AgentDefinition
  /** AGENT.md 正文（front-matter 之后的部分） */
  body: string
  souls: ConsoleSoulDetail[]
  refs: AssetRefs
}

/** Agent 新建 / 更新入参（tools / skills 支持 null 表达三态） */
export interface AgentWriteInput {
  name: string
  role: string
  title?: string
  description?: string
  capabilities?: string[]
  avatar?: AgentAvatar
  /** 默认灵魂 id；'' = 清除 */
  soul?: string
  handoff?: string[]
  /** 工具白名单；null = 未限制（全部工具） */
  tools?: string[] | null
  /** 预载技能；null = 未配置（继承场景兜底）；[] = 显式不预载 */
  skills?: string[] | null
  model?: string | null
  temperature?: number | null
  body: string
}

/** 场景写入（新建场景 / 二期场景管理共用） */
export interface GroupWriteInput {
  id: string
  name: string
  description?: string
  icon?: string
  theme?: [string, string]
  objective?: string
}

/** Agent 创建入参：group 指向已有场景；newGroup 缺省时要求 group 已存在 */
export interface AgentCreateInput extends AgentWriteInput {
  id: string
  group: string
  newGroup?: GroupWriteInput
}

/** 灵魂写入入参 */
export interface SoulWriteInput {
  name: string
  tagline?: string
  icon?: string
  traits?: string[]
  tone?: string
  quirks?: string[]
  body: string
  /** 保存后设为该角色默认灵魂（写回 AGENT.md soul 字段） */
  setDefault?: boolean
}

/** 控制台 Skill 摘要（列表） */
export interface ConsoleSkillSummary {
  name: string
  description: string
  tags: string[]
  /** 正文行数（列表体积提示） */
  lineCount: number
  /** 预载引用该技能的角色 id */
  usedByAgents: string[]
  /** 作为场景默认技能引用该技能的场景 id */
  usedByGroups: string[]
}

/** 控制台 Skill 详情（编辑器数据源） */
export interface ConsoleSkillDetail extends ConsoleSkillSummary {
  body: string
  refs: AssetRefs
}

/** Skill 新建 / 更新入参（name 即目录名，创建后不可改） */
export interface SkillWriteInput {
  description: string
  tags?: string[]
  body: string
}

/** Agent Studio：AI 生成的 Agent 草稿（POST /api/console/generate/agent；草稿不落盘） */
export interface AgentDraftPayload {
  id: string
  name: string
  role: string
  title: string
  description: string
  capabilities: string[]
  group: string
  newGroup?: { id: string; name: string; description?: string; objective?: string }
  avatar: { icon: string; gradient?: [string, string] }
  handoff: string[]
  skills: string[] | null
  temperature: number
  body: string
}

/** Agent Studio：AI 生成的 Skill 草稿（POST /api/console/generate/skill） */
export interface SkillDraftPayload {
  name: string
  description: string
  tags: string[]
  body: string
}

/** 生成结果（草稿 + 校验 issues + 实际尝试轮次） */
export interface GenerateDraftResult<T> {
  draft: T
  issues: string[]
  attempts: number
  model: string
}

/** 工具中心条目（读：清单 / 分类 / 授权情况；写：二期全局禁用） */
export interface ConsoleToolInfo {
  name: string
  description: string
  readOnly: boolean
  /** 参数项数（JSON Schema properties 计数） */
  paramCount: number
  /** 中文分类（服务端映射：文件检索 / 联网 / 业务 / Git / 执行 / 连接自动化 / 记忆协作 / 范式 / MCP） */
  category: string
  /** 工具白名单包含该工具的角色 id */
  usedByAgents: string[]
  /** M27：工具来源（内置 / 外部 MCP 服务器） */
  origin: 'builtin' | 'mcp'
  /** M27：MCP 工具所属服务器 slug（origin=mcp 时存在） */
  server?: string
  /** M28：加载层级（core = 常驻工具清单；deferred = 经 tool_search 检索激活） */
  tier: 'core' | 'deferred'
}

/** 校验问题（控制台页头徽章与校验接口） */
export interface ValidationIssue {
  level: 'error' | 'warning'
  /** 定位（如 agents/strategy/chief/AGENT.md） */
  path: string
  message: string
}

// ---------- M2：上下文 / 记忆 ----------

export type MemoryKind = 'decision' | 'constraint' | 'glossary' | 'artifact' | 'fact' | 'preference' | 'lesson'

/** M25：记忆关联层级（session / agent / project / global） */
export type MemoryScope = 'session' | 'agent' | 'project' | 'global'

/** M25：时间有效性状态（Zep 轻量版；superseded/archived 不参与召回） */
export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'candidate'

export interface MemoryItem {
  id: string
  /** 仅 session scope 有值（agent/project/global 记忆在源会话删除后仍存活） */
  sessionId?: string
  scope: MemoryScope
  ownerId: string
  /** M57（多用户）：归属用户（users.id；单用户兼容模式缺省） */
  userId?: string
  /** 空间域（Space.id；缺省/NULL = 跨域共享的全局记忆；否则仅同空间召回可见） */
  spaceId?: string
  kind: MemoryKind
  content: string
  source?: string
  importance: number
  entities: string[]
  status: MemoryStatus
  supersedes?: string
  supersededBy?: string
  validFrom: string
  validTo?: string
  sourceSessionId?: string
  sourceRunId?: string
  hits: number
  lastUsedAt?: string
  createdAt: string
  updatedAt: string
}

/** 上下文分层（前端「上下文抽屉」展示） */
export interface ContextLayer {
  key: 'L0' | 'L1' | 'L1.5' | 'L2' | 'L3' | 'L4' | 'L5'
  label: string
  tokens: number
  detail?: string
}

export interface ContextSnapshot {
  sessionId: string
  budgetTokens: number
  estimatedTokens: number
  usageRatio: number
  layers: ContextLayer[]
  summary?: string
  /** 已被摘要覆盖到的时间点（会话内 seq） */
  untilSeq: number
  degraded: boolean
  compressedAt?: string
  memory: MemoryItem[]
  /** M25：最近一次语义召回注入明细（L1.5；未启用/无召回时 undefined） */
  recalled?: RecalledMemory[]
}

/** M25：召回条目（L1.5 注入与评分调试接口共享） */
export interface RecalledMemory {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  content: string
  score: number
  /** 混合评分分项（评分调试接口返回；正常注入时可省略） */
  signals?: {
    sim: number
    keyword: number
    entity: number
    importance: number
    recency: number
    scopeWeight: number
  }
}

// ---------- M3：任务清单 / 运行快照 ----------

export type TaskStatus = 'pending' | 'in_progress' | 'done'

export interface TaskItem {
  id: string
  sessionId: string
  runId?: string
  content: string
  status: TaskStatus
  ownerAgentId?: string
  ord: number
}

export interface RunSnapshot {
  id: string
  sessionId: string
  state: 'waiting' | 'running' | 'awaiting_approval' | 'awaiting_plan' | 'done' | 'interrupted'
  queue: string[]
  spoken: string[]
  turnIndex: number
  fallbackUsed: boolean
  handedToUser: boolean
  error?: string
  createdAt: string
  updatedAt: string
  endedAt?: string
}

// ---------- M4：用量 ----------

export interface UsageSnapshot {
  runId: string
  sessionId: string
  agentId?: string
  model: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  kind: 'turn' | 'summary' | 'judge' | 'embed' | 'digest' | 'mind'
}

// ---------- M6：项目与真实仓库 ----------

export type WorkspaceMode = 'sandbox' | 'repo' | 'worktree'

export interface ProjectDefinition {
  id: string
  name: string
  rootPath: string
  workspaceMode: WorkspaceMode
  baseBranch?: string
  /** M57（多用户）：项目属主（users.id）；缺省 = 单用户兼容模式 */
  ownerId?: string
  createdAt: string
  updatedAt: string
}

// ---------- M7：人机协同审批 ----------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout'

export interface ApprovalRequest {
  id: string
  runId: string
  sessionId: string
  agentId?: string
  action: string
  detail: string
  options: string[]
  status: ApprovalStatus
  decision?: string
  feedback?: string
  createdAt: string
  decidedAt?: string
}

// ---------- M24：协作范式与计划（规划 / 执行 / 评审） ----------

/** 回合范式（与角色正交）：plan=只读规划并提交计划；execute=正常执行；review=结构化评审 */
export type TurnMode = 'plan' | 'execute' | 'review'

export const TURN_MODES: TurnMode[] = ['plan', 'execute', 'review']

export type PlanStatus =
  | 'submitted'
  | 'approved'
  | 'executing'
  | 'done'
  | 'rejected'
  | 'superseded'
  | 'blocked'

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'

/** 计划步骤（owner 缺省 = 计划作者；mode 缺省 = execute） */
export interface PlanStep {
  id: string
  content: string
  /** 步骤负责人（会话成员 id） */
  ownerAgentId?: string
  /** 步骤范式：execute=正常执行；review=评审（只读工具 + submit_review） */
  mode?: 'execute' | 'review'
  /** 期望产出（交付件路径 / 判定结果描述；回灌给负责人的回合指令） */
  expectedOutput?: string
  /** 验收标准（收口与评审依据） */
  acceptance?: string
  status: PlanStepStatus
  /** 进度备注（blocked 必填原因） */
  note?: string
}

/** 协作计划（规划范式的结构化产出；会话维度持久化） */
export interface Plan {
  id: string
  sessionId: string
  /** 提交计划的 Run（稍后批准另起执行 Run 时仍保留提交来源） */
  runId?: string
  /** 计划作者（提交者） */
  agentId: string
  title: string
  goal: string
  steps: PlanStep[]
  /** 风险与依赖（自由文本列表） */
  risks: string[]
  status: PlanStatus
  /** 修订版本（v1 起；驳回后重提递增） */
  version: number
  /** 最近一次驳回反馈 */
  feedback?: string
  createdAt: string
  updatedAt: string
  approvedAt?: string
}

export type ReviewVerdict = 'pass' | 'conditional' | 'fail'

/** 评审记录（评审范式的结构化判定） */
export interface ReviewRecord {
  id: string
  sessionId: string
  runId?: string
  /** 评审人 */
  agentId: string
  planId?: string
  stepId?: string
  /** 评审目标：plan:<id> / step:<id> / artifact:<path> / message:<id> */
  target: string
  verdict: ReviewVerdict
  /** 发现清单（fail / conditional 必填） */
  findings: string[]
  /** 证据（文件路径 / 命令输出摘要等） */
  evidence: string[]
  createdAt: string
}

// ---------- M9：可观测与评测 ----------

export interface TraceEntry {
  id: number
  runId: string
  sessionId: string
  turnIndex: number
  type: string
  payload: Record<string, unknown>
  ts: string
}

export interface MetricsSummary {
  runs: number
  turns: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  compressions: number
  toolCalls: number
  toolFailures: number
  avgTurnMs: number
}

/**
 * M89：角色级质量指标（按 agent 聚合）。
 * 数据源：usage（kind=turn 的 token/费用）、tool_metrics（工具成败）、plans.steps（步骤推进）、reviews（评审判定）。
 * 用于定位“哪个角色在拖后腿”——回合成本高 / 工具失败多 / 步骤阻塞 / 评审不通过。
 */
export interface AgentMetric {
  agentId: string
  /** 模型调用轮次（kind=turn；含回合内的工具子轮） */
  turns: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  toolCalls: number
  toolFailures: number
  /** 计划步骤：完成 / 阻塞（owner 缺省 = 计划作者） */
  planStepsDone: number
  planStepsBlocked: number
  /** 评审次数与未通过次数（作为评审人） */
  reviews: number
  reviewFails: number
}

/** M61-D6：调度健康聚合（路由 / 波次 / 抑制 / 冲突 / 接单）——指标接口来源 */
export interface SchedulingStats {
  runs: number
  /** 成功路由（非降级）次数 */
  routes: number
  /** 降级接手次数（fallback） */
  routeFallbacks: number
  /** 波次总数 */
  waves: number
  /** 并行波次数 */
  parallelWaves: number
  /** 循环抑制次数（签名 / 内容级） */
  loopSuppressed: number
  /** 停滞抑制次数（零写动作 + 文本高度相似） */
  stallSuppressed: number
  /** 并行写冲突次数 */
  writeConflicts: number
  /** 交接接单次数（接单回执） */
  handoffAccepted: number
}

/** 消息反馈（👍/👎 + 原因；导出为评测候选集） */
export interface FeedbackItem {
  id: string
  sessionId: string
  messageId: string
  /** 1 = 好评，-1 = 差评 */
  rating: number
  reason?: string
  createdAt: string
}

// ---------- 其它 ----------

export type AgentRunState = 'idle' | 'speaking' | 'thinking' | 'done' | 'error'

export const DEFAULT_CHAIN: string[] = ['pm', 'architect', 'designer', 'frontend', 'backend', 'qa', 'devops']

/** M26：资产变更通知的保留会话主题（全端广播；不进未读计数） */
export const ASSETS_TOPIC = '__assets__'

export const USER_ALIASES = ['用户', 'user', '你']

export interface HealthResponse {
  ok: boolean
  /** 当前模型名（真实模型为唯一运行路径） */
  model: string
  baseUrl?: string
  /** 思考模式（V4）：on 时顶栏展示「思考」标记 */
  thinking?: boolean
}

// ---------- M22：连接中心（数据库 / SSH / 浏览器接入） ----------

/**
 * 连接类型：三种数据库 + SSH + 浏览器（CDP）+ 嵌入模型（M25）+ 媒体生成（M31）+ 模型服务（多 Provider，openai 协议）
 * + 出口代理（M82：HTTP(S) / SOCKS5 出网代理；SSH 隧道 P1）
 */
export type ConnectionKind =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'ssh'
  | 'chrome'
  | 'embedding'
  | 'media'
  | 'llm'
  | 'proxy'

export type ConnectionStatus = 'idle' | 'ok' | 'error'

/** 连接定义（对外视图；secret 明文永不回传，仅 secretSet 标记） */
export interface ConnectionDefinition {
  id: string
  name: string
  kind: ConnectionKind
  /** 非敏感参数（host/port/database/username/浏览器接入参数等） */
  config: Record<string, unknown>
  status: ConnectionStatus
  lastCheckedAt?: string
  lastError?: string
  enabled: boolean
  /** 是否已保存凭据（明文仅服务端可解密） */
  secretSet: boolean
  /** M57 P3：作用域（system = 团队共享；personal = 属主私有；旧行为缺省 system） */
  scope?: 'system' | 'personal'
  /** M57 P3：personal 连接属主（users.id；system 为空） */
  ownerId?: string
  /** M57 P3：是否允许成员使用（仅对 system 连接有意义；默认 true） */
  memberUse?: boolean
  createdAt: string
  updatedAt: string
}

/** 创建 / 更新入参 */
export interface ConnectionInput {
  name: string
  kind: ConnectionKind
  config: Record<string, unknown>
  /** 创建时可空；更新时缺省 = 不改动，null = 清空 */
  secret?: Record<string, unknown> | null
  enabled?: boolean
  /** M57 P3：成员可用开关（admin 对 system 连接） */
  memberUse?: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  latencyMs?: number
  /** 服务端版本 / 浏览器版本等描述 */
  detail?: string
  error?: string
}

/** 会话绑定的连接（面板与工具清单共用） */
export interface SessionConnectionInfo {
  connection: ConnectionDefinition
  grantedAt: string
}

// ---------- M22：操作事件（可视化与审计的实时通道） ----------

export type OpKind = 'connection' | 'db' | 'ssh' | 'browser' | 'browser-input' | 'takeover'

export interface OpEvent {
  id: string
  ts: string
  sessionId: string
  runId?: string
  /** 'user' 或成员 id */
  actor: string
  kind: OpKind
  /** 动作名：db.query / ssh.exec / browser.click / browser.takeover ... */
  action: string
  /** 操作目标描述：conn:name / postgres:db@host / browser:url */
  target?: string
  status: 'running' | 'ok' | 'error'
  durationMs?: number
  summary?: string
  detail?: string
  /** M22+：查询结果预览（仅 db.query 附带，最多 5 行；直播窗展示用） */
  preview?: { columns: string[]; rows: Array<Record<string, unknown>> }
}

// ---------- M22：浏览器（CDP 接入与可视化） ----------

export type BrowserBackend = 'managed' | 'local' | 'remote'

export type BrowserState =
  | 'launching'
  | 'reconnecting'
  | 'ready'
  | 'acting'
  | 'human'
  | 'awaiting_human'
  | 'closed'
  | 'error'

/** 浏览器会话状态（面板与工具共用） */
export interface BrowserSessionInfo {
  id: string
  sessionId: string
  connectionId?: string
  backend: BrowserBackend
  state: BrowserState
  controller: 'agent' | 'human'
  /** 启动形态：true=无头（默认）/ false=打开窗口 */
  headless?: boolean
  /** true=复用了已运行的浏览器实例（进程不归本服务管理；启动形态由该实例决定） */
  external?: boolean
  viewport?: { width: number; height: number }
  endpoint?: string
  currentUrl?: string
  createdAt: string
  closedAt?: string
  /** M62：归属用户 id（多用户模式；单用户兼容模式缺省） */
  ownerId?: string
  /** M62：关闭原因（空闲回收 / 会话删除 / 用户删除 / 服务重启等；缺省 = 常规关闭） */
  closeReason?: string
  lastFrameAt?: string
  /** 面板展示用：帧流 topic（`browser:<id>`） */
  topic: string
}

/** M62：活跃实例总览条目（admin 观测面；GET /api/browser/sessions） */
export interface BrowserInstanceInfo extends BrowserSessionInfo {
  /** 归属用户显示名（admin 视图 enrich；兼容模式缺省） */
  ownerName?: string
  /** 距最近活动的毫秒数（空闲回收判定同源） */
  idleMs: number
  /** 帧流订阅者数量（0 = 无观察者） */
  subscribers: number
}

/** 浏览器步骤（时间轴 + 截图证据） */
export interface BrowserStepInfo {
  id: number
  browserSessionId: string
  sessionId: string
  runId?: string
  agentId?: string
  seq: number
  actor: 'agent' | 'human'
  action: string
  args?: Record<string, unknown>
  url?: string
  screenshotPath?: string
  ok: boolean
  durationMs?: number
  detail?: string
  ts: string
}

/** 自动发现结果（连接表单「自动检测」） */
export interface BrowserDiscoverResult {
  executables: Array<{ path: string; name: string; version?: string }>
  endpoints: Array<{ port: number; url: string; browser?: string }>
}

/** 流 token（watch / takeover 服务端分权） */
export interface StreamTokenResponse {
  token: string
  topic: string
  mode: 'watch' | 'takeover'
  expiresIn: number
}

// ---------- M23：数据库工作台（Navicat 式面板） ----------

/** 表结构 DTO（面板对象树；与连接器快照同构的稳定子集） */
export interface DbPanelColumn {
  name: string
  type?: string
  nullable?: boolean
}

export interface DbPanelTable {
  schema?: string
  name: string
  kind?: string
  columns: DbPanelColumn[]
}

export interface DbSchemaResponse {
  tables: DbPanelTable[]
  truncated: boolean
}

/** 面板查询 / 执行结果（行值已安全化：BigInt → string、二进制 → 短描述） */
export interface DbPanelQueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  /** 返回行数（截断前） */
  rowCount: number
  truncated?: boolean
  durationMs: number
  /** 写语句影响行数 */
  affectedRows?: number
}

/** POST /connections/:id/sql 响应：mode 由服务端护栏判定（query=只读，execute=写） */
export interface DbSqlResponse {
  mode: 'query' | 'execute'
  result: DbPanelQueryResult
}

/** POST /connections/:id/sql 的 dryRun 响应：仅需护栏判定（面板写语句确认流） */
export interface DbSqlClassifyResponse {
  mode: 'query' | 'execute'
  dryRun: true
}

/** GET /connections/:id/tables/:table/rows：分页浏览（offset/limit + limit+1 探测 hasMore） */
export interface DbTableRowsResponse {
  columns: string[]
  rows: Array<Record<string, unknown>>
  offset: number
  limit: number
  hasMore: boolean
  durationMs: number
}

// ---------- M23：SSH（连接 / 命令执行 / 交互终端） ----------

export type SshAuthMethod = 'password' | 'key' | 'agent'

/** SSH「本地」预置（服务端本机探测；连接管理 → 新建 SSH 一键填入） */
export interface SshLocalPreset {
  name: string
  host: string
  port: number
  /** 本机登录用户（os.userInfo） */
  username: string
  authMethod: SshAuthMethod
  /** authMethod = key 且检测到默认私钥时给出（~ 形式，服务端读取时展开） */
  privateKeyPath?: string
  /** 服务端进程可见 SSH Agent（SSH_AUTH_SOCK 非空） */
  agentAvailable: boolean
  /** 本机 22 端口 TCP 可达（未监听时提示先开启系统「远程登录 / sshd」） */
  sshdReachable: boolean
}

/** 一次性 SSH 命令执行结果（ssh_exec 工具与面板命令共用的 DTO） */
export interface SshExecResultDto {
  stdout: string
  stderr: string
  /** 退出码（信号终止时为 null） */
  code: number | null
  signal?: string
  durationMs: number
  /** 输出超出上限被截断 */
  truncated: boolean
}

/** SSH 终端 WS（/ws/ssh）协议：server → client（data 走二进制帧，控制走 JSON 文本帧） */
export type SshTerminalServerMessage =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'exit'; code: number | null; signal?: string }
  | { type: 'error'; message: string }
  | { type: 'pong' }

/** SSH 终端 WS 协议：client → server（输入走二进制帧） */
export type SshTerminalClientMessage = { type: 'resize'; cols: number; rows: number } | { type: 'ping' }

// ---------- M27：MCP 接入与管理 ----------

/** MCP 变更通知的保留会话主题（全端广播；不进未读计数） */
export const MCP_TOPIC = '__mcp__'

export type McpTransportKind = 'stdio' | 'http'

export type McpServerStatus = 'idle' | 'ok' | 'error'

/** 审批策略：risky 仅写类工具按全局模式拦截（默认）/ always 全部拦截 / never 显式豁免 */
export type McpApprovalPolicy = 'risky' | 'always' | 'never'

/** 只读判定覆盖：auto 采信 MCP annotations.readOnlyHint / readonly 强制只读 / write 强制写类 */
export type McpReadOnlyOverride = 'auto' | 'readonly' | 'write'

/** 非敏感参数（凭据类 env / headers 走 SecretVault，不进 config） */
export interface McpServerConfig {
  /** stdio：启动命令（argv 数组不过 shell） */
  command?: string
  args?: string[]
  /** stdio：工作目录（缺省 = 应用根目录） */
  cwd?: string
  /** http：Streamable HTTP 端点 */
  url?: string
  /** 单次工具调用超时（毫秒，1s–600s；缺省 = 全局 TOOL_TIMEOUT_MS） */
  timeoutMs?: number
  /** 审批策略（默认 risky） */
  approvalPolicy?: McpApprovalPolicy
  /** 只读判定覆盖（默认 auto） */
  readOnlyOverride?: McpReadOnlyOverride
  /** M28：本服务器全部工具常驻（跳过延迟发现；缺省 = 按需检索激活） */
  eagerLoad?: boolean
}

/** 单个 MCP 工具（工具清单快照条目；registeredName 为注册表实际名） */
export interface McpToolInfo {
  /** `mcp__<slug>__<tool>`（经规范化的注册名） */
  registeredName: string
  /** MCP 服务器声明的原始工具名（调用时使用） */
  rawName: string
  description?: string
  /** 按 annotations.readOnlyHint + readOnlyOverride 判定的只读标记 */
  readOnly: boolean
  /** M28：是否默认延迟加载（false = 服务器 eagerLoad 常驻；缺省同 true 语义） */
  deferByDefault?: boolean
}

/** MCP 服务器定义（对外视图；secret 明文永不回传，仅 secretSet 标记） */
export interface McpServerDefinition {
  id: string
  /** slug（`^[a-z][a-z0-9-]{0,39}$`，唯一，工具名前缀用它） */
  name: string
  /** 展示名（缺省显示 name） */
  displayName?: string
  transport: McpTransportKind
  config: McpServerConfig
  /** 是否已保存凭据（stdio env / http headers；明文仅服务端可解密） */
  secretSet: boolean
  enabled: boolean
  status: McpServerStatus
  lastCheckedAt?: string
  lastError?: string
  /** 工具清单快照（连接 / 刷新时更新；未连接时可能为空） */
  tools: McpToolInfo[]
  /** 配置来源：env（MCP_SERVERS 种子导入）/ ui（管理台维护）/ json（mcp.json 文件权威同步） */
  source: 'env' | 'ui' | 'json'
  /** M57 P3：作用域（system = 团队共享；personal = 属主私有；旧行为缺省 system） */
  scope?: 'system' | 'personal'
  /** M57 P3：personal 服务器属主（users.id；system 为空） */
  ownerId?: string
  createdAt: string
  updatedAt: string
}

/** 创建 / 更新入参（secret 缺省 = 不改动，null = 清空） */
export interface McpServerInput {
  name?: string
  displayName?: string | null
  transport?: McpTransportKind
  config?: McpServerConfig
  secret?: Record<string, unknown> | null
  enabled?: boolean
}

export interface McpServerTestResult {
  ok: boolean
  latencyMs?: number
  /** 服务器信息 / 工具数量描述 */
  detail?: string
  error?: string
  toolCount?: number
}

/** 会话绑定的 MCP 服务器（面板与工具清单共用） */
export interface SessionMcpBinding {
  server: McpServerDefinition
  grantedAt: string
}

/** 工具目录条目（/mcp/tools；含角色可达性矩阵） */
export interface McpToolDirectoryEntry {
  registeredName: string
  rawName: string
  server: string
  serverId: string
  description?: string
  readOnly: boolean
  /** 白名单命中该工具的角色 id（精确名或通配） */
  usedByAgents: string[]
  /** 任意角色可达（含未声明 tools 的角色 = 全部工具） */
  reachable: boolean
  /** M28：是否默认延迟加载（false = 服务器 eagerLoad 常驻；缺省同 true 语义） */
  deferByDefault?: boolean
}

// ---------- M28：mcp.json 直配（文件权威同步） ----------

/** mcp.json 同步计数（创建 / 更新 / 删除 / 冲突跳过） */
export interface McpJsonSyncSummary {
  created: number
  updated: number
  removed: number
  /** 冲突（同名非 json 源占用）跳过数 */
  skipped: number
}

/** mcp.json 同步结果（GET/POST /mcp/json-config* 共用） */
export interface McpJsonSyncResult {
  ok: boolean
  trigger: 'startup' | 'poll' | 'manual'
  /** 文件不存在（与解析失败一样：跳过同步，绝不删库） */
  missing?: boolean
  errors: string[]
  warnings: string[]
  summary: McpJsonSyncSummary
  syncedAt: string
}

/** mcp.json 直配状态（GET /mcp/json-config） */
export interface McpJsonStatus {
  file: string
  exists: boolean
  pollMs: number
  lastSyncAt?: string
  /** ok = 已同步；skipped = 文件缺失 / 解析失败（防误删跳过） */
  lastResult?: 'ok' | 'skipped'
  lastError?: string
  lastWarnings: string[]
  /** 上次成功解析的条目名（含解析失败但已声明的名字） */
  entries: string[]
  summary: McpJsonSyncSummary
}

/** 粘贴导入结果（创建为 ui 源；同名冲突跳过并报告） */
export interface McpJsonImportOutcome {
  created: string[]
  skipped: Array<{ name: string; reason: string }>
  errors: string[]
  warnings: string[]
}

// ---------- M31：无限画布（会话级空间化工作台） ----------

/** 画布节点类型（节点类型注册表可扩展：新增类型 = 联合类型 + 渲染器 + 校验矩阵三处同步） */
export type CanvasNodeType = 'image' | 'video' | 'note' | 'prompt' | 'mind' | 'artifact' | 'group' | 'game' | 'kline'

/** 画布边语义：flow = 生成数据流（实线，生成中能量流动）；mind = 脑图层级；ref = 关联引用（虚线） */
export type CanvasEdgeKind = 'flow' | 'mind' | 'ref'

/** 媒体生成能力（适配器声明 + 生成面板 / 工具入口按能力裁剪） */
export type MediaCapability = 'text2image' | 'image2image' | 'text2video' | 'image2video' | 'firstlast2video'

/** 图片 / 视频节点共用的生成参数（谱系留痕：调参可复现、变体可追溯） */
export interface CanvasGenerationParams {
  capability?: MediaCapability
  model?: string
  negative?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
  duration?: number
  workflowId?: string
}

export interface CanvasImageData {
  /** 工作区相对路径（生成产物 / 上传素材 / 交付件引用） */
  artifact?: string
  /** 来源：generate = 画布生成 / upload = 拖拽上传 / ref = 交付件引用 */
  source?: 'generate' | 'upload' | 'ref'
  /** 生成谱系（来源任务）；缺省 = 非生成来源 */
  jobId?: string
  /** 生成提示词（谱系展示与「再生成」回填） */
  prompt?: string
  params?: CanvasGenerationParams
  /** 生成中占位（M31 修订：任务创建即落位，完成 / 失败后清除；渲染为呼吸占位 + 进度） */
  pending?: boolean
  /** 生成失败占位（节点保留在画布上，可重试） */
  error?: string
}

export interface CanvasVideoData {
  artifact?: string
  /** 首帧封面（视频 poster；缺省由浏览器取帧） */
  poster?: string
  source?: 'generate' | 'upload' | 'ref'
  jobId?: string
  prompt?: string
  params?: CanvasGenerationParams
  /** 首尾帧输入的 artifact 路径（谱系展示） */
  firstFrame?: string
  lastFrame?: string
  /** 生成中占位（同 CanvasImageData.pending） */
  pending?: boolean
  error?: string
}

/**
 * 博弈推演节点数据（M34 增强）：配置（model / topic / symbol）与最近一次推演结果。
 * - 结果内联存储（simulate / evolve 已为抽样与分位带口径，体积可控）；运行走 `POST /api/finance/game`（纯计算）；
 * - result 缺省 = 配置态（节点内选模型 / 填标的与话题后运行）；params 为再次运行的参数回填。
 */
export interface CanvasGameData {
  /** 模型：matrix | sequence | evolve | simulate（宽松字符串，渲染端收窄） */
  model: string
  topic?: string
  /** 关联标的（仅作标注，不参与计算） */
  symbol?: string
  seed?: number
  /** 推演参数（再次运行时回填；缺省用服务端模型默认） */
  params?: Record<string, unknown>
  /** 最近一次推演结果（缺省 = 配置态） */
  result?: unknown
  stats?: Record<string, unknown>
  narrative?: string
}

/**
 * K 线画布节点数据（M34 增强）：快照元信息 + bars 内联（结构宽松，渲染端过 kline-spec 解析器收窄）。
 * - bars 缺省 = 空态：节点内输入标的直连 `GET /api/finance/kline` 拉取后写回；
 * - 周期 / 复权切换直连网关，切换结果写回节点（节点是用户工作台实体，与 K 线块的「仅本地」不同）。
 */
export interface CanvasKlineData {
  /** 关联标的（如 sh600519；周期切换直连网关的凭据） */
  symbol?: string
  name?: string
  /** 周期：day | week | month | min5 | min15 | min30 | min60（宽松字符串，渲染端收窄） */
  period?: string
  /** 复权：qfq | hfq | none */
  adjust?: string
  /** K 线数据（内联快照；缺省 = 空态） */
  bars?: unknown[]
  /** 指标面板：MA / EMA / VOL / MACD / RSI / KDJ / BOLL / ATR（缺省 MA+VOL） */
  indicators?: string[]
  /** 标注：价格线等（≤20 条） */
  annotations?: unknown[]
  /** M83：落图（shared Drawing 契约；分析与策略产出，「智能分析」写回） */
  drawings?: unknown[]
  /** M83：分析结论（shared KlineAnalysis；分析面板数据源） */
  analysis?: unknown
}

export interface CanvasNodeDataMap {
  image: CanvasImageData
  video: CanvasVideoData
  note: { text: string; accent?: string }
  prompt: { text: string; negative?: string }
  mind: { text: string; collapsed?: boolean; accent?: string }
  artifact: { path: string }
  group: { title: string; color?: string }
  game: CanvasGameData
  kline: CanvasKlineData
}

export type CanvasNodeData = CanvasNodeDataMap[CanvasNodeType]

/** 画布节点（位置 / 尺寸持久化；data 按 type 判别，前端渲染器与校验矩阵共用） */
export interface CanvasNode {
  id: string
  type: CanvasNodeType
  position: { x: number; y: number }
  width?: number
  height?: number
  /** 画框归属（group 收纳）：子节点位置相对父画框（React Flow 子流约定；删除画框时自动转绝对坐标脱离） */
  parentId?: string
  /** 写入者（M31 修订：agent 写入记录其 id；用户写入不设）——画布上的作者徽标依据 */
  by?: string
  data: CanvasNodeData
}

/** 画布边（flow / mind / ref 三语义；id 由前端生成） */
export interface CanvasEdge {
  id: string
  source: string
  target: string
  kind: CanvasEdgeKind
}

/** 画布文档（data/canvas/<sessionId>.json；version 乐观锁） */
export interface CanvasDoc {
  v: 1
  sessionId: string
  /** 每次保存 +1（PUT 带 baseVersion，冲突 409 返回服务端最新版） */
  version: number
  updatedAt: string
  viewport: { x: number; y: number; zoom: number }
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/** agent 写入操作（canvas_write 工具；服务端读-改-写后广播 notify:canvas-changed） */
export interface CanvasNodeInput {
  /** 缺省 = 服务端生成 */
  id?: string
  type: CanvasNodeType
  /** 缺省 = 追加到画布空位（自动排布） */
  position?: { x: number; y: number }
  width?: number
  height?: number
  data: CanvasNodeData
}

export type CanvasOp =
  | { op: 'add_node'; node: CanvasNodeInput }
  | { op: 'update_node'; id: string; data?: Partial<CanvasNodeData>; position?: { x: number; y: number }; width?: number; height?: number }
  | { op: 'remove_node'; id: string }
  | { op: 'connect'; source: string; target: string; kind?: CanvasEdgeKind }
  | { op: 'remove_edge'; id: string }

export interface CanvasOpsResult {
  version: number
  /** 各操作的生效结果（add_node / connect 返回新 id，供工具回灌模型） */
  applied: Array<{ op: CanvasOp['op']; id?: string }>
}

/** GET /sessions/:id/canvas 响应 */
export interface CanvasDocResponse {
  doc: CanvasDoc
  /** 全局是否有启用中的媒体连接（生成面板引导用；媒体生成为全局配置，不区分会话） */
  mediaBound: boolean
}

/** 画布上传响应（POST /sessions/:id/media/upload） */
export interface CanvasUploadResponse {
  path: string
  kind: ArtifactKind
  size: number
}

// ---------- M31：脑图生成 ----------

/** 脑图生成来源：对话 / 计划 / 任务 / 记忆 / 自定义主题 */
export type MindSource = 'conversation' | 'plans' | 'tasks' | 'memory' | 'topic'

/** 结构化脑图树节点（LLM JSON 归一化后；客户端转 mind 节点 + 布局） */
export interface MindTreeNode {
  title: string
  children?: MindTreeNode[]
}

/** POST /sessions/:id/canvas/mind 响应 */
export interface MindGenerateResponse {
  tree: MindTreeNode
  source: MindSource
}

// ---------- M31：媒体生成（连接中心 'media' 类 + 任务管线） ----------

/** 媒体连接提供方（适配器注册表键） */
export type MediaProviderKind = 'comfyui' | 'sdwebui' | 'openai' | 'template'

/** ComfyUI 工作流模板（用户粘贴 API 格式工作流 JSON；占位符 {{prompt}}/{{image}} 等提交前替换） */
export interface MediaWorkflowTemplate {
  id: string
  name: string
  capability: MediaCapability
  /** API 格式工作流 JSON（ComfyUI「Save (API Format)」导出） */
  json: Record<string, unknown>
}

/** 通用异步任务模板（云端视频 API：提交-轮询-取件；点路径提取状态与结果） */
export interface TaskApiTemplate {
  create: { method: 'POST' | 'PUT'; path: string; headers?: Record<string, string>; body: Record<string, unknown> }
  poll: { method: 'GET'; path: string; intervalMs?: number; maxMs?: number }
  extract: {
    /** 任务 id 点路径（body → id；用于轮询 path 的 {id} 插值） */
    taskId?: string
    status?: string
    done?: string[]
    fail?: string[]
    progress?: string
    progressText?: string
    outputUrl?: string
    /** 输出为 URL 数组时的点路径（与 outputUrl 二选一） */
    outputUrls?: string
    errorText?: string
  }
}

/** 媒体连接 config（非敏感；apiKey 走 secret） */
export interface MediaConnectionConfig {
  provider: MediaProviderKind
  baseUrl: string
  /** 可选模型清单（面板选择器数据源；缺省 = 面板隐藏模型选择） */
  models?: string[]
  defaultModel?: string
  /** 连接声明支持的能力（生成面板与工具按此裁剪入口） */
  capabilities: MediaCapability[]
  /** ComfyUI：工作流模板（capability 对应；内置默认 txt2img 可一键填充） */
  workflows?: MediaWorkflowTemplate[]
  /** template：三段式异步任务模板 */
  template?: TaskApiTemplate
  /** 单任务超时（毫秒；缺省 = 服务端按能力默认） */
  timeoutMs?: number
}

/** 媒体任务状态机：queued → running → succeeded / failed / canceled */
export type MediaJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

/** 媒体生成任务（创建后经 notify:media-job 实时推送；历史保留最近 50 条） */
export interface MediaJob {
  id: string
  sessionId: string
  /** 创建者：user = 画布生成面板 / 成员 id = media_* 工具 */
  actor: string
  capability: MediaCapability
  connectionId: string
  connectionName?: string
  model?: string
  prompt: string
  negative?: string
  /** 输入素材（工作区相对路径；image2image / image2video / firstlast2video） */
  inputs: { images?: string[]; firstFrame?: string; lastFrame?: string }
  params: { width?: number; height?: number; steps?: number; seed?: number; duration?: number; workflowId?: string }
  status: MediaJobStatus
  /** 0-100（适配器可上报时；缺省用 progressText） */
  progress?: number
  /** 进度文案：排队位次 / 步骤 / 状态描述（排队中 #2 / 采样 5/20） */
  progressText?: string
  /** 产物（工作区相对路径；succeeded 时非空） */
  outputs: string[]
  error?: string
  /** 画布落位目标（用户面板生成时携带；服务端创建任务时按其落占位节点） */
  canvasTarget?: { x: number; y: number }
  /** 画布占位节点 id（M31 修订：服务端创建任务时落位；完成原地替换 / 失败保留 / 取消移除） */
  canvasNodeId?: string
  /** 画布落位结果（M31 修订：true = 产物已落到画布；缺省 false/undefined = 仅交付件） */
  placedCanvas?: boolean
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

/** GET /media/providers 响应：全局启用中的可用媒体连接（能力 / 模型 / 工作流模板清单） */
export interface MediaProviderInfo {
  connectionId: string
  connectionName: string
  provider: MediaProviderKind
  capabilities: MediaCapability[]
  models: string[]
  defaultModel?: string
  workflows: Array<{ id: string; name: string; capability: MediaCapability }>
}

/** POST /sessions/:id/media/jobs 入参 */
export interface MediaJobInput {
  connectionId?: string
  capability: MediaCapability
  model?: string
  prompt: string
  negative?: string
  inputs?: { images?: string[]; firstFrame?: string; lastFrame?: string }
  params?: MediaJob['params']
  canvasTarget?: { x: number; y: number }
  /** M31 修订：是否落到画布（缺省 true）；false = 仅交付件（media_* 工具的 place_on_canvas=false） */
  placeOnCanvas?: boolean
}

// ---------- M35：定时任务（会话内调度；run = 触发协作运行 / remind = 纯提醒） ----------

/** 触发动作：run = 向目标成员注入消息并启动协作运行；remind = 仅提醒（零 token） */
export type ScheduleActionKind = 'run' | 'remind'

/** 调度规格类型：once = 一次性时刻；cron = 5 段循环表达式 */
export type ScheduleSpecKind = 'once' | 'cron'

/** 最近一次触发结果（paused = 因目标缺失 / 连续失败被自动暂停） */
export type ScheduleLastStatus = 'ok' | 'skipped-busy' | 'skipped-missed' | 'error' | 'paused'

/** 调度规格（触发时刻；时区缺省 = 服务器默认时区） */
export interface ScheduleSpec {
  kind: ScheduleSpecKind
  /** kind='once'：绝对触发时刻（ISO，含时区偏移） */
  at?: string
  /** kind='cron'：5 段表达式（分 时 日 月 周） */
  expr?: string
  /** IANA 时区（缺省 = 服务器默认时区） */
  tz?: string
}

/** 会话内定时任务（scheduled_tasks 表投影） */
export interface ScheduledTask {
  id: string
  sessionId: string
  title: string
  /** run = 到点注入消息并启动运行；remind = 到点仅提醒 */
  kind: ScheduleActionKind
  /** run：注入的用户消息正文（不含 @）；remind：提醒正文 */
  instruction: string
  /** run 专用：@ 目标成员 id（必须是当前会话成员） */
  targetAgentId?: string
  spec: ScheduleSpec
  /** 归一化后的 IANA 时区（创建时由 spec.tz 或服务器默认时区解析） */
  timezone: string
  enabled: boolean
  /** 创建者：'user' | agentId */
  createdBy: string
  nextRunAt?: string
  lastRunAt?: string
  lastRunId?: string
  lastStatus?: ScheduleLastStatus
  lastError?: string
  runCount: number
  failStreak: number
  createdAt: string
  updatedAt: string
}

// ---------- M57：多用户（账号 / 认证 / 归属） ----------

/** 账号角色：admin = 系统管理（设置 / 连接 / MCP / 用户 / 审计）；member = 仅本人资源 */
export type UserRole = 'admin' | 'member'

/** 账号状态：disabled = 禁止登录且即时吊销全部会话 */
export type UserStatus = 'active' | 'disabled'

/** 账号对外投影（绝不含 password_hash） */
export interface UserInfo {
  id: string
  username: string
  displayName: string
  /** M79：头衔（如「产品经理」；≤30 字） */
  headline?: string
  /** M79：一句话简介（≤120 字） */
  bio?: string
  /** M79：头像（色块 / emoji；kind:'image' 预留） */
  avatar?: UserAvatar
  role: UserRole
  status: UserStatus
  /** 管理员创建 / 重置密码后为 true：首登强制改密 */
  mustChangePassword?: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
  lastLoginIp?: string
}

/** GET /api/auth/status（公开）：客户端启动路由决策依据 */
export interface AuthStatus {
  /** true = 尚无任何账号（渲染首启向导；创建首个管理员） */
  needsSetup: boolean
  /** true = 已启用账号体系（需登录）或配置了 AUTH_TOKEN（需令牌） */
  authRequired: boolean
  /** true = 已存在账号（多用户模式） */
  multiUser: boolean
}

/** API Key 对外投影（明文仅在创建时返回一次） */
export interface ApiKeyInfo {
  id: string
  name: string
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  revokedAt?: string
}

/** 个人偏好（user_prefs.prefs JSON；白名单字段由服务端 zod 校验） */
export interface UserPreferences {
  /** 通知兜底轮询间隔覆盖（ms；缺省 = 服务端下发） */
  notifyPollMs?: number
  /** M79：允许他人搜索到我（缺省 = true） */
  searchable?: boolean
  /** M79：允许好友申请（缺省 = true） */
  allowFriendRequests?: boolean
  /** M80-C：向他人展示我的已读状态（对等原则：关闭后也看不到他人的；缺省 = true） */
  showReadReceipts?: boolean
}

/** 定时任务变更通知的 action 枚举（notify:schedule-changed） */
export type ScheduleNotifyAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'fired'
  | 'reminded'
  | 'skipped-busy'
  | 'skipped-missed'
  | 'paused'
  | 'error'

// ---------- M79：社交协作（好友 / 收件箱 / 会话形态 / 触发策略） ----------

/**
 * 头像（M79-B；M79-Q 实装 kind:'image' 上传管道）。
 *
 * - color：`#rrggbb` 底 + 白色首字；
 * - emoji：单个字符（存储可为多码点，≤2 码点）；
 * - image：服务端存储侧 value = 文件名（`<userId>-<ts>.<ext>`）；**对外投影** value = 公开 URL（`/api/avatars/<file>`，含 ts 天然版本化）——见 toUserInfo。
 */
export interface UserAvatar {
  kind: 'color' | 'emoji' | 'image'
  /** color: #rrggbb；emoji: 单字符；image: 文件名（内部）/ 公开 URL（投影） */
  value: string
}

/** 用户公开画像（搜索 / 好友 / 提及候选的统一投影；绝不含凭据） */
export interface UserProfile {
  userId: string
  username: string
  displayName: string
  headline?: string
  bio?: string
  avatar?: UserAvatar
  /** 在线（presence 推导；未装载实时层时缺省） */
  online?: boolean
  lastSeenAt?: string
}

/** 本人视角的好友关系态 */
export type FriendState = 'none' | 'pending-in' | 'pending-out' | 'accepted' | 'blocked'

/** 好友条目（GET /api/friends；按在线 → 最近活跃排序） */
export interface FriendEntry extends UserProfile {
  /** 最近私聊会话 id（无 = 尚未聊过） */
  lastSessionId?: string
}

/** 好友请求（GET /api/friends/requests 收发两视图） */
export interface FriendRequest {
  /** friend_links.id */
  id: string
  direction: 'in' | 'out'
  user: UserProfile
  message?: string
  createdAt: string
}

/** 好友请求聚合（GET /api/friends/requests） */
export interface FriendRequestsView {
  incoming: FriendRequest[]
  outgoing: FriendRequest[]
}

/** 用户搜索结果条目（GET /api/users/search） */
export interface UserSearchHit extends UserProfile {
  relation: FriendState
}

/** 会话社会形态（M79-D） */
export type SessionKind = 'team' | 'direct' | 'group'

// ---------- 空间（Space）：工作生活一体的一级信息架构 ----------

/** 空间类别：work / life / 内置默认 personal / 用户自建 custom */
export type SpaceKind = 'work' | 'life' | 'personal' | 'custom'

/**
 * 空间（Space）：会话列表之上的一级组织维度。
 * - 内置三空间：`default`（我的，存量会话归属）/ `work`（工作）/ `life`（生活），builtin=1 不可删除；
 * - 会话经 `Session.spaceId` 归属；缺省（NULL / 'default'）= 我的空间，存量零迁移、行为零差异；
 * - 通知策略 / 记忆域隔离 / 默认灵魂绑定在后续批次叠加（见 docs/work-life-fusion-design.md）。
 */
export interface Space {
  id: string
  name: string
  kind: SpaceKind
  /** 图标（lucide 名；缺省由前端按 kind 回退） */
  icon?: string
  /** 内置空间（不可删除 / 不可改 kind） */
  builtin?: boolean
  /** 排序（越小越靠前） */
  sort: number
  /** P3：空间默认灵魂（agentId → soulId；成员入编时的默认值，显式选择优先） */
  soulOverrides?: Record<string, string>
  createdAt: string
  updatedAt: string
}

/** 内置默认空间 id（存量会话缺省归属） */
export const DEFAULT_SPACE_ID = 'default'

/** 触发策略（M79-E）：auto = 无 @ 消息交给平台路由（现状）；mention = 仅点名唤起 */
export type SessionRouteMode = 'auto' | 'mention'

/**
 * 接力控制（M86）：agent 之间是否允许自动转交下一棒。
 * - auto = 现状（成员 handoff 即接棒，含未在场角色自动召集）；
 * - manual = 对话模式（handoff 仅记录为「建议」，Run 交还用户，由用户点按派发）。
 * 缺省按会话形态推导（纯人聊天 / 单助手对话 = manual，多成员团队 = auto）。
 */
export type SessionRelayMode = 'auto' | 'manual'

/**
 * 自动编排策略（M88）：决定“这一条消息该不该先出计划”。
 * - auto = 按意图判定（规则 + PRS 结构化判定）；用户显式 mode 永远优先；
 * - always-plan = 强制规划（等价于旧 planFirst=true）；
 * - never-plan = 强制直接执行（高风险动作仍会强制规划，见 intent 阈值）。
 */
export type SessionAutonomy = 'auto' | 'always-plan' | 'never-plan'

/** 意图判定来源（可审计：为什么这一棒进了规划/评审） */
export type IntentSource = 'user' | 'rule' | 'router' | 'policy' | 'default'

/** 意图风险等级（高风险强制规划；阈值按风险分档） */
export type IntentRisk = 'low' | 'medium' | 'high'

/**
 * 回合意图（M88）：编排层的判定结果，不是用户输入。
 * needsPlan / needsReview 是两个独立布尔门（可组合），TurnMode 由它们派生。
 */
export interface TurnIntent {
  needsPlan: boolean
  needsReview: boolean
  /**
   * M89：首波是否直接以评审范式发言（仅“纯验收请求”）。
   * 交付后的评审门只用 needsReview，不置此位——否则“整理方案并检查”会被误判为只读。
   */
  reviewFirst?: boolean
  risk: IntentRisk
  /** 判定置信度 0-1（规则命中 / 路由模型自评） */
  confidence: number
  /** 可解释理由（≤3 条，面向用户展示） */
  reasons: string[]
  source: IntentSource
}

/** 收件箱事件类型（user_inbox.type） */
export type InboxType =
  | 'friend-request'
  | 'friend-accepted'
  | 'session-invite'
  | 'mention'
  | 'waiting'
  | 'system'

/** 收件箱条目（GET /api/inbox；WS 用户主题 notify:inbox 实时投递） */
export interface InboxItem {
  id: string
  /** 每用户单调递增序号（游标 / 缺口检测依据） */
  seq: number
  type: InboxType
  sessionId?: string
  actorId?: string
  /** 触发者显示名（服务端投影，列表直接渲染） */
  actorName?: string
  title: string
  body?: string
  readAt?: string
  createdAt: string
}

/** 收件箱增量响应（GET /api/inbox?since=&limit=） */
export interface InboxListResponse {
  items: InboxItem[]
  /** 当前游标（下次 since 传值） */
  cursor: number
  unreadCount: number
}

// ---------- M68：用户素材库（per-user 私人素材；独立菜单管理页面） ----------

/** 素材种类（图片 / 视频 / 音频——与附件通道白名单口径一致） */
export type LibraryItemKind = 'image' | 'video' | 'audio'
/** 来源：upload 用户上传 / generate 生成收藏 / artifact 交付件收藏（后两者 P2 接入） */
export type LibraryItemSource = 'upload' | 'generate' | 'artifact'

/** 素材条目（GET /api/library/items；内容经 /api/library/items/:id/content 流式取） */
export interface LibraryItem {
  id: string
  /** 展示名（原文件名安全化后） */
  name: string
  kind: LibraryItemKind
  /** 扩展名（含点，小写） */
  ext: string
  mime?: string
  sizeBytes: number
  source: LibraryItemSource
  createdAt: string
}

/** 素材容量（GET /api/library/usage；管理页容量条） */
export interface LibraryUsage {
  count: number
  bytes: number
  /** 存储上限（MB；多用户配额命中时下发；缺省 = 不限） */
  limitMb?: number
}

// ---------- M65-B：家装 3D 场景（DesignScene v1；工作区 design/*.scene.json） ----------

/** DesignScene schema 版本（前向兼容：未知版本只读 + 提示升级） */
export const DESIGN_SCENE_VERSION = 1

/** 家具程序化几何族（v1 封闭枚举：13 类；工作台渲染与家具库共用） */
export const FURNITURE_KINDS = [
  'bed',
  'sofa',
  'table-dining',
  'table-coffee',
  'chair',
  'cabinet',
  'desk',
  'tv-stand',
  'wardrobe',
  'plant',
  'lamp',
  'rug',
  'custom-box',
] as const
export type FurnitureKind = (typeof FURNITURE_KINDS)[number]

/** 材质条目（程序化材质：基色 + 粗糙度 + 纹理提示） */
export interface DesignMaterial {
  /** 基色（#rrggbb） */
  color: string
  /** 粗糙度 0-1 */
  roughness: number
  metalness?: number
  /** 纹理提示（程序化微调；缺省纯色） */
  texture?: 'wood' | 'tile' | 'fabric' | 'wall'
}

/** 材质板（全局命名材质，room / furniture 按名引用） */
export type DesignMaterialPalette = Record<string, DesignMaterial>

/** 房间（多边形 + 高度 + 材质引用；单位 mm） */
export interface DesignRoom {
  id: string
  name: string
  /** 多边形顶点 [[x, y], ...]（mm；坐标面 = 俯视投影，x 向右 / y 向上） */
  polygon: [number, number][]
  /** 层高（mm） */
  height: number
  /** 地板 / 墙面材质名（引用 materials） */
  floor: string
  wall: string
}

/** 门窗洞口（挂墙；offset 为沿墙起点距离） */
export interface DesignOpening {
  id: string
  roomId: string
  /** 墙序号（room.polygon 相邻顶点 i → i+1 为墙 i） */
  wallIndex: number
  type: 'door' | 'window'
  /** 沿墙偏移（mm，从墙起点） */
  offset: number
  /** 洞口宽 / 高（mm；窗有 sill 窗台高） */
  width: number
  height: number
  sill?: number
}

/** 家具实例（程序化几何族；x / y 为俯视坐标，rotation 度） */
export interface DesignFurniture {
  id: string
  kind: FurnitureKind
  label?: string
  x: number
  y: number
  /** 绕竖轴旋转（度，0-360） */
  rotation: number
  /** 等比缩放（缺省 1） */
  scale?: number
  /** 材质名覆盖（缺省按 kind 默认色） */
  material?: string
}

/** 光照（日光方位 + 环境光） */
export interface DesignLights {
  /** 日光方位角（度；0 = 北，顺时针） */
  sunAzimuth: number
  /** 日光高度角（度；10-90） */
  sunElevation: number
  /** 日照强度 0-3 */
  intensity: number
  /** 环境光强度 0-1 */
  ambient: number
}

/** 命名视角（相机预设） */
export interface DesignCameraPreset {
  id: string
  name: string
  mode: 'orbit' | 'top'
  position: [number, number, number]
  target: [number, number, number]
}

/** 家装 3D 场景（DesignScene v1）——工作区 design/<名>.scene.json；agent 经 write_file 产出、工作台读写 */
export interface DesignScene {
  version: 1
  name: string
  /** 内部单位（固定 mm；预留字段） */
  unit: 'mm'
  rooms: DesignRoom[]
  openings: DesignOpening[]
  furniture: DesignFurniture[]
  materials: DesignMaterialPalette
  lights: DesignLights
  camera?: DesignCameraPreset[]
}
