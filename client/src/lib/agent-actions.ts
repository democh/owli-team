/**
 * 成员快捷动作（M21）：成员卡「拍一拍」与图谱档案面板共用。
 * 复用消息通道（与 Composer 发送同路径），由运行管线照常驱动。
 */
import { toast } from 'sonner'
import type { AgentDefinition } from '@multi-agent/shared'
import { useRunStore } from '../stores/run-store'

/** 拍一拍（复用消息通道触发回复；M77：可传成员展示名，点名具体分身） */
export async function patAgent(agent: AgentDefinition, label?: string): Promise<void> {
  try {
    await useRunStore.getState().send(`@${label ?? agent.name} 拍了拍你，继续加油！`)
  } catch (err) {
    toast.error((err as Error).message)
  }
}
