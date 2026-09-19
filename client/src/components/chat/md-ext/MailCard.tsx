/**
 * 邮件卡（::: mail [主题] + 收件人:/抄送:/主题: 头部行 + 正文）：
 * - 头部字段由 remark-ext finalize 解析为 data-*（头部行已从正文消费），无字段时头部只留复制按钮；
 * - 「复制正文」复用 CopyButton（1.6s 状态复位），正文纯文本由 data-body 提供（块级换行）；
 * - 正文 Markdown 原样渲染（段落/列表/加粗等），右侧留白收窄不影响可读性。
 */
import * as React from 'react'
import { CopyButton } from './CopyButton'

export function MailCard({
  to,
  cc,
  subject,
  body,
  children,
}: {
  to?: string
  cc?: string
  subject?: string
  body?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="md-mail">
      <div className="md-mail-head">
        <div className="md-mail-meta">
          {subject ? <div className="md-mail-subject">{subject}</div> : null}
          {to ? (
            <div className="md-mail-field">
              <span className="md-mail-label">收件人</span>
              <span className="md-mail-value">{to}</span>
            </div>
          ) : null}
          {cc ? (
            <div className="md-mail-field">
              <span className="md-mail-label">抄送</span>
              <span className="md-mail-value">{cc}</span>
            </div>
          ) : null}
        </div>
        <CopyButton text={() => body ?? ''} label="复制正文" />
      </div>
      <div className="md-mail-body">{children}</div>
    </div>
  )
}
