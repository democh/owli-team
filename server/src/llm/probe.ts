/**
 * 模型服务探活（连接「测试」按钮）：openai 协议 GET {baseUrl}/models。
 * 成功回报模型数量与前几个模型名；失败归一为可读错误（超时 / 状态码 / 网络）。
 */
export interface LlmProbeResult {
  ok: boolean
  latencyMs?: number
  detail?: string
  error?: string
}

export async function probeLlmProvider(opts: {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}): Promise<LlmProbeResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/models`
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
  try {
    const res = await fetch(url, {
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return { ok: false, latencyMs, error: `端点返回 ${res.status}（请检查接入地址与 API Key）` }
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const ids = Array.isArray(body?.data)
      ? body.data.map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
      : []
    return {
      ok: true,
      latencyMs,
      detail:
        ids.length > 0
          ? `${ids.length} 个模型：${ids.slice(0, 3).join('、')}${ids.length > 3 ? ' 等' : ''}`
          : '端点可用（未返回模型清单）',
    }
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'AbortError' ? '请求超时' : err.message) : String(err)
    return { ok: false, error: `连接失败：${message}` }
  } finally {
    clearTimeout(timer)
  }
}
