/**
 * M57 P3：模型直连（BYOK）——用户在自己的账号下配置 LLM API Key。
 * - 配置后：本人会话的全部模型调用走用户凭据（baseUrl / model 可分别覆盖，留空 = 跟随系统默认）；
 * - 密钥加密落库、永不回显；「恢复系统默认」一键清除；
 * - 成本仍按用户归因（usage.model 记录实际生效模型）。
 */
import * as React from 'react'
import type { LlmCredentialStatus } from '@multi-agent/shared'
import { KeyRound, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPut } from '../../lib/api'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'

export function ByokCard(): React.JSX.Element {
  const [status, setStatus] = React.useState<LlmCredentialStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  /** 未配置时默认展开表单；已配置时默认收起（展示状态 + 更新按钮） */
  const [formOpen, setFormOpen] = React.useState(false)
  const [apiKey, setApiKey] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')

  const apply = (next: LlmCredentialStatus): void => {
    setStatus(next)
    setFormOpen(!next.configured)
  }

  React.useEffect(() => {
    void (async () => {
      try {
        const res = await apiGet<{ status: LlmCredentialStatus }>('/api/auth/llm-credentials')
        apply(res.status)
      } catch {
        // 静默（设置页主体不受影响）
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const openUpdate = (): void => {
    setBaseUrl(status?.baseUrl ?? '')
    setModel(status?.model ?? '')
    setApiKey('')
    setFormOpen(true)
  }

  const save = async (): Promise<void> => {
    if (apiKey.trim().length < 8) {
      toast.error('API Key 至少 8 位')
      return
    }
    if (baseUrl.trim() && !/^https?:\/\//i.test(baseUrl.trim())) {
      toast.error('接入地址需为 http(s) 开头的合法 URL（留空 = 跟随系统默认）')
      return
    }
    setBusy(true)
    try {
      const res = await apiPut<{ status: LlmCredentialStatus }>('/api/auth/llm-credentials', {
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      })
      apply(res.status)
      setApiKey('')
      toast.success('已保存：你发起的会话将使用该凭据调用模型')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await apiDelete<{ status: LlmCredentialStatus }>('/api/auth/llm-credentials')
      apply(res.status)
      toast('已恢复系统默认模型与 Key')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'mt-1 block w-full rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] focus:border-primary/40 focus:outline-none'

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 pb-1">
        <KeyRound className="size-4 text-muted-foreground" />
        <CardTitle className="text-[13px]">模型直连（BYOK）</CardTitle>
        {status?.configured ? (
          <span className="rounded-full border border-emerald-500/30 bg-emerald-50 px-1.5 py-px text-[10.5px] text-emerald-700">
            已配置（自定义 Key）
          </span>
        ) : (
          <span className="rounded-full border px-1.5 py-px text-[10.5px] text-muted-foreground">使用系统默认</span>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载中…
          </div>
        ) : (
          <>
            <p className="text-[11.5px] leading-5 text-muted-foreground">
              配置后你发起的会话（含压缩摘要 / 记忆沉淀 / 脑图）全部走你的 Key；密钥加密存储、永不回显；用量与成本仍归因到你名下。
            </p>
            {status?.configured && !formOpen && (
              <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2 text-[12px]">
                <span>
                  接入地址：<span className="font-medium">{status.baseUrl ?? '跟随系统默认'}</span>
                </span>
                <span>
                  模型：<span className="font-medium">{status.model ?? '跟随系统默认'}</span>
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  <Button variant="outline" size="sm" className="h-7 text-[12px]" disabled={busy} onClick={openUpdate}>
                    更新凭据
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-[12px] text-muted-foreground" disabled={busy} onClick={() => void reset()}>
                    <RotateCcw className="size-3.5" />
                    恢复系统默认
                  </Button>
                </span>
              </div>
            )}
            {formOpen && (
              <div className="space-y-2.5 rounded-lg border p-3">
                <label className="block">
                  <span className="text-[12px] font-medium">API Key（必填）</span>
                  <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" className={inputClass} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[12px] font-medium">接入地址（可选）</span>
                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className={inputClass} />
                  </label>
                  <label className="block">
                    <span className="text-[12px] font-medium">模型（可选）</span>
                    <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 deepseek-chat" className={inputClass} />
                  </label>
                </div>
                <div className="flex items-center justify-end gap-2">
                  {status?.configured && (
                    <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>
                      取消
                    </Button>
                  )}
                  <Button size="sm" disabled={busy} onClick={() => void save()}>
                    {busy && <Loader2 className="size-3.5 animate-spin" />}
                    保存凭据
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
