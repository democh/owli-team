/**
 * M52-A：场景工作区全局态——「切回纯列表」开关（localStorage 记忆；§7.8）。
 * 形态 / 面板的会话内选中态走 sessionStorage（components/scene/persist.ts），本 store 只管跨会话开关；
 * 开关开启时所有场景一律 stream（resolveStage 优先判定），属用户显式兜底而非异常降级。
 */
import { create } from 'zustand'
import { SC_LIST_KEY } from '../components/scene/persist'

function loadListMode(): boolean {
  try {
    return localStorage.getItem(SC_LIST_KEY) === '1'
  } catch {
    // 隐私模式 / 非浏览器环境：忽略，默认场景形态
    return false
  }
}

interface SceneState {
  /** 纯列表模式（所有场景强制 stream） */
  listMode: boolean
  toggleListMode: () => void
  setListMode: (v: boolean) => void
}

export const useSceneStore = create<SceneState>((set, get) => ({
  listMode: loadListMode(),
  toggleListMode: () => {
    const next = !get().listMode
    try {
      localStorage.setItem(SC_LIST_KEY, next ? '1' : '0')
    } catch {
      // 持久化失败不影响切换
    }
    set({ listMode: next })
  },
  setListMode: (v) => {
    try {
      localStorage.setItem(SC_LIST_KEY, v ? '1' : '0')
    } catch {
      // 持久化失败不影响切换
    }
    set({ listMode: v })
  },
}))
