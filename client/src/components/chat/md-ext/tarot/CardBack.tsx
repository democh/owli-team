/**
 * M78：牌背（见 docs/tarot-ritual-design.md §3.3）——「星月紫金」。
 *
 * 优先位图纹理（/tarot/back.jpg，ImageGen 设计稿压缩版）；加载失败回退内联 SVG 绘制
 * （主题底 + 双线描金边框 + 八角星月 emblem + 四角星点）——确定性兜底，零外部请求依赖。
 */
import * as React from 'react'

/** 兜底 SVG 牌背（viewBox 100×170，与牌宽高比一致；mask id 用 useId 防多实例冲突） */
function CardBackSvg(): React.JSX.Element {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '')
  const bg = `tc-bg-${uid}`
  const moon = `tc-moon-${uid}`
  return (
    <svg className="tc-back-svg" viewBox="0 0 100 170" aria-hidden="true">
      <defs>
        <radialGradient id={bg} cx="50%" cy="38%" r="78%">
          <stop offset="0%" stopColor="#3b1a63" />
          <stop offset="55%" stopColor="#2c0f4e" />
          <stop offset="100%" stopColor="#1f0838" />
        </radialGradient>
        {/* 月牙 = 圆 − 错位小圆 */}
        <mask id={moon}>
          <rect x="0" y="0" width="100" height="170" fill="#fff" />
          <circle cx="53.4" cy="85" r="6.6" fill="#000" />
        </mask>
      </defs>
      <rect x="0" y="0" width="100" height="170" fill={`url(#${bg})`} />
      {/* 双线描金边框 */}
      <rect x="4" y="4" width="92" height="162" rx="5" fill="none" stroke="#d8b4fe" strokeOpacity="0.6" strokeWidth="0.9" />
      <rect x="9.5" y="9.5" width="81" height="151" rx="3.5" fill="none" stroke="#e9d5ff" strokeOpacity="0.32" strokeWidth="0.55" />
      {/* 中心八角星 + 弯月 */}
      <g stroke="#d8b4fe" strokeWidth="0.75" strokeOpacity="0.85" strokeLinecap="round">
        <line x1="50" y1="63" x2="50" y2="107" />
        <line x1="28" y1="85" x2="72" y2="85" />
        <line x1="34.4" y1="69.4" x2="65.6" y2="100.6" />
        <line x1="65.6" y1="69.4" x2="34.4" y2="100.6" />
      </g>
      <circle cx="50" cy="85" r="8" fill="#d8b4fe" fillOpacity="0.9" mask={`url(#${moon})`} />
      <circle cx="50" cy="85" r="10.6" fill="none" stroke="#e9d5ff" strokeOpacity="0.5" strokeWidth="0.55" />
      {/* 四角星点 */}
      <g fill="#e9d5ff">
        <circle cx="15" cy="18" r="0.8" opacity="0.45" />
        <circle cx="20.5" cy="14.5" r="0.6" opacity="0.3" />
        <circle cx="17.5" cy="23" r="0.55" opacity="0.25" />
        <circle cx="85" cy="18" r="0.8" opacity="0.45" />
        <circle cx="79.5" cy="14.5" r="0.6" opacity="0.3" />
        <circle cx="82.5" cy="23" r="0.55" opacity="0.25" />
        <circle cx="15" cy="152" r="0.8" opacity="0.45" />
        <circle cx="20.5" cy="155.5" r="0.6" opacity="0.3" />
        <circle cx="17.5" cy="147" r="0.55" opacity="0.25" />
        <circle cx="85" cy="152" r="0.8" opacity="0.45" />
        <circle cx="79.5" cy="155.5" r="0.6" opacity="0.3" />
        <circle cx="82.5" cy="147" r="0.55" opacity="0.25" />
      </g>
    </svg>
  )
}

export function CardBack({ className, ariaLabel }: { className?: string; ariaLabel?: string }): React.JSX.Element {
  const [imgOk, setImgOk] = React.useState(true)
  return (
    <span className={`tc-back${className ? ` ${className}` : ''}`} role="img" aria-label={ariaLabel ?? '牌背'}>
      {imgOk ? (
        <img className="tc-back-img" src="/tarot/back.jpg" alt="" draggable={false} onError={() => setImgOk(false)} />
      ) : (
        <CardBackSvg />
      )}
    </span>
  )
}
