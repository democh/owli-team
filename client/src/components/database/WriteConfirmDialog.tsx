/**
 * 写操作确认对话框（M23，Navicat / DataGrip 习惯）：
 * 写语句（INSERT / UPDATE / DELETE / DDL）在真正下发前二次确认。
 *
 * 交互要点：
 * - 主按钮聚焦「确认执行」，Esc / 遮罩 = 取消（Radix 默认）；
 * - 展示完整语句（超长滚动）与目标连接，避免"跑错库"；
 * - 连接未开启「允许写入」时给出琥珀警告：确认后也会被服务端护栏拒绝（不拦截尝试，保持单一路径）。
 */
import * as React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

export interface WriteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 待执行语句（dryRun 判定为 execute） */
  sql: string
  /** 目标连接展示名 */
  connectionName: string
  /** 连接是否开启「允许写入」；false 时明示将被服务端拒绝 */
  writesAllowed: boolean
  running?: boolean
  onConfirm: () => void
}

export function WriteConfirmDialog({
  open,
  onOpenChange,
  sql,
  connectionName,
  writesAllowed,
  running,
  onConfirm,
}: WriteConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => (!running ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-w-lg" data-testid="write-confirm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" />
            确认执行写操作
          </DialogTitle>
          <DialogDescription>
            该语句将修改 <span className="font-medium text-foreground">{connectionName}</span> 的数据或结构，执行前请确认目标与影响范围。
          </DialogDescription>
        </DialogHeader>

        <pre className="max-h-44 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap break-all">
          {sql}
        </pre>

        {!writesAllowed && (
          <p className="rounded-md border border-amber-500/30 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-700">
            该连接未开启「允许写入」，执行将被服务端拒绝。可在「连接管理」中编辑连接后重试。
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={running} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={running || !writesAllowed}
            onClick={() => onConfirm()}
            title={!writesAllowed ? '连接未开启「允许写入」' : '执行写语句'}
          >
            {running && <Loader2 className="mr-1 size-3 animate-spin" />}
            确认执行
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
