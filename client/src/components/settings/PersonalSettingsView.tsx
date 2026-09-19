/**
 * M57：个人设置视图（成员）——系统设置由管理员统一管理（成员不可见）；
 * 此处仅提供个人偏好（通知轮询间隔）与账号操作入口（修改密码 / 退出登录）。
 */
import * as React from 'react'
import { Gauge, Loader2, Save, Settings2, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import type { UsageSummary } from '@multi-agent/shared'
import { apiGet, apiPut } from '../../lib/api'
import { useAuthStore } from '../../stores/auth-store'
import { AccountDialog } from '../account/AccountDialog'
import { ByokCard } from './ByokCard'
import { PersonalConnectionsCard } from './PersonalConnectionsCard'
import { PersonalMcpCard } from './PersonalMcpCard'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Input } from '../ui/input'
import { FieldRow } from '../console/fields'

interface PreferencesResponse {
  preferences: { notifyPollMs?: number }
}

export function PersonalSettingsView(): React.JSX.Element {
  const user = useAuthStore((s) => s.user)
  // M57 P3：个人连接卡仅多用户模式展示（兼容模式走连接管理中心）
  const multiUser = useAuthStore((s) => s.status.multiUser)
  const [accountOpen, setAccountOpen] = React.useState(false)
  const [notifyPollMs, setNotifyPollMs] = React.useState<string>('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  // M57 P3：我的用量（多用户模式；兼容模式响应 userId 为空 → 隐藏）
  const [usage, setUsage] = React.useState<UsageSummary | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        const res = await apiGet<PreferencesResponse>('/api/auth/preferences')
        setNotifyPollMs(res.preferences.notifyPollMs ? String(res.preferences.notifyPollMs) : '')
      } catch {
        // 读取失败按空处理（保存时可重试）
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // M57 P3：用量卡（失败静默——不影响设置页主体）
  React.useEffect(() => {
    void (async () => {
      try {
        const res = await apiGet<{ summary: UsageSummary }>('/api/usage/me')
        if (res.summary.userId) setUsage(res.summary)
      } catch {
        // 静默
      }
    })()
  }, [])

  const save = async (): Promise<void> => {
    const parsed = notifyPollMs.trim() ? Number(notifyPollMs) : undefined
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 500 || parsed > 60_000)) {
      toast.error('通知轮询间隔需为 500–60000 毫秒（留空 = 跟随服务端默认）')
      return
    }
    setSaving(true)
    try {
      await apiPut('/api/auth/preferences', parsed === undefined ? {} : { notifyPollMs: parsed })
      toast.success('个人偏好已保存')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Settings2 className="size-4 text-primary" />
        <h1 className="text-[13px] font-semibold">设置</h1>
        <span className="text-[11.5px] text-muted-foreground">个人偏好与账号；系统级配置由管理员统一管理</span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <Card>
          <CardHeader className="flex-row items-center gap-2 pb-1">
            <UserRound className="size-4 text-muted-foreground" />
            <CardTitle className="text-[13px]">我的账号</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-[12px]">
              <span className="font-medium">{user?.displayName ?? '—'}</span>
              <span className="ml-2 text-[11.5px] text-muted-foreground">
                {user?.username ? `用户名：${user.username}` : ''}
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setAccountOpen(true)}>
              修改密码 / 退出登录
            </Button>
          </CardContent>
        </Card>

        {/* M57 P3：我的用量（今日 token / 本月成本 / 会话 / 存储 + 生效限额） */}
        {usage && (
          <Card>
            <CardHeader className="flex-row items-center gap-2 pb-1">
              <Gauge className="size-4 text-muted-foreground" />
              <CardTitle className="text-[13px]">我的用量</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <span>
                  今日 token：
                  <span className="font-medium">{usage.todayTokens.toLocaleString()}</span>
                  {usage.limits.dailyTokens !== undefined && (
                    <span className="text-muted-foreground"> / {usage.limits.dailyTokens.toLocaleString()}</span>
                  )}
                </span>
                <span>
                  本月成本：<span className="font-medium">${usage.monthCostUsd.toFixed(2)}</span>
                  {usage.limits.monthlyCostUsd !== undefined && (
                    <span className="text-muted-foreground"> / ${usage.limits.monthlyCostUsd.toFixed(2)}</span>
                  )}
                </span>
                <span>
                  会话数：<span className="font-medium">{usage.sessions}</span>
                  {usage.limits.maxSessions !== undefined && (
                    <span className="text-muted-foreground"> / {usage.limits.maxSessions}</span>
                  )}
                </span>
                <span>
                  存储：<span className="font-medium">{usage.storageMb} MB</span>
                  {usage.limits.maxStorageMb !== undefined && (
                    <span className="text-muted-foreground"> / {usage.limits.maxStorageMb} MB</span>
                  )}
                </span>
              </div>
              {usage.limits.maxConcurrentRuns !== undefined && (
                <p className="text-[11px] text-muted-foreground">同时进行任务上限：{usage.limits.maxConcurrentRuns} 个</p>
              )}
              {Object.values(usage.limits).every((v) => v === undefined) && (
                <p className="text-[11px] text-muted-foreground">当前未设置配额上限（不限）。</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* M57 P3：个人连接（成员自建；仅本人可见可用） */}
        {multiUser && <PersonalConnectionsCard />}

        {/* M57 P3：个人 MCP（成员自建 stdio / http 服务器；属主会话自动授予） */}
        {multiUser && <PersonalMcpCard />}

        {/* M57 P3：模型直连（BYOK；仅多用户模式） */}
        {multiUser && <ByokCard />}

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">通知偏好</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                加载中…
              </div>
            ) : (
              <>
                <FieldRow label="降级轮询间隔（毫秒）" hint="WebSocket 不可用时的兜底轮询；留空 = 跟随服务端默认（NOTIFY_POLL_MS）">
                  <Input
                    type="number"
                    min={500}
                    max={60_000}
                    step={500}
                    value={notifyPollMs}
                    placeholder="如 5000"
                    onChange={(e) => setNotifyPollMs(e.target.value)}
                  />
                </FieldRow>
                <Button size="sm" disabled={saving} onClick={() => void save()}>
                  {saving ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Save className="mr-1 size-3.5" />}
                  保存
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          模型 / 工具 / 审批 / 记忆等系统级设置由管理员在管理控制台统一维护；如有需要请联系管理员。
        </p>
      </div>

      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
    </div>
  )
}
