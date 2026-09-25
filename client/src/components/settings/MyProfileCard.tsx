/**
 * M79-B：我的资料卡（个人设置页；设计 §14.9）。
 *
 * 维护项：显示名 / 头衔 / 简介 / 头像（默认主色首字 · 12 色盘 · 单 emoji）。
 * 保存：PATCH /api/auth/profile（null = 清除）；成功后就地更新 auth-store（免整页刷新）。
 * M79-J：同文件导出 `MyPrivacyCard`（隐私开关区：允许搜索 / 允许好友申请；GET/PUT /api/auth/preferences）。
 */
import * as React from 'react'
import { ImagePlus, Loader2, Save, ShieldCheck, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import type { UserAvatar } from '@multi-agent/shared'
import { apiGet, apiPatch, apiPut, apiUpload } from '../../lib/api'
import { cropSquareImage } from '../../lib/avatar'
import { useAuthStore, type AuthUserInfo } from '../../stores/auth-store'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Input } from '../ui/input'
import { HumanAvatar } from '../chat/HumanAvatar'
import { Switch } from '../console/fields'
import { cn } from '../../lib/utils'

/** 预设头像色盘（与主色系协调；#rrggbb） */
const PRESET_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#14b8a6',
  '#0ea5e9',
  '#3b82f6',
  '#64748b',
  '#334155',
]

export function MyProfileCard(): React.JSX.Element {
  const user = useAuthStore((s) => s.user)
  const [displayName, setDisplayName] = React.useState(user?.displayName ?? '')
  const [headline, setHeadline] = React.useState(user?.headline ?? '')
  const [bio, setBio] = React.useState(user?.bio ?? '')
  const [avatar, setAvatar] = React.useState<UserAvatar | null>(user?.avatar ?? null)
  const [emoji, setEmoji] = React.useState(user?.avatar?.kind === 'emoji' ? user.avatar.value : '')
  const [mode, setMode] = React.useState<'default' | 'color' | 'emoji' | 'image'>(
    user?.avatar ? (user.avatar.kind === 'image' ? 'image' : user.avatar.kind === 'emoji' ? 'emoji' : 'color') : 'default',
  )
  const [saving, setSaving] = React.useState(false)
  // M79-Q：图片头像（选择即裁即传即生效；原始对象 URL 预览）
  const [imageBusy, setImageBusy] = React.useState(false)
  const [imagePreview, setImagePreview] = React.useState<string>()
  const imageInputRef = React.useRef<HTMLInputElement>(null)
  const previewUrlRef = React.useRef<string>()

  // 账号切换（登录 / 刷新）后同步初值
  React.useEffect(() => {
    setDisplayName(user?.displayName ?? '')
    setHeadline(user?.headline ?? '')
    setBio(user?.bio ?? '')
    setAvatar(user?.avatar ?? null)
    setMode(user?.avatar ? (user.avatar.kind === 'image' ? 'image' : user.avatar.kind === 'emoji' ? 'emoji' : 'color') : 'default')
    setEmoji(user?.avatar?.kind === 'emoji' ? user.avatar.value : '')
    setImagePreview(undefined)
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载时释放预览对象 URL
  React.useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    },
    [],
  )

  const effectiveAvatar: UserAvatar | undefined =
    mode === 'color' ? (avatar?.kind === 'color' ? avatar : { kind: 'color', value: PRESET_COLORS[0]! }) : mode === 'emoji' ? (emoji.trim() ? { kind: 'emoji', value: [...emoji.trim()][0]! } : undefined) : undefined

  /** M79-Q：选择图片 → 裁剪 256² → 即时上传（独立于「保存资料」，避免把图片头像清掉） */
  const uploadImage = async (file: File): Promise<void> => {
    setImageBusy(true)
    try {
      const blob = await cropSquareImage(file)
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      const url = URL.createObjectURL(blob)
      previewUrlRef.current = url
      setImagePreview(url)
      const res = await apiUpload<{ user: AuthUserInfo }>('/api/auth/avatar', blob, {
        'content-type': blob.type || 'image/png',
      })
      if (res.user) {
        useAuthStore.getState().applyProfile(res.user)
        // 上传成功：预览切回服务端权威 URL（释放 blob 临时预览，避免与真实来源不一致）
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = undefined
        setImagePreview(undefined)
      }
      toast.success('头像已更新')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setImageBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    const name = displayName.trim()
    if (!name) {
      toast.error('显示名不能为空')
      return
    }
    if (mode === 'emoji' && [...emoji.trim()].length !== 1) {
      toast.error('请选择一个 emoji（单个字符）')
      return
    }
    setSaving(true)
    try {
      const res = await apiPatch<{ user: AuthUserInfo }>('/api/auth/profile', {
        displayName: name,
        headline: headline.trim() || null,
        bio: bio.trim() || null,
        // M79-Q：图片模式不改 avatar 字段（换图经「选择图片」即时上传；缺省 = 服务端保持原值）
        ...(mode === 'image' ? {} : { avatar: mode === 'default' ? null : effectiveAvatar ?? null }),
      })
      if (res.user) useAuthStore.getState().applyProfile(res.user)
      toast.success('已保存')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 pb-1">
        <UserRound className="size-4 text-muted-foreground" />
        <CardTitle className="text-[13px]">我的资料</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 预览行（头像 + 名 + 头衔；与消息气泡呈现一致）；M79-Q：image 模式显示图片（新选预览优先） */}
        <div className="flex items-center gap-2.5">
          <HumanAvatar
            avatar={
              mode === 'image'
                ? imagePreview
                  ? { kind: 'image', value: imagePreview }
                  : user?.avatar?.kind === 'image'
                    ? user.avatar
                    : undefined
                : effectiveAvatar
            }
            name={displayName || user?.displayName || '?'}
            size={34}
          />
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium">{displayName || '（未命名）'}</div>
            <div className="truncate text-[11.5px] text-muted-foreground">{headline || '未设置头衔'}</div>
          </div>
        </div>

        <div className="grid gap-2 text-[12px]">
          <label className="grid grid-cols-[76px_1fr] items-center gap-2">
            <span className="text-muted-foreground">显示名</span>
            <Input value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label className="grid grid-cols-[76px_1fr] items-center gap-2">
            <span className="text-muted-foreground">头衔</span>
            <Input
              value={headline}
              maxLength={30}
              placeholder="如：产品经理"
              onChange={(e) => setHeadline(e.target.value)}
            />
          </label>
          <label className="grid grid-cols-[76px_1fr] items-start gap-2">
            <span className="pt-1.5 text-muted-foreground">简介</span>
            <textarea
              value={bio}
              maxLength={120}
              rows={2}
              placeholder="一句话介绍自己（可选）"
              onChange={(e) => setBio(e.target.value)}
              className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-[12px] leading-5 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="grid grid-cols-[76px_1fr] items-start gap-2">
            <span className="pt-1.5 text-muted-foreground">头像</span>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11.5px]">
                {(['default', 'color', 'emoji', 'image'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={cn(
                      'rounded-full border px-2 py-0.5 transition-colors',
                      mode === m ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setMode(m)}
                  >
                    {m === 'default' ? '默认' : m === 'color' ? '色块' : m === 'emoji' ? 'emoji' : '图片'}
                  </button>
                ))}
              </div>
              {mode === 'color' && (
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_COLORS.map((color) => {
                    const active = avatar?.kind === 'color' && avatar.value === color
                    return (
                      <button
                        key={color}
                        type="button"
                        title={color}
                        aria-label={`头像色 ${color}`}
                        className={cn('size-6 rounded-full border-2 transition-transform', active ? 'border-primary scale-110' : 'border-transparent')}
                        style={{ background: color }}
                        onClick={() => setAvatar({ kind: 'color', value: color })}
                      />
                    )
                  })}
                </div>
              )}
              {mode === 'emoji' && (
                <Input
                  value={emoji}
                  maxLength={8}
                  placeholder="输入一个 emoji（如 🐼）"
                  className="h-7 w-40 text-[12px]"
                  onChange={(e) => setEmoji(e.target.value)}
                />
              )}
              {mode === 'image' && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={imageInputRef}
                    type="file"
                    hidden
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) void uploadImage(f)
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[12px]"
                    disabled={imageBusy}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    {imageBusy ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <ImagePlus className="mr-1 size-3.5" />
                    )}
                    {imageBusy ? '上传中…' : '选择图片'}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">自动裁剪为方形 256×256，选择后立即生效</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Save className="mr-1 size-3.5" />}
          保存资料
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * M79-J（§14.9）：隐私开关卡——「允许他人搜索到我」「允许好友申请」。
 * 即时保存（乐观更新 + 失败回滚）；服务端白名单字段（UserPreferences）。
 */
export function MyPrivacyCard(): React.JSX.Element {
  const [searchable, setSearchable] = React.useState(true)
  const [allowFriendRequests, setAllowFriendRequests] = React.useState(true)
  // M80-C：已读对外展示（对等原则：关闭后也看不到他人的已读状态）
  const [showReadReceipts, setShowReadReceipts] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    void apiGet<{ preferences: { searchable?: boolean; allowFriendRequests?: boolean; showReadReceipts?: boolean } }>('/api/auth/preferences')
      .then((res) => {
        if (!alive) return
        setSearchable(res.preferences.searchable !== false)
        setAllowFriendRequests(res.preferences.allowFriendRequests !== false)
        setShowReadReceipts(res.preferences.showReadReceipts !== false)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const update = async (patch: { searchable?: boolean; allowFriendRequests?: boolean; showReadReceipts?: boolean }): Promise<void> => {
    const prev = { searchable, allowFriendRequests, showReadReceipts }
    if (patch.searchable !== undefined) setSearchable(patch.searchable)
    if (patch.allowFriendRequests !== undefined) setAllowFriendRequests(patch.allowFriendRequests)
    if (patch.showReadReceipts !== undefined) setShowReadReceipts(patch.showReadReceipts)
    setBusy(true)
    try {
      const res = await apiPut<{ preferences: { searchable?: boolean; allowFriendRequests?: boolean; showReadReceipts?: boolean } }>(
        '/api/auth/preferences',
        patch,
      )
      setSearchable(res.preferences.searchable !== false)
      setAllowFriendRequests(res.preferences.allowFriendRequests !== false)
      const receiptsOn = res.preferences.showReadReceipts !== false
      setShowReadReceipts(receiptsOn)
      // M80-C 对等双向：同步全局门（已读徽章 / 入站回执帧即时生效，免刷新）
      useAuthStore.getState().setReadReceiptsOn(receiptsOn)
    } catch (err) {
      setSearchable(prev.searchable)
      setAllowFriendRequests(prev.allowFriendRequests)
      setShowReadReceipts(prev.showReadReceipts)
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 pb-1">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <CardTitle className="text-[13px]">隐私</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">允许他人搜索到我</span>
          <Switch
            checked={searchable}
            disabled={loading || busy}
            label="允许他人搜索到我"
            onChange={(v) => void update({ searchable: v })}
          />
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">允许好友申请</span>
          <Switch
            checked={allowFriendRequests}
            disabled={loading || busy}
            label="允许好友申请"
            onChange={(v) => void update({ allowFriendRequests: v })}
          />
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">向他人展示我的已读状态</span>
          <Switch
            checked={showReadReceipts}
            disabled={loading || busy}
            label="向他人展示我的已读状态"
            onChange={(v) => void update({ showReadReceipts: v })}
          />
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          关闭「搜索」后仅精确用户名可找到你；关闭「好友申请」后他人无法向你发起请求（已是好友不受影响）。
          关闭「已读状态」后，对方看不到你是否读过消息，你也看不到对方的已读状态（对等原则）。
        </p>
      </CardContent>
    </Card>
  )
}
