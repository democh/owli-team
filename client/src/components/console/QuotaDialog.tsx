/**
 * M57 P3：用户配额编辑弹窗（admin）。
 * - 展示该用户用量汇总（今日 token / 本月成本 / 会话数 / 存储）；
 * - 五项配额编辑（留空 = 不限；保存时以「空 → null 清除」提交）；
 * - 契约见 docs/api.md：GET/PUT /api/users/:id/quota + GET /api/users/:id/usage。
 */
import * as React from 'react'
import type { QuotaLimits, UsageSummary } from '@multi-agent/shared'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiGet, apiPut } from '../../lib/api'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

export interface QuotaDialogProps {
  userId: string
  displayName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

type FieldKey = 'maxConcurrentRuns' | 'dailyTokens' | 'monthlyCostUsd' | 'maxSessions' | 'maxStorageMb'

const FIELDS: Array<{ key: FieldKey; label: string; hint: string; placeholder: string }> = [
  { key: 'maxConcurrentRuns', label: '并发任务上限', hint: '同时进行中的任务数（留空 = 回退系统默认）', placeholder: '如 2' },
  { key: 'dailyTokens', label: '日 token 配额', hint: '每日 prompt + completion 合计（留空 = 不限）', placeholder: '如 2000000' },
  { key: 'monthlyCostUsd', label: '月成本配额（$）', hint: '每月估算成本上限（留空 = 不限）', placeholder: '如 20' },
  { key: 'maxSessions', label: '会话数上限', hint: '可保留的会话总数（留空 = 不限）', placeholder: '如 30' },
  { key: 'maxStorageMb', label: '存储上限（MB）', hint: '工作区文件总体积（留空 = 不限）', placeholder: '如 2048' },
]

const toInput = (value?: number): string => (value === undefined ? '' : String(value))

export function QuotaDialog({ userId, displayName, open, onOpenChange }: QuotaDialogProps): React.JSX.Element {
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [summary, setSummary] = React.useState<UsageSummary | null>(null)
  const [draft, setDraft] = React.useState<Record<FieldKey, string>>({
    maxConcurrentRuns: '',
    dailyTokens: '',
    monthlyCostUsd: '',
    maxSessions: '',
    maxStorageMb: '',
  })

  React.useEffect(() => {
    if (!open) return
    setLoading(true)
    void (async () => {
      try {
        const [quotaRes, usageRes] = await Promise.all([
          apiGet<{ quota: QuotaLimits }>(`/api/users/${userId}/quota`),
          apiGet<{ summary: UsageSummary }>(`/api/users/${userId}/usage`),
        ])
        setSummary(usageRes.summary)
        setDraft({
          maxConcurrentRuns: toInput(quotaRes.quota.maxConcurrentRuns),
          dailyTokens: toInput(quotaRes.quota.dailyTokens),
          monthlyCostUsd: toInput(quotaRes.quota.monthlyCostUsd),
          maxSessions: toInput(quotaRes.quota.maxSessions),
          maxStorageMb: toInput(quotaRes.quota.maxStorageMb),
        })
      } catch (err) {
        toast.error((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [open, userId])

  const parseField = (key: FieldKey): number | null | undefined => {
    const raw = draft[key].trim()
    if (!raw) return null // 留空 = 清除回不限
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) return undefined // 非法
    return value
  }

  const save = async (): Promise<void> => {
    const payload: Record<string, number | null> = {}
    for (const field of FIELDS) {
      const parsed = parseField(field.key)
      if (parsed === undefined) {
        toast.error(`${field.label}需为正数（或留空 = 不限）`)
        return
      }
      payload[field.key] = parsed
    }
    setSaving(true)
    try {
      await apiPut(`/api/users/${userId}/quota`, payload)
      toast.success(`已更新「${displayName}」的配额`)
      onOpenChange(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">配额与用量 · {displayName}</DialogTitle>
          <DialogDescription className="text-[12px]">留空 = 不限（保存时清除该项）；超限时任务 / 上传会被拒绝并给出提示。</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载中…
          </div>
        ) : (
          <div className="space-y-3">
            {summary && (
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/20 p-3 text-[12px]">
                <span>
                  今日 token：<span className="font-medium">{summary.todayTokens.toLocaleString()}</span>
                </span>
                <span>
                  本月成本：<span className="font-medium">${summary.monthCostUsd.toFixed(2)}</span>
                </span>
                <span>
                  会话数：<span className="font-medium">{summary.sessions}</span>
                </span>
                <span>
                  存储：<span className="font-medium">{summary.storageMb} MB</span>
                </span>
              </div>
            )}
            <div className="space-y-2.5">
              {FIELDS.map((field) => (
                <label key={field.key} className="block">
                  <span className="text-[12px] font-medium">{field.label}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground">{field.hint}</span>
                  <input
                    value={draft[field.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    inputMode="decimal"
                    className="mt-1 block w-full rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] focus:border-primary/40 focus:outline-none"
                  />
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                保存配额
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
