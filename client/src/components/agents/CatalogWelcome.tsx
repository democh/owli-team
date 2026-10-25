import type { JSX } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'

export function CatalogWelcome(): JSX.Element {
  const { groups, agents, presets, loaded, loading, error, reload } = useAgentStore()
  const requestCreate = useUiStore((s) => s.requestCreate)
  return <div className="w-full max-w-xl space-y-4 text-[13px]">
    <p className="text-muted-foreground">从一个任务开始：让助手独立完成，或邀请各有所长的团队一起协作。</p>
    {loaded && <nav aria-label="资产数量" className="flex flex-wrap justify-center gap-3"><a className="text-primary hover:underline" href="#/agents?tab=scene">{groups.length} 个场景</a><a className="text-primary hover:underline" href="#/agents?tab=agent">{agents.length} 个角色</a><a className="text-primary hover:underline" href="#/agents?tab=preset">{presets.length} 个预设</a></nav>}
    {loading && <p role="status">正在加载资产…</p>}
    {error && <p role="alert">资产加载失败 <Button variant="ghost" onClick={() => void reload()}>重试</Button></p>}
    <div className="flex flex-wrap justify-center gap-2"><Button disabled={!agents.some((a) => a.id === 'general')} onClick={() => requestCreate('scene', 'blank')}>通用助手</Button><Button variant="outline" onClick={() => requestCreate()}>自动组队</Button><Button variant="outline" asChild><a href="#/agents?tab=scene">浏览场景与预设</a></Button></div>
    <p className="text-muted-foreground">通用助手：一位成员独立完成。自动组队：先创建零成员会话，首条消息再选团队。</p>
  </div>
}
