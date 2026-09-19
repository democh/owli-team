/**
 * M58：面板壳 chrome 注入——宿主（dock 右区）把折叠 / 关闭等操作钮注入面板标题行，
 * 与标题、徽标同行（替代旧版独立操作条）；roundtable / 窄屏抽屉不注入（actions 为空，不渲染）。
 * 未提供上下文（独立渲染 / 单测）时降级为空（无操作钮）。
 */
import * as React from 'react'

export interface PanelChrome {
  /** 标题行右端操作区（折叠 / 关闭等） */
  actions?: React.ReactNode
}

const PanelChromeContext = React.createContext<PanelChrome>({})

export const PanelChromeProvider = PanelChromeContext.Provider

export function usePanelChrome(): PanelChrome {
  return React.useContext(PanelChromeContext)
}
