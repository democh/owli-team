/**
 * 头像预览页（#/avatars，§19.5）：全部角色形象照 × 尺寸 × 状态角标 + 回退方案演示。
 */
import * as React from 'react'
import { ArrowLeft } from 'lucide-react'
import type { AgentRunState } from '@multi-agent/shared'
import { useAgentStore } from '../stores/agent-store'
import { AgentAvatar } from '../components/agents/AgentAvatar'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'

const STATES: AgentRunState[] = ['idle', 'thinking', 'done', 'error']
const STATE_LABEL: Record<AgentRunState, string> = {
  idle: '待命',
  speaking: '发言',
  thinking: '思考',
  done: '完成',
  error: '出错',
}

export function AvatarPreview(): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const load = useAgentStore((s) => s.load)

  React.useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b bg-card px-4">
        <Button variant="ghost" size="sm" asChild>
          <a href="#">
            <ArrowLeft className="size-4" />
            返回工作台
          </a>
        </Button>
        <span className="text-[13.5px] font-bold">头像预览</span>
        <span className="text-[11.5px] text-muted-foreground">
          AI 生图形象照 · 状态角标 · 渐变 + 图标回退
        </span>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-5">
        {agents.map((agent) => (
          <section key={agent.id} className="rounded-xl border bg-card p-4 shadow-soft transition-shadow hover:shadow-md">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <span className="text-[13.5px] font-semibold">{agent.name}</span>
              <Badge variant="secondary">{agent.role}</Badge>
              <Badge variant="outline">{agent.title}</Badge>
              <code className="text-[11px] text-muted-foreground">
                {agent.avatar.image ?? '（未配置 image，回退渐变）'}
              </code>
              {agent.avatar.gradient && (
                <span className="flex items-center gap-1">
                  {agent.avatar.gradient.map((c) => (
                    <span key={c} className="size-4 rounded border" style={{ backgroundColor: c }} title={c} />
                  ))}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-6">
              <div className="flex flex-col items-center gap-2">
                <AgentAvatar agent={agent} size={96} animated={false} />
                <span className="text-[11.5px] text-muted-foreground">96px 大图</span>
              </div>
              {STATES.map((state) => (
                <div key={state} className="flex flex-col items-center gap-2">
                  <AgentAvatar agent={agent} size={64} state={state} />
                  <span className="text-[11.5px] text-muted-foreground">{STATE_LABEL[state]}</span>
                </div>
              ))}
              <div className="flex flex-col items-center gap-2">
                <AgentAvatar agent={agent} size={38} animated={false} />
                <span className="text-[11.5px] text-muted-foreground">38px 列表</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <AgentAvatar
                  agent={{ ...agent, avatar: { ...agent.avatar, image: undefined } }}
                  size={38}
                  animated={false}
                />
                <span className="text-[11.5px] text-muted-foreground">回退（无图）</span>
              </div>
            </div>
          </section>
        ))}

        {agents.length === 0 && (
          <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] text-muted-foreground">
            正在加载角色定义…
          </div>
        )}
      </main>
    </div>
  )
}
