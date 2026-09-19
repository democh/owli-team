/**
 * Agent 名录页（#/agents，M16）：按场景陈列全部角色 —— 形象照 / 能力 / 技能 / 交接对象 / 灵魂变体对比。
 * 头部展示场景主题与推荐编制；灵魂徽标一屏对比各变体的 tagline 与 traits。
 */
import * as React from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import { useAgentStore } from '../stores/agent-store'
import { resolveIcon } from '../lib/avatar-icons'
import { AgentAvatar } from '../components/agents/AgentAvatar'
import { SoulBadge } from '../components/agents/SoulPicker'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'

export function AgentsDirectory(): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const groups = useAgentStore((s) => s.groups)
  const load = useAgentStore((s) => s.load)

  React.useEffect(() => {
    void load()
  }, [load])

  const byId = React.useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const sections = React.useMemo(() => {
    const out: Array<{ group?: AgentGroup; members: AgentDefinition[] }> = groups.map((g) => ({
      group: g,
      members: agents.filter((a) => a.group === g.id),
    }))
    const known = new Set(groups.map((g) => g.id))
    const rest = agents.filter((a) => !known.has(a.group))
    if (rest.length > 0) out.push({ members: rest })
    return out
  }, [agents, groups])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b bg-card px-4">
        <Button variant="ghost" size="sm" asChild>
          <a href="#">
            <ArrowLeft className="size-4" />
            返回工作台
          </a>
        </Button>
        <span className="text-[13.5px] font-bold">Agent 名录</span>
        <span className="text-[11.5px] text-muted-foreground">
          {groups.length} 个场景 · {agents.length} 位角色 · 灵魂变体对比
        </span>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-5">
        {sections.map(({ group, members }) => {
          const GroupIcon = resolveIcon(group?.icon)
          return (
            <section key={group?.id ?? 'other'}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {group ? (
                  <>
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `${group.theme[0]}1f`, color: group.theme[0] }}
                    >
                      <GroupIcon className="size-4" />
                    </span>
                    <span className="text-[15px] font-bold">{group.name}</span>
                    {group.parallel && <Badge variant="secondary">∥ 并行协作</Badge>}
                    <span className="text-[11.5px] text-muted-foreground">{group.objective}</span>
                  </>
                ) : (
                  <span className="text-[15px] font-bold">其他</span>
                )}
                <span className="ml-auto text-[11.5px] text-muted-foreground">{members.length} 位</span>
              </div>

              {group && (
                <div className="mb-3 rounded-lg border bg-card/60 px-3 py-2 text-[11.5px] text-muted-foreground">
                  {group.description}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    推荐编制：
                    {group.chain.map((id, i) => (
                      <React.Fragment key={id}>
                        {i > 0 && <ArrowRight className="size-3 text-muted-foreground/50" />}
                        <span className="text-foreground/80">{byId.get(id)?.name ?? id}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                {members.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-xl border bg-card p-4 shadow-soft transition-shadow hover:shadow-md"
                    style={group ? { borderTopColor: group.theme[0], borderTopWidth: 2 } : undefined}
                  >
                    <div className="flex items-start gap-3">
                      <AgentAvatar agent={a} size={64} animated={false} className="rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[14px] font-semibold">{a.name}</span>
                          <Badge variant="secondary">{a.role}</Badge>
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-muted-foreground">{a.title}</div>
                        <p className="mt-1.5 line-clamp-3 text-[12px] leading-5 text-muted-foreground">{a.description}</p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1">
                      {a.capabilities.map((c) => (
                        <span key={c} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                          {c}
                        </span>
                      ))}
                      {(a.skills ?? []).map((sk) => (
                        <span key={sk} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10.5px] text-violet-700">
                          技能 · {sk}
                        </span>
                      ))}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="shrink-0">交棒给</span>
                      {a.handoff.length > 0 ? (
                        a.handoff.map((id) => (
                          <span key={id} className="rounded-full bg-muted/70 px-1.5 py-0.5">
                            {byId.get(id)?.name ?? id}
                          </span>
                        ))
                      ) : (
                        <span>—</span>
                      )}
                    </div>

                    <div className="mt-3 border-t pt-2">
                      <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                        灵魂变体
                      </div>
                      {(a.souls?.length ?? 0) === 0 ? (
                        <span className="text-[11px] text-muted-foreground/80">未配置（灵魂非必配，行为同现状）</span>
                      ) : (
                        <div className="space-y-1.5">
                          {a.souls!.map((s) => (
                            <div key={s.id} className="flex items-start gap-2">
                              <SoulBadge soul={s} className="shrink-0" />
                              <div className="min-w-0 flex-1">
                                <span className="text-[11px] text-foreground/80">{s.tagline}</span>
                                {s.id === a.defaultSoul && (
                                  <span className="ml-1.5 rounded bg-violet-500/15 px-1 text-[9.5px] text-violet-700">默认</span>
                                )}
                                <div className="mt-0.5 flex flex-wrap gap-1">
                                  {s.traits.map((t) => (
                                    <span key={t} className="rounded bg-muted/70 px-1 py-0.5 text-[10px] text-muted-foreground">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        })}

        {agents.length === 0 && (
          <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] text-muted-foreground">
            正在加载角色定义…
          </div>
        )}
      </main>
    </div>
  )
}
