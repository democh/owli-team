/**
 * 请求体校验 schema 集（M7）：路由层统一 safeParse → 400 { error: 首条中文 issue }。
 * 覆盖所有携带 body 的写接口（会话 / 消息 / 项目 / 审批 / worktree 动作）。
 */
import { z } from 'zod'

export const createSessionSchema = z.object({
  /** M48：允许空数组 —— 空选择 = 零编制开场（平台路由步按首条需求自动组队） */
  participantIds: z.array(z.string().min(1)).default([]),
  title: z.string().trim().max(120, '标题过长').optional(),
  projectId: z.string().min(1, 'projectId 非法').optional(),
  /** M16：创建时即选灵魂（agentId → soulId；缺省 = 用角色默认灵魂） */
  souls: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** M46-2：串行执行（缺省开启；显式 false = 允许场景并行成波） */
  serial: z.boolean({ message: 'serial 需为布尔值' }).optional(),
})

/** M33：消息附件（客户端上传后随消息提交；服务端另做存在性与 uploads/ 前缀校验） */
const attachmentSchema = z.object({
  path: z.string().min(1).max(300),
  name: z.string().min(1).max(255),
  kind: z.enum(['markdown', 'code', 'html', 'chart', 'data', 'image', 'video', 'office', 'pdf', 'other']),
  mime: z.string().min(1).max(120),
  size: z.number().int().min(0).max(500 * 1024 * 1024),
  width: z.number().int().positive().max(65535).optional(),
  height: z.number().int().positive().max(65535).optional(),
  durationMs: z.number().int().positive().max(24 * 3600 * 1000).optional(),
  uploadedAt: z.string().min(1),
})

export const sendMessageSchema = z
  .object({
    content: z.string().trim().max(20_000, '消息过长（上限 20000 字符）'),
    /** M24：消息级范式（Composer 三态选择器；仅对本次发送生效，缺省 = 执行） */
    mode: z.enum(['plan', 'execute', 'review'], { message: 'mode 需为 plan / execute / review' }).optional(),
    /** M33：附件清单（≤10 个；纯附件消息允许 content 为空） */
    attachments: z.array(attachmentSchema).max(10, '单条消息最多 10 个附件').optional(),
  })
  .refine((v) => v.content.length > 0 || (v.attachments?.length ?? 0) > 0, '消息内容或附件至少提供一个')

export const renameSessionSchema = z
  .object({
    title: z.string().trim().min(1, '标题不能为空').max(120, '标题过长').optional(),
    /** M24：会话级「规划先行」开关（默认关闭；开启后每回合缺省 plan 范式） */
    planFirst: z.boolean({ message: 'planFirst 需为布尔值' }).optional(),
    /** M46-2：会话级「串行执行」开关（默认开启；关闭后场景可并行成波） */
    serial: z.boolean({ message: 'serial 需为布尔值' }).optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.planFirst !== undefined || v.serial !== undefined,
    'title、planFirst 或 serial 至少提供一个',
  )

export const resumeSessionSchema = z.object({
  runId: z.string().min(1, 'runId 非法').optional(),
})

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'name 必填').max(80, 'name 过长'),
  rootPath: z.string().trim().min(1, 'rootPath 必填').max(4096, 'rootPath 过长'),
  workspaceMode: z.enum(['sandbox', 'repo', 'worktree']).optional(),
  baseBranch: z.string().trim().min(1).max(120, 'baseBranch 过长').optional(),
})

export const patchProjectSchema = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(80, 'name 过长').optional(),
  workspaceMode: z
    .enum(['sandbox', 'repo', 'worktree'], { message: 'workspaceMode 需为 sandbox|repo|worktree' })
    .optional(),
  baseBranch: z.string().trim().min(1).max(120, 'baseBranch 过长').optional(),
})

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'custom'], { message: 'decision 必须是 approve / reject / custom' }),
  feedback: z.string().max(4000, 'feedback 过长（上限 4000 字符）').optional(),
})

/** worktree 合并：必须显式 confirm（防误触改写主仓库分支） */
export const confirmSchema = z.object({
  confirm: z.literal(true, { message: '此操作会改写主仓库分支，需显式确认（body.confirm=true）' }),
})

// ---------- M8：消息操作 / 分支 / 上传 ----------

/** 编辑用户消息（编辑重发前修正内容） */
export const editMessageSchema = z.object({
  content: z.string().trim().min(1, '消息内容不能为空').max(20_000, '消息过长（上限 20000 字符）'),
})

/** 从某条消息 fork 新会话 */
export const forkSchema = z.object({
  fromMessageId: z.string().min(1, 'fromMessageId 必填'),
  title: z.string().trim().max(120, '标题过长').optional(),
})

/** 文件上传（base64 直传；上限由路由侧 8MB 守卫） */
export const uploadSchema = z.object({
  name: z.string().trim().min(1, 'name 必填').max(160, '文件名过长'),
  dataBase64: z.string().min(1, 'dataBase64 必填'),
})

// ---------- M9：反馈 ----------

/** 消息反馈（👍/👎 + 原因；导出为评测候选集） */
export const feedbackSchema = z.object({
  sessionId: z.string().min(1, 'sessionId 必填'),
  messageId: z.string().min(1, 'messageId 必填'),
  rating: z.union([z.literal(1), z.literal(-1)], { message: 'rating 需为 1（好评）或 -1（差评）' }),
  reason: z.string().max(2000, 'reason 过长（上限 2000 字符）').optional(),
})

/** 首条 issue → 中文错误文案 */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message || '请求参数不合法'
}

// ---------- M14：运行中队列重排 ----------

/** 指挥台重排队列（全量覆盖未出手顺序；去重/参与者过滤由引擎兜底） */
export const queueOrderSchema = z.object({
  agentIds: z
    .array(z.string().min(1))
    .min(1, '队列不能为空')
    .max(50, '队列过长（上限 50 位）'),
})

// ---------- M16：会话动态成员 ----------

/** 邀请成员（运行中允许；souls 可选：agentId → soulId，邀请时即选风格） */
export const addMembersSchema = z.object({
  agentIds: z.array(z.string().min(1)).min(1, 'agentIds 必填且不能为空').max(20, '一次最多邀请 20 位成员'),
  souls: z.record(z.string().min(1), z.string().min(1)).optional(),
})

/** 切换成员灵魂：null / 缺省 = 恢复角色默认 */
export const memberSoulSchema = z.object({
  soul: z.string().min(1, 'soul 非法').nullable().optional(),
})

// ---------- M24：范式协作（计划编辑 / 审批） ----------

/** 编辑计划（仅 submitted 状态；steps 全量替换：改负责人 / 调序 / 增删） */
export const planEditSchema = z.object({
  title: z.string().trim().min(1, 'title 不能为空').max(200, 'title 过长').optional(),
  goal: z.string().trim().min(1, 'goal 不能为空').max(4000, 'goal 过长').optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        content: z.string().trim().min(1, '步骤内容不能为空').max(600, '步骤内容过长'),
        ownerAgentId: z.string().min(1, 'ownerAgentId 非法').optional(),
        mode: z.enum(['execute', 'review'], { message: 'mode 需为 execute / review' }).optional(),
        expectedOutput: z.string().max(1000, 'expectedOutput 过长').optional(),
        acceptance: z.string().max(1000, 'acceptance 过长').optional(),
      }),
    )
    .min(1, '步骤不能为空')
    .max(12, '步骤数上限 12')
    .optional(),
  risks: z.array(z.string().max(500, '风险描述过长')).max(6, '风险项上限 6').optional(),
})

/** 计划审批决定（聊天计划卡 / 任务面板共用） */
export const planResolveSchema = z.object({
  decision: z.enum(['approve', 'reject'], { message: 'decision 必须是 approve / reject' }),
  feedback: z.string().max(4000, 'feedback 过长（上限 4000 字符）').optional(),
})
