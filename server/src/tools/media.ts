/**
 * M31：媒体生成工具集（media_generate / media_video）。
 *
 * 异步语义：本工具「创建即返回」（媒体生成为分钟级长任务，工具通道超时护栏不可同步等待）——
 * 入队后立即回灌任务 id；完成后产物落交付件并广播 artifact:updated，
 * 画布落位由任务的 canvasTarget 驱动：前端 media-store 在任务完成时自动放置节点（place_on_canvas 缺省开启）。
 *
 * 最小权限（与画布生成面板同一纪律）：
 * - 未配置媒体连接 / 连接未声明对应能力 → 透传 MediaService 的引导文案（「设置 → 媒体生成」），绝不静默失败；
 * - 输入素材（首尾帧 / 输入图）限定工作区相对路径，越界 / 不存在由 MediaService 拒绝（早失败早引导）；
 * - 任务的进度 / 取消 / 重试由用户在生成面板操作（agent 不持有取消权）。
 */
import { z } from 'zod'
import type { MediaCapability, MediaJob, MediaJobInput } from '@multi-agent/shared'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'

const IMAGE_CAPS = ['text2image', 'image2image'] as const
const VIDEO_CAPS = ['text2video', 'image2video', 'firstlast2video'] as const

const CAPABILITY_LABEL: Record<MediaCapability, string> = {
  text2image: '文生图',
  image2image: '图生图',
  text2video: '文生视频',
  image2video: '图生视频',
  firstlast2video: '首尾帧视频',
}

interface MediaToolArgs {
  capability: MediaCapability
  prompt: string
  negative?: string
  connection_id?: string
  model?: string
  images?: string[]
  first_frame?: string
  last_frame?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
  duration?: number
  workflow_id?: string
  place_on_canvas: boolean
}

/** 创建任务并发回灌（两个工具共用；错误文案由 MediaService 给出引导） */
function runMediaTool(args: MediaToolArgs, ctx: ToolRuntime): ToolResult {
  if (!ctx.media) return { ok: false, summary: '媒体生成未启用（服务端未装配媒体服务）' }
  const inputs: MediaJobInput['inputs'] = {}
  if (args.images && args.images.length > 0) inputs.images = args.images
  if (args.first_frame) inputs.firstFrame = args.first_frame
  if (args.last_frame) inputs.lastFrame = args.last_frame
  const params: MediaJob['params'] = {}
  if (args.width !== undefined) params.width = args.width
  if (args.height !== undefined) params.height = args.height
  if (args.steps !== undefined) params.steps = args.steps
  if (args.seed !== undefined) params.seed = args.seed
  if (args.duration !== undefined) params.duration = args.duration
  if (args.workflow_id) params.workflowId = args.workflow_id
  const result = ctx.media.create(ctx.sessionId, ctx.agentId, {
    connectionId: args.connection_id,
    capability: args.capability,
    model: args.model,
    prompt: args.prompt,
    negative: args.negative,
    inputs,
    params,
    // M31 修订：占位落位由服务端接管（创建即落；缺省自动排布，天然错开并发任务）
    placeOnCanvas: args.place_on_canvas,
  })
  if ('error' in result) {
    return {
      ok: false,
      summary: result.error,
      detail:
        '请先修正上述问题再重试；若提示未配置媒体生成连接，需要用户到「设置 → 媒体生成」创建并启用连接。',
    }
  }
  const job = result.job
  const placed = job.placedCanvas === true
  return {
    ok: true,
    summary: `已创建${CAPABILITY_LABEL[job.capability]}任务 ${job.id}（连接：${job.connectionName ?? job.connectionId}${job.model ? `，模型：${job.model}` : ''}）`,
    detail: [
      `任务已进入队列。媒体生成为异步长任务（数分钟级）：完成后产物落到交付件${placed ? '并在画布上原地完成（占位节点已就位）' : ''}；用户可在画布生成面板查看进度 / 取消 / 再生成。`,
      '本回合无需等待：可继续其它工作（如用 canvas_write 预摆提示词 / 便签节点，产物落位后再连线）。',
    ].join('\n'),
    // M31 修订：占位节点 id 随 meta 持久化（消息侧「在画布查看」定位到生成中的节点）
    meta: job.canvasNodeId ? { canvasNodes: [job.canvasNodeId] } : undefined,
  }
}

/** 两工具共用的基础字段（prompt 纪律：文本生图 / 视频的动作描述写具体） */
const baseFields = {
  prompt: { type: 'string', description: '生成提示词（正向描述；写具体）' },
  negative: { type: 'string', description: '负面提示词（不希望出现的内容）' },
  connection_id: { type: 'string', description: '媒体连接 id（缺省 = 第一条启用中的连接）' },
  model: { type: 'string', description: '模型名（缺省 = 连接配置的默认模型）' },
  width: { type: 'number', description: '输出宽度（像素，64-4096）' },
  height: { type: 'number', description: '输出高度（像素，64-4096）' },
  steps: { type: 'number', description: '采样步数（1-150）' },
  seed: { type: 'number', description: '随机种子（固定即为可复现生成）' },
  workflow_id: { type: 'string', description: 'ComfyUI 工作流模板 id（连接配置中声明；缺省用默认工作流）' },
  images: {
    type: 'array',
    items: { type: 'string' },
    description: '输入图片（工作区相对路径，1-4 张；图生图 / 图生视频必填）',
  },
  place_on_canvas: { type: 'boolean', description: '完成后自动把产物放到画布（默认 true；关闭则仅落交付件）' },
} as const

const baseSchemaFields = {
  prompt: z.string().min(1).max(4000),
  negative: z.string().max(2000).optional(),
  connection_id: z.string().min(1).optional(),
  model: z.string().min(1).max(120).optional(),
  width: z.number().int().min(64).max(4096).optional(),
  height: z.number().int().min(64).max(4096).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  workflow_id: z.string().min(1).max(120).optional(),
  images: z.array(z.string().min(1)).min(1).max(4).optional(),
  place_on_canvas: z.boolean().default(true),
}

function mediaDescription(kindLabel: string, capabilities: string): string {
  return `${kindLabel}（${capabilities}）。需先由用户在「设置 → 媒体生成」配置并启用媒体连接（未配置时返回引导）。创建即返回任务 id（异步执行，本回合不要空等）；默认完成后产物自动落到画布右下空位（place_on_canvas=false 关闭）。输入图 / 首尾帧用工作区相对路径（如用户附件或此前的生成产物，先用 list_dir 确认）。用户可在画布生成面板查看进度、取消、再生成。`
}

const mediaGenerateTool = {
  name: 'media_generate',
  tier: 'deferred' as const,
  description: mediaDescription('生成图片', '文生图 text2image / 图生图 image2image（image2image 需 images 输入图）'),
  parameters: {
    type: 'object',
    properties: {
      capability: { type: 'string', enum: [...IMAGE_CAPS], description: '生成能力（默认 text2image）' },
      ...baseFields,
    },
    required: ['prompt'],
  },
  schema: z.object({ capability: z.enum(IMAGE_CAPS).default('text2image'), ...baseSchemaFields }),
  async execute(args: MediaToolArgs, ctx: ToolRuntime): Promise<ToolResult> {
    return runMediaTool(args, ctx)
  },
}

const mediaVideoTool = {
  name: 'media_video',
  tier: 'deferred' as const,
  description: mediaDescription(
    '生成视频',
    '文生视频 text2video / 图生视频 image2video（需 images）/ 首尾帧视频 firstlast2video（需 first_frame + last_frame）',
  ),
  parameters: {
    type: 'object',
    properties: {
      capability: { type: 'string', enum: [...VIDEO_CAPS], description: '生成能力（默认 text2video）' },
      ...baseFields,
      first_frame: { type: 'string', description: '首帧图片（工作区相对路径；首尾帧视频必填）' },
      last_frame: { type: 'string', description: '尾帧图片（工作区相对路径；首尾帧视频必填）' },
      duration: { type: 'number', description: '视频时长（秒，1-60）' },
    },
    required: ['prompt'],
  },
  schema: z.object({
    capability: z.enum(VIDEO_CAPS).default('text2video'),
    ...baseSchemaFields,
    first_frame: z.string().min(1).optional(),
    last_frame: z.string().min(1).optional(),
    duration: z.number().min(1).max(60).optional(),
  }),
  async execute(args: MediaToolArgs, ctx: ToolRuntime): Promise<ToolResult> {
    return runMediaTool(args, ctx)
  },
}

/** M31：媒体生成工具集（media_generate / media_video；写类，串行执行） */
export function createMediaTools(): AgentTool[] {
  return [mediaGenerateTool, mediaVideoTool]
}
