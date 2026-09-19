/**
 * 全局错误边界（M8）：渲染异常时展示可恢复的兜底界面，避免白屏。
 */
import * as React from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button'

interface State {
  error?: Error
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ui] 渲染异常：', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <TriangleAlert className="size-8 text-amber-500" />
          <p className="text-[13.5px] font-medium">界面渲染出错</p>
          <p className="max-w-md break-all text-[12px] leading-5 text-muted-foreground">{this.state.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => this.setState({ error: undefined })}>
            <RotateCcw className="size-3.5" />
            重试渲染
          </Button>
          <p className="text-[11px] text-muted-foreground">如反复出现，请刷新页面（数据已随消息实时落盘，不会丢失）</p>
        </div>
      )
    }
    return this.props.children
  }
}
