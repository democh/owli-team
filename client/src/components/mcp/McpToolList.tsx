/**
 * M27：MCP 工具清单（展开视图）——注册名 / 原始名 / 只读标记 / 加载方式（M28 常驻·按需）/ 描述 / 角色可达性。
 * 数据源：GET /api/mcp/tools 的授权矩阵（usedByAgents 精确或通配命中；reachable 含无白名单角色）。
 */
import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { McpToolDirectoryEntry } from '@multi-agent/shared'
import { Badge } from '../ui/badge'

export function McpToolList({
  tools,
  agentNames,
}: {
  tools: McpToolDirectoryEntry[]
  /** agentId → 显示名（可达性徽章文案） */
  agentNames: Map<string, string>
}): React.JSX.Element {
  if (tools.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-center text-[11.5px] text-muted-foreground">
        暂无工具快照：连接成功后自动同步。
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full table-fixed border-collapse text-[11.5px]">
        <thead>
          <tr className="border-b bg-muted/30 text-left text-[10.5px] text-muted-foreground">
            <th className="px-2.5 py-1.5 font-medium">注册名（registeredName）</th>
            <th className="w-40 px-2.5 py-1.5 font-medium">原始名（rawName）</th>
            <th className="w-16 px-2.5 py-1.5 font-medium">类型</th>
            <th className="w-16 px-2.5 py-1.5 font-medium">加载</th>
            <th className="w-[26%] px-2.5 py-1.5 font-medium">角色可达性</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.registeredName} className="border-b last:border-b-0 align-top">
              <td className="px-2.5 py-1.5">
                <div className="break-all font-mono text-[11px]">{tool.registeredName}</div>
                {tool.description && (
                  <div className="mt-0.5 line-clamp-2 text-[10.5px] text-muted-foreground">{tool.description}</div>
                )}
              </td>
              <td className="px-2.5 py-1.5 font-mono text-[10.5px] text-muted-foreground">
                <span className="break-all">{tool.rawName}</span>
              </td>
              <td className="px-2.5 py-1.5">
                {tool.readOnly ? (
                  <Badge variant="outline" title="readOnlyHint=true（可并行 + 60s 缓存）">
                    只读
                  </Badge>
                ) : (
                  <Badge variant="warning" title="写类：串行执行；approvalPolicy=risky 时触发审批">
                    写
                  </Badge>
                )}
              </td>
              <td className="px-2.5 py-1.5">
                {tool.deferByDefault === false ? (
                  <Badge variant="secondary" title="常驻：直接进入模型工具清单（服务器开启「始终加载」）">
                    常驻
                  </Badge>
                ) : (
                  <Badge variant="outline" title="按需：模型先经 tool_search 检索激活后才可调用（本 Run 内持续可用）">
                    按需
                  </Badge>
                )}
              </td>
              <td className="px-2.5 py-1.5">
                {tool.reachable ? (
                  tool.usedByAgents.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {tool.usedByAgents.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[10.5px] text-primary"
                          title={`${id}（白名单精确或通配命中）`}
                        >
                          {agentNames.get(id) ?? id}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[10.5px] text-muted-foreground" title="有未声明工具白名单的角色 = 全部工具">
                      全部 Agent（无白名单角色）
                    </span>
                  )
                ) : (
                  <span
                    className="inline-flex items-center gap-1 text-[10.5px] text-amber-700"
                    title="所有 Agent 的白名单均未命中：需在 Agent 编辑器中加精确名或 mcp__<slug>__* 通配"
                  >
                    <AlertTriangle className="size-3" />
                    零角色可达
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
