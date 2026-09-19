/**
 * 输入区（M8 增强）：
 * - Enter 发送 / Shift+Enter 换行 / @ 自动补全（成员 + 文件 + 技能，键盘导航）；
 * - `/` 斜杠命令：/stop /clear /context；
 * - 草稿持久化：按 sessionId 存 localStorage，切会话 / 刷新不丢；
 * - 上传：拖拽 / 粘贴 / 选择 → POST uploads → 插入 @file:path 引用（多模态引用走同一通道）；
 * - 引用插入：ui-store.composerInsert（消息菜单 / 交付件 / 任务 / ⌘K 共用）；
 * - 运行中发送显示「将插话」语义（服务端在回合边界消费，不新建 Run）；
 * - 底栏右侧常驻上下文电池格条（ContextBar：token / 预算分段水位，点击打开上下文抽屉）；
 * - 支持 IME 组合输入。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { CornerDownLeft, Loader2, Paperclip, Send, Square } from 'lucide-react'
import type { AgentDefinition, AgentRunState, Artifact, MessageAttachment, SkillMeta, TurnMode } from '@multi-agent/shared'
import { apiGet, apiUpload } from '../../lib/api'
import { memberViews } from '../../lib/members'
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  attachmentUrl,
  isAcceptedFile,
  probeImageMeta,
  probeVideoMeta,
  visualOfFile,
} from '../../lib/attachments'
import { useAgentStore } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'
import { AgentAvatar } from '../agents/AgentAvatar'
import { AttachmentLightbox, type LightboxItem } from './AttachmentLightbox'
import { AttachmentTray, type TrayItem } from './AttachmentTray'
import { ContextBar } from '../context/ContextBar'
import { cn } from '../../lib/utils'

interface MentionState {
  open: boolean
  query: string
  /** '@' 在 value 中的索引 */
  start: number
  index: number
}

const CLOSED: MentionState = { open: false, query: '', start: -1, index: 0 }

interface SlashCommand {
  cmd: string
  desc: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/stop', desc: '停止当前运行' },
  { cmd: '/clear', desc: '清空输入框' },
  { cmd: '/context', desc: '打开上下文抽屉' },
]

/**
 * M24：Composer 消息级范式选择（三态 chip，默认「执行」；不持久化）。
 * 仅对下一条消息生效，发送后自动复位；会话级持续规划走右栏任务视图的「规划先行」开关。
 * 「执行」= 不显式指定（尊重会话开关）；「规划 / 评审」随消息提交 mode。
 */
const MODE_CHIPS: Array<{ mode: TurnMode; label: string; title: string }> = [
  { mode: 'execute', label: '执行', title: '默认：不显式指定范式（尊重会话「规划先行」开关，否则正常执行）' },
  { mode: 'plan', label: '规划', title: '规划范式：首棒只读调研并提交计划，待你批准后执行（仅对下一条消息生效，发送后复位）' },
  { mode: 'review', label: '评审', title: '评审范式：成员输出结构化评审判定（仅对下一条消息生效，发送后复位）' },
]

/** 成员状态点（五态，与团队面板一致） */
const STATE_DOT: Record<AgentRunState, string> = {
  idle: 'bg-slate-300',
  speaking: 'bg-primary',
  thinking: 'bg-amber-400',
  done: 'bg-emerald-500',
  error: 'bg-destructive',
}

/** 候选标签内的匹配子串高亮 */
function HighlightMatch({ text, query }: { text: string; query: string }): React.JSX.Element {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-[3px] bg-primary/15 px-0 text-primary">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

/** 成员状态点（候选菜单右侧） */
function AgentStatusDot({ status }: { status: AgentRunState }): React.JSX.Element {
  const busy = status === 'speaking' || status === 'thinking'
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
      <span className={cn('size-1.5 rounded-full', STATE_DOT[status], busy && 'animate-pulse')} />
      {busy ? (status === 'speaking' ? '发言中' : '思考中') : ''}
    </span>
  )
}

type CandidateKind = 'agent' | 'file' | 'skill'

interface Candidate {
  kind: CandidateKind
  key: string
  label: string
  hint: string
  agent?: AgentDefinition
  /** M77：自定义插入文本（「全部 N 位」全伞条目 = 逐一点名多 token；缺省 = `@标签 `） */
  insertText?: string
}

/** 从光标处回扫，探测未闭合的 @token（M77：字符集含 `·` 与 `~`——实例标签与分身机器键可连续输入） */
function detectMention(value: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1
  while (i >= 0 && /[\p{L}\p{N}_·~]/u.test(value[i])) i--
  if (i < 0 || value[i] !== '@') return null
  // '@' 前必须是行首或空白（避免邮箱等误触发）
  if (i > 0 && !/[\s(（[【"']/.test(value[i - 1])) return null
  return { start: i, query: value.slice(i + 1, caret) }
}

/** 探测行首斜杠命令（未输入空格前的 token） */
function detectSlash(value: string): { query: string } | null {
  if (!value.startsWith('/')) return null
  if (/[\s\n]/.test(value)) return null
  return { query: value.toLowerCase() }
}

function draftKey(sessionId?: string): string | undefined {
  return sessionId ? `ma:draft:${sessionId}` : undefined
}

export interface ComposerProps {
  /** ChatArea 注入快捷插入能力（空状态提示 chips） */
  onReady?: (insert: (text: string) => void) => void
  /** M57 P2：只读共享（viewer）→ 输入锁定（仅观阅，服务端另有写闸门兜底） */
  locked?: boolean
  /** 锁定提示（缺省文案见 placeholder） */
  lockedHint?: string
}

export function Composer({ onReady, locked = false, lockedHint }: ComposerProps): React.JSX.Element {
  const [value, setValue] = React.useState('')
  const [mention, setMention] = React.useState<MentionState>(CLOSED)
  const [slashIndex, setSlashIndex] = React.useState(0)
  const [sending, setSending] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  /** M33：附件托盘（待发附件；上传中 / 完成 / 失败三态） */
  const [tray, setTray] = React.useState<TrayItem[]>([])
  const [lightbox, setLightbox] = React.useState<{ items: LightboxItem[]; index: number } | null>(null)
  /** M24：消息级范式（仅对下一条消息生效；发送 / 切会话后复位为「执行」） */
  const [mode, setMode] = React.useState<TurnMode>('execute')
  const [files, setFiles] = React.useState<Artifact[] | null>(null)
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const caretRef = React.useRef<number | null>(null)

  const agents = useAgentStore((s) => s.agents)
  const skills = useAgentStore((s) => s.skills)
  const statuses = useAgentStore((s) => s.statuses)
  const groups = useAgentStore((s) => s.groups)
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  const active = useRunStore((s) => s.active)
  const queued = useRunStore((s) => s.queued)
  const queue = useRunStore((s) => s.queue)
  const composerInsert = useUiStore((s) => s.composerInsert)

  const session = sessions.find((s) => s.id === currentId)
  // M33：上传进行中（托盘三态派生；用于按钮 spinner / 发送拦截）
  const uploading = tray.some((t) => t.status === 'uploading')
  const trayRef = React.useRef<TrayItem[]>([])
  React.useEffect(() => {
    trayRef.current = tray
  }, [tray])
  /** M33：在途上传的中止控制器（移除附件 / 切会话 / 卸载时中止，避免幽灵上传与泄漏） */
  const uploadAbortsRef = React.useRef(new Map<string, AbortController>())
  // M33：卸载兜底——中止在途上传并释放本地预览 object URL
  React.useEffect(
    () => () => {
      uploadAbortsRef.current.forEach((c) => c.abort())
      uploadAbortsRef.current.clear()
      trayRef.current.forEach((t) => t.localUrl && URL.revokeObjectURL(t.localUrl))
    },
    [],
  )
  // M77：在场成员实例（同角多魂 = 各自一条召唤条目 / 一个候选；@ 插入「名字·灵魂名」点名具体分身）
  const poolMembers = React.useMemo(() => memberViews(agents, session), [agents, session])
  /** 召唤条条目（空会话回退全量角色） */
  const stripItems = React.useMemo(
    () =>
      poolMembers.length > 0
        ? poolMembers.map((m) => ({ key: m.key, label: m.label, agent: m.agent }))
        : agents.map((a) => ({ key: a.id, label: a.name, agent: a })),
    [poolMembers, agents],
  )

  // 成员条统一常驻（ADR 0135，修订 M52-G）：输入条成员条是 Composer 的常驻主入口，全场景一致展示——
  // 席位（arena / roundtable）负责「谁在哪个席」的结构可视化且随消息滚动区离场，成员条承载常驻
  // 快捷召唤与实时状态（@ / 发言与等待状态点 / 排队序号 / 新成员高亮），不再按场景让位。

  // M16：指挥台按场景分组排序（groups 顺序，组内保持编制顺序），组间以组色圆点分隔
  const poolSorted = React.useMemo(() => {
    if (groups.length === 0) return stripItems
    const rank = new Map(groups.map((g, i) => [g.id, i]))
    return [...stripItems].sort((x, y) => (rank.get(x.agent.group) ?? 99) - (rank.get(y.agent.group) ?? 99))
  }, [stripItems, groups])

  // M16：新加入成员短暂高亮（participantIds diff；安静模式/reduced-motion 由 CSS 关闭动画）
  const [freshIds, setFreshIds] = React.useState<Set<string>>(new Set())
  const participantKey = session?.participantIds.join(',') ?? ''
  const prevIdsRef = React.useRef<string[]>([])
  React.useEffect(() => {
    const ids = participantKey ? participantKey.split(',') : []
    const prev = prevIdsRef.current
    prevIdsRef.current = ids
    if (prev.length === 0) return
    const added = ids.filter((id) => !prev.includes(id))
    if (added.length === 0) return
    setFreshIds(new Set(added))
    const t = setTimeout(() => setFreshIds(new Set()), 2600)
    return () => clearTimeout(t)
  }, [participantKey])

  const slashQuery = detectSlash(value)
  const slashMatches = React.useMemo(() => {
    if (!slashQuery) return []
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(slashQuery.query))
  }, [slashQuery])

  const candidates = React.useMemo<Candidate[]>(() => {
    if (!mention.open) return []
    const q = mention.query.toLowerCase()
    const people: Candidate[] = []
    // M77：多实例角色加「全部 N 位」显式全伞条目（裸名只召集主实例；全伞 = 逐一点名一键插入）
    const byAgent = new Map<string, typeof poolSorted>()
    for (const x of poolSorted) {
      const list = byAgent.get(x.agent.id) ?? []
      list.push(x)
      byAgent.set(x.agent.id, list)
    }
    for (const [agentId, list] of byAgent) {
      const hits = list.filter(
        (x) =>
          x.label.toLowerCase().includes(q) ||
          x.agent.name.toLowerCase().includes(q) ||
          x.key.toLowerCase().includes(q),
      )
      if (hits.length === 0) continue
      if (list.length >= 2) {
        people.push({
          kind: 'agent',
          key: `a:all:${agentId}`,
          label: `${list[0]!.agent.name}（全部 ${list.length} 位）`,
          hint: '同角多魂 · 一次召集全部实例',
          agent: list[0]!.agent,
          insertText: `${list.map((x) => `@${x.label}`).join(' ')} `,
        })
      }
      for (const x of hits) {
        people.push({ kind: 'agent', key: `a:${x.key}`, label: x.label, hint: x.agent.role, agent: x.agent })
      }
    }
    // 文件 / 技能候选仅在输入了查询词时展示（避免默认菜单过噪）
    const fileHits: Candidate[] =
      q.length > 0
        ? (files ?? [])
            .filter((f) => f.path.toLowerCase().includes(q))
            .slice(0, 8)
            .map((f) => ({ kind: 'file', key: `f:${f.path}`, label: f.path.split('/').pop() ?? f.path, hint: f.path }))
        : []
    const skillHits: Candidate[] =
      q.length > 0
        ? skills
            .filter((s: SkillMeta) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
            .slice(0, 5)
            .map((s) => ({ kind: 'skill', key: `s:${s.name}`, label: s.name, hint: s.description }))
        : []
    return [...people, ...fileHits, ...skillHits]
  }, [mention.open, mention.query, poolSorted, files, skills])

  // 提及菜单打开时拉取文件候选（30s 内复用缓存）
  const filesFetchedAtRef = React.useRef(0)
  React.useEffect(() => {
    if (!mention.open || !currentId) return
    if (files !== null && Date.now() - filesFetchedAtRef.current < 30_000) return
    let alive = true
    void apiGet<{ artifacts: Artifact[] }>(`/api/sessions/${currentId}/artifacts`)
      .then((res) => {
        if (!alive) return
        filesFetchedAtRef.current = Date.now()
        setFiles(res.artifacts)
      })
      .catch(() => {
        if (!alive) return
        // 失败也记时间戳：否则 files 依赖会触发无限重试（测试环境无 mock 网络）
        filesFetchedAtRef.current = Date.now()
        setFiles([])
      })
    return () => {
      alive = false
    }
  }, [mention.open, currentId, files])

  // 草稿：切会话时恢复 / 清空（M24：范式选择不持久化，同复位；M33：待发附件与预览同清、在途上传中止）
  React.useEffect(() => {
    const key = draftKey(currentId)
    setValue(key ? (localStorage.getItem(key) ?? '') : '')
    setMention(CLOSED)
    setMode('execute')
    uploadAbortsRef.current.forEach((c) => c.abort())
    uploadAbortsRef.current.clear()
    setTray((ts) => {
      ts.forEach((t) => t.localUrl && URL.revokeObjectURL(t.localUrl))
      return []
    })
    setLightbox(null)
  }, [currentId])

  // 草稿：值变化即落盘
  React.useEffect(() => {
    const key = draftKey(currentId)
    if (!key) return
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }, [value, currentId])

  // M8：引用插入（消息菜单 / 交付件 / 任务 / 命令面板）
  React.useEffect(() => {
    if (!composerInsert) return
    setValue((v) => (v ? `${v}\n${composerInsert.text}` : composerInsert.text))
    useUiStore.getState().consumeComposerInsert()
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }, [composerInsert])

  // 恢复光标位置（插入 chip 后）
  React.useEffect(() => {
    if (caretRef.current !== null && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(caretRef.current, caretRef.current)
      caretRef.current = null
    }
  }, [value])

  // 自适应高度
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])

  const insert = React.useCallback((text: string) => {
    setValue((v) => (v ? `${v} ${text}` : text))
    caretRef.current = Number.MAX_SAFE_INTEGER
  }, [])

  React.useEffect(() => {
    onReady?.(insert)
  }, [onReady, insert])

  const applyValue = (next: string, caret: number): void => {
    setValue(next)
    caretRef.current = caret
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value
    const caret = e.target.selectionStart ?? next.length
    setValue(next)
    setSlashIndex(0)
    const probe = detectMention(next, caret)
    if (probe) {
      setMention({ open: true, query: probe.query, start: probe.start, index: 0 })
    } else if (mention.open) {
      setMention(CLOSED)
    }
  }

  const selectCandidate = (candidate: Candidate | undefined): void => {
    if (!candidate) return
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, mention.start)
    const after = value.slice(caret)
    const inserted =
      candidate.insertText !== undefined
        ? candidate.insertText
        : candidate.kind === 'agent'
          ? `@${candidate.label} `
          : candidate.kind === 'file'
            ? `@file:${candidate.hint} `
            : `@skill:${candidate.label} `
    const next = before + inserted + after
    applyValue(next, before.length + inserted.length)
    setMention(CLOSED)
  }

  const closeMention = (): void => setMention(CLOSED)

  /** 执行斜杠命令（选中或直接回车匹配时） */
  const runCommand = async (cmd: string): Promise<void> => {
    setValue('')
    if (cmd === '/stop') {
      if (!active) {
        toast('当前没有运行中的协作')
        return
      }
      await useRunStore.getState().stop()
    } else if (cmd === '/context') {
      useUiStore.getState().setContextOpen(true)
    }
    // /clear 仅清空输入（setValue('') 已覆盖）
  }

  /** M33：单个附件上传（本地已入托盘；成功→done 带 attachment，失败→error；可被移除 / 切会话 / 卸载中止） */
  const uploadOne = async (sessionId: string, item: TrayItem, file: File): Promise<void> => {
    const controller = new AbortController()
    uploadAbortsRef.current.set(item.id, controller)
    try {
      // 视频时长 / 分辨率与图片尺寸先行本地探测（失败静默；服务端图片尺寸为准）
      let meta: { durationMs?: number; width?: number; height?: number } = {}
      if (item.visual === 'video') meta = (await probeVideoMeta(file)) ?? {}
      else if (item.visual === 'image') meta = (await probeImageMeta(file)) ?? {}
      const res = await apiUpload<{ attachment: MessageAttachment }>(
        `/api/sessions/${sessionId}/attachments`,
        file,
        { 'x-file-name': encodeURIComponent(file.name || 'file'), 'x-file-metadata': JSON.stringify(meta) },
        (ratio) => setTray((ts) => ts.map((t) => (t.id === item.id ? { ...t, progress: ratio } : t))),
        controller.signal,
      )
      uploadAbortsRef.current.delete(item.id)
      setTray((ts) =>
        ts.map((t) =>
          t.id === item.id
            ? {
                ...t,
                status: 'done',
                progress: 1,
                attachment: res.attachment,
                width: res.attachment.width ?? meta.width,
                height: res.attachment.height ?? meta.height,
                durationMs: res.attachment.durationMs ?? meta.durationMs,
              }
            : t,
        ),
      )
      // uploads/ 下新文件进入交付件列表（artifacts 面板 / @file 候选可见）
      useSessionStore.getState().bumpArtifacts()
    } catch (err) {
      uploadAbortsRef.current.delete(item.id)
      // 主动取消（移除附件 / 切会话 / 卸载）：静默——托盘条目已清或会话已切走
      if (controller.signal.aborted) return
      setTray((ts) => ts.map((t) => (t.id === item.id ? { ...t, status: 'error', error: (err as Error).message } : t)))
    }
  }

  /** M33：选择 / 拖拽 / 粘贴 → 进入附件托盘并即时上传（不再插入 @file 文本） */
  const attachFiles = (list: File[]): void => {
    if (!currentId || list.length === 0) return
    // 先过滤非法（不占用配额，避免非法文件吞掉名额），再按剩余名额截断并明确提示
    const valid = list.filter((file) => {
      if (!isAcceptedFile(file.name)) {
        toast.error(`不支持的格式：${file.name}`)
        return false
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        toast.error(`${file.name} 超过 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB 上限`)
        return false
      }
      return true
    })
    if (valid.length === 0) return
    const room = ATTACHMENT_MAX_COUNT - trayRef.current.length
    if (room <= 0) {
      toast.error(`单条消息最多 ${ATTACHMENT_MAX_COUNT} 个附件`)
      return
    }
    const accepted = valid.slice(0, room)
    if (accepted.length < valid.length) {
      toast.error(`单条消息最多 ${ATTACHMENT_MAX_COUNT} 个附件，已忽略 ${valid.length - accepted.length} 个`)
    }
    const picked: Array<{ item: TrayItem; file: File }> = accepted.map((file) => {
      const visual = visualOfFile(file.name, file.type)
      return {
        item: {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || 'file',
          size: file.size,
          mime: file.type || '',
          visual,
          status: 'uploading',
          progress: 0,
          localUrl: visual === 'image' || visual === 'video' ? URL.createObjectURL(file) : undefined,
        },
        file,
      }
    })
    setTray((ts) => [...ts, ...picked.map((p) => p.item)])
    for (const { item, file } of picked) void uploadOne(currentId, item, file)
  }

  const removeTrayItem = (id: string): void => {
    // 在途上传随移除中止（否则请求继续落盘，产生托盘不可见的幽灵附件）
    uploadAbortsRef.current.get(id)?.abort()
    uploadAbortsRef.current.delete(id)
    setTray((ts) => {
      const target = ts.find((t) => t.id === id)
      if (target?.localUrl) URL.revokeObjectURL(target.localUrl)
      return ts.filter((t) => t.id !== id)
    })
  }

  const clearTray = (): void => {
    setTray((ts) => {
      ts.forEach((t) => t.localUrl && URL.revokeObjectURL(t.localUrl))
      return []
    })
    setLightbox(null)
  }

  /** 托盘图片 / 视频 → Lightbox（多张时左右切换） */
  const openTrayLightbox = (id: string): void => {
    if (!currentId) return
    const media = tray.filter((t) => t.visual === 'image' || t.visual === 'video')
    const items: LightboxItem[] = media
      .map((t) => ({
        url: t.localUrl ?? (t.attachment ? attachmentUrl(currentId, t.attachment.path) : ''),
        name: t.name,
        kind: (t.visual === 'video' ? 'video' : 'image') as 'image' | 'video',
      }))
      .filter((i) => i.url)
    const index = media.findIndex((t) => t.id === id)
    if (index < 0 || items.length === 0) return
    setLightbox({ items, index })
  }

  const submit = async (): Promise<void> => {
    const content = value.trim()
    if (sending) return
    // M33：附件上传中拦截（避免发送半成品附件）
    if (tray.some((t) => t.status === 'uploading')) {
      toast('附件上传中，请稍候')
      return
    }
    const ready = tray.filter((t) => t.status === 'done' && t.attachment)
    if (!content && ready.length === 0) return
    // 斜杠命令：整条消息恰为命令时直接执行
    if (SLASH_COMMANDS.some((c) => c.cmd === content)) {
      await runCommand(content)
      return
    }
    setSending(true)
    try {
      // M24：plan / review 随消息提交；「执行」不显式指定（服务端按「规划先行」→ execute 兑底）
      // M33：附件一并提交（图片走视觉通道，文档自动提取，视频带时长元数据）
      await useRunStore.getState().send(
        content,
        mode === 'execute' ? undefined : mode,
        ready.length > 0 ? ready.map((t) => t.attachment!) : undefined,
      )
      setValue('')
      clearTray()
      setMode('execute') // 仅对下一条消息生效：发送后自动复位
      const key = draftKey(currentId)
      if (key) localStorage.removeItem(key)
      setMention(CLOSED)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) return
    if (mention.open && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMention((m) => ({ ...m, index: (m.index + 1) % candidates.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMention((m) => ({ ...m, index: (m.index - 1 + candidates.length) % candidates.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectCandidate(candidates[mention.index])
        return
      }
    }
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        void runCommand(slashMatches[slashIndex].cmd)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setValue('')
        return
      }
    }
    if (e.key === 'Escape' && mention.open) {
      e.preventDefault()
      closeMention()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const disabled = !currentId || locked
  const insertHint = active ? '运行中发送将作为插话，在回合结束后生效' : null

  return (
    <div className="border-t bg-background/80 px-4 py-3 backdrop-blur">
      <div
        className={cn(
          'relative rounded-xl border bg-card shadow-soft transition-all focus-within:border-primary/40 focus-within:shadow-md focus-within:shadow-primary/10 focus-within:ring-[3px] focus-within:ring-primary/12',
          disabled && 'opacity-60',
          dragging && 'border-primary/60 ring-[3px] ring-primary/15',
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const dropped = [...e.dataTransfer.files]
          if (dropped.length > 0) attachFiles(dropped)
        }}
      >
        {slashMatches.length > 0 && (
          <div className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border bg-popover p-1 shadow-xl shadow-primary/10 animate-fade-in">
            <div className="px-2 py-1 text-[10.5px] uppercase tracking-wide text-muted-foreground">命令</div>
            {slashMatches.map((c, i) => (
              <button
                key={c.cmd}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
                  i === slashIndex ? 'bg-primary/10 text-primary' : 'hover:bg-accent/60',
                )}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => void runCommand(c.cmd)}
              >
                <span className="font-mono text-[12px] font-medium">{c.cmd}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{c.desc}</span>
              </button>
            ))}
          </div>
        )}

        {mention.open && candidates.length > 0 && (
          <div
            role="listbox"
            aria-label="候选列表"
            className="absolute bottom-full left-0 z-30 mb-2 max-h-80 w-80 overflow-y-auto rounded-xl border bg-popover p-1 shadow-xl shadow-primary/10 animate-fade-in"
          >
            {candidates[0]?.kind === 'agent' && (
              <div className="flex items-baseline justify-between px-2 py-1">
                <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">召唤成员</span>
                <span className="text-[10px] text-primary/70">
                  {mention.start === 0 ? '行首 @ 指定首棒' : '行内 @ 仅提及'}
                </span>
              </div>
            )}
            {candidates.map((c, i) => (
              <React.Fragment key={c.key}>
                {i > 0 && candidates[i - 1].kind !== c.kind && (
                  <div className="px-2 pb-1 pt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                    {c.kind === 'file' ? '文件' : '技能'}
                  </div>
                )}
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
                    i === mention.index ? 'bg-primary/10 text-primary' : 'hover:bg-accent/60',
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setMention((m) => ({ ...m, index: i }))}
                  onClick={() => selectCandidate(c)}
                >
                  {c.kind === 'agent' && c.agent ? (
                    <AgentAvatar agent={c.agent} size={22} animated={false} />
                  ) : (
                    <span className="w-[22px] shrink-0 text-center text-[11px]" aria-hidden>
                      {c.kind === 'file' ? '📄' : '🧩'}
                    </span>
                  )}
                  <span className="max-w-40 truncate font-medium">
                    <HighlightMatch text={c.label} query={mention.query} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
                    <HighlightMatch text={c.hint} query={mention.query} />
                  </span>
                  {c.kind === 'agent' && c.agent && <AgentStatusDot status={statuses[c.agent.id] ?? 'idle'} />}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
        {/* M11 指挥台：成员快捷召唤条（点击插入 @；实时状态点与排队序号）；M16：按场景分组、组色圆点分隔、新成员高亮；
            ADR 0135：全场景统一常驻（M52-G 席位让位判定已撤销——席位与成员条同屏并存） */}
        {!disabled && poolSorted.length > 0 && (
          <div className="flex items-center gap-1 overflow-x-auto px-2.5 pb-0.5 pt-2">
            {poolSorted.map((x, i) => {
              const a = x.agent
              const st = statuses[x.key] ?? 'idle'
              const busy = st === 'speaking' || st === 'thinking'
              const qIdx = queue.indexOf(x.key)
              const queueHint = qIdx === 0 ? (busy ? ' · 正在发言' : ' · 即将接棒') : qIdx > 0 ? ` · 排队第 ${qIdx + 1} 位` : ''
              const prev = poolSorted[i - 1]
              const group = groups.find((g) => g.id === a.group)
              const showDivider = Boolean(prev && prev.agent.group !== a.group && group)
              return (
                <React.Fragment key={x.key}>
                  {showDivider && (
                    <span
                      className="mx-0.5 size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: group!.theme[0] }}
                      title={`场景：${group!.name}`}
                    />
                  )}
                  <button
                    type="button"
                    title={`召唤 ${x.label}（${a.role}）${queueHint}`}
                    onClick={() => insert(`@${x.label} `)}
                    className={cn(
                      'group relative flex shrink-0 items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-[11.5px] transition-all',
                      busy
                        ? 'border-primary/45 bg-primary/5 text-primary shadow-sm shadow-primary/10'
                        : 'border-transparent bg-muted/70 text-muted-foreground hover:border-primary/25 hover:bg-primary/5 hover:text-primary',
                      qIdx > 0 && 'border-primary/30 bg-primary/5 text-primary',
                      freshIds.has(x.key) && 'member-enter',
                    )}
                  >
                    <AgentAvatar agent={a} size={18} animated={false} />
                    <span className="font-medium">{x.label}</span>
                    <span className={cn('size-1.5 rounded-full', STATE_DOT[st], busy && 'animate-pulse')} />
                    {qIdx > 0 && (
                      <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8.5px] font-bold text-primary-foreground shadow-sm">
                        {qIdx + 1}
                      </span>
                    )}
                  </button>
                </React.Fragment>
              )
            })}
          </div>
        )}

        {/* M33：待发附件托盘（图片缩略 / 文件卡 / 上传进度；发送后清空） */}
        {tray.length > 0 && (
          <AttachmentTray items={tray} onRemove={removeTrayItem} onOpen={openTrayLightbox} />
        )}

        <textarea
          ref={ref}
          value={value}
          disabled={disabled}
          rows={1}
          placeholder={
            locked
              ? (lockedHint ?? '只读共享（viewer）：无写权限')
              : disabled
                ? '先创建或选择一个会话…'
                : '输入消息，@ 召唤成员 / 文件 / 技能，/ 使用命令，可直接拖拽或粘贴图片 / 文档…'
          }
          className="block w-full resize-none bg-transparent px-3.5 py-3 pr-28 text-[13.5px] leading-6 placeholder:text-muted-foreground focus:outline-none"
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files]
            if (pasted.length > 0) {
              e.preventDefault()
              attachFiles(pasted)
            }
          }}
          onKeyUp={(e) => {
            if ((e.nativeEvent as KeyboardEvent).isComposing) return
            if (e.key === 'Escape') return // Esc 显式关闭后 keyup 不重开
            const caret = e.currentTarget.selectionStart ?? 0
            const probe = detectMention(e.currentTarget.value, caret)
            if (probe) setMention((prev) => ({ open: true, query: probe.query, start: probe.start, index: prev.index }))
            else if (mention.open) setMention(CLOSED)
          }}
          onClick={(e) => {
            const probe = detectMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
            if (probe) setMention(() => ({ open: true, query: probe.query, start: probe.start, index: 0 }))
          }}
          onBlur={() => closeMention()}
        />

        <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept={ATTACHMENT_ACCEPT}
            onChange={(e) => {
              const chosen = [...(e.target.files ?? [])]
              e.target.value = ''
              attachFiles(chosen)
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            title="上传文件 / 图片（也可拖拽、粘贴）"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
          </Button>
          {active && !locked && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => void useRunStore.getState().stop()}
            >
              <Square className="size-3 fill-current" />
              停止
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 px-2.5"
            disabled={
              disabled ||
              sending ||
              uploading ||
              (!value.trim() && tray.filter((t) => t.status === 'done').length === 0)
            }
            onClick={() => void submit()}
          >
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            {active ? '插话' : '发送'}
          </Button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
        {/* M24：消息级范式选择器（三态 chip；运行中禁用——插话不支持范式选择） */}
        <span className="inline-flex items-center gap-1.5">
          <span className="flex overflow-hidden rounded-full border bg-muted/40 p-0.5">
            {MODE_CHIPS.map((c) => (
              <button
                key={c.mode}
                type="button"
                title={active ? '运行中发送为插话，范式选择在下一轮生效前不可用' : c.title}
                disabled={disabled || active}
                onClick={() => setMode(c.mode)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  mode === c.mode
                    ? c.mode === 'execute'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'bg-primary/15 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {c.label}
              </button>
            ))}
          </span>
          {mode !== 'execute' ? (
            <span className="text-primary/80">本条以「{MODE_CHIPS.find((c) => c.mode === mode)?.label}」发送，仅生效一次</span>
          ) : session?.planFirst ? (
            <span
              className="text-muted-foreground/80"
              title="会话「规划先行」已开启：未显式选择时默认规划范式（运行中可在任务视图切换）"
            >
              规划先行
            </span>
          ) : null}
        </span>
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="size-3" />
          Enter 发送 · Shift+Enter 换行 · @ 召唤 · / 命令
        </span>
        {insertHint && (
          <span className="inline-flex items-center gap-1 text-amber-600">
            <Loader2 className="size-3 animate-spin" />
            {insertHint}
          </span>
        )}
        {active && (
          <span className="inline-flex items-center gap-1 text-primary">
            <Loader2 className="size-3 animate-spin" />
            协作进行中{queue.length > 0 ? ` · 队列 ${queue.length}` : ''}
            {queued ? ' · 已排队' : ''}
          </span>
        )}
        {/* 上下文电池格条（M8/M9→M25）：分段水位右对齐常驻；本 Run 费用 / 轨迹入口同排 */}
        <span className="ml-auto inline-flex items-center gap-1.5">
          <ContextBar />
        </span>
      </div>

      {/* M33：附件预览浮层（托盘图片 / 视频；多张时左右切换） */}
      {lightbox && (
        <AttachmentLightbox
          items={lightbox.items}
          index={lightbox.index}
          onIndexChange={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : prev))}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}
