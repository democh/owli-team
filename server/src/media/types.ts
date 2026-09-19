/**
 * M31：媒体生成类型 —— 适配器契约（零新增依赖：各适配器用 Node 原生 fetch / FormData）。
 *
 * 分层：
 * - MediaProviderAdapter：能力声明 + 可用性测试 + 提交执行（产物落盘由 MediaService 统一收口）；
 * - MediaJobContext：执行上下文（会话工作区解析 / 输入素材绝对路径解析 / 进度上报 / 取消信号）；
 * - 适配器只负责「提交 → 轮询 → 取件」，不接触队列与广播。
 */
import type { ConnectionDefinition, MediaCapability, MediaConnectionConfig, MediaJob } from '@multi-agent/shared'

/** 提交结果：产物以「已落盘的会话工作区相对路径」返回（适配器内部完成下载） */
export interface MediaAdapterOutput {
  /** 工作区相对路径（如 canvas/media/gen-xxx.png） */
  outputs: string[]
}

export interface MediaJobContext {
  /** 已解密的连接（config 为 MediaConnectionConfig 形态） */
  connection: ConnectionDefinition
  /** 连接 config（窄化后的媒体配置） */
  config: MediaConnectionConfig
  /** 已解密凭据（apiKey 等；本地适配器可能为空） */
  secret: Record<string, unknown>
  /** 输入素材：工作区相对路径 → 绝对路径（不存在时抛错） */
  resolveInput(relPath: string): string
  /** 产物落盘：返回工作区相对路径（文件名自动唯一） */
  saveOutput(data: Buffer, ext: string): string
  /** 进度上报（0-100 / 文案；节流由 service 层处理） */
  report(progress?: number, text?: string): void
  /** 取消信号（轮询循环内轮询检查；中断时适配器应尽量发出远端取消） */
  signal: AbortSignal
}

export interface MediaProviderAdapter {
  kind: MediaConnectionConfig['provider']
  /** 支持的媒体能力（连接配置声明必须为其子集） */
  capabilities: MediaCapability[]
  /** 测试连接（「测试」按钮 / providers 探测；返回耗时与描述） */
  test(ctx: {
    config: MediaConnectionConfig
    secret: Record<string, unknown>
    signal: AbortSignal
  }): Promise<{ ok: boolean; detail?: string; error?: string }>
  /** 执行一次生成（含轮询与下载；产物经 ctx.saveOutput 落盘） */
  run(job: MediaJob, ctx: MediaJobContext): Promise<MediaAdapterOutput>
}

/** 能力中文标签（UI / 工具回灌共用） */
export const MEDIA_CAPABILITY_LABEL: Record<MediaCapability, string> = {
  text2image: '文生图',
  image2image: '图生图',
  text2video: '文生视频',
  image2video: '图生视频',
  firstlast2video: '首尾帧视频',
}

/** 能力 → 产物扩展名（用户未指定模型时决定存放格式） */
export function outputExtFor(capability: MediaCapability): string {
  return capability.endsWith('image') ? 'png' : 'mp4'
}
