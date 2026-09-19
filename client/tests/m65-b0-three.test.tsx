/**
 * M65-B0 接装验证（three 栈）：
 * - three 核心对象在 jsdom（Node）可加载与构造（版本矩阵加载验证；WebGL 渲染不由 jsdom 承担）；
 * - StudioSurface 懒加载边界：Suspense 骨架 → 挂载 3D 画布锚点（渲染层以 mock Canvas 为壳，
 *   不依赖 jsdom WebGL——策略见设计文档 §6.2「测试替身」）；
 * - 卸载 / 重挂载生命周期（懒加载 + 卸载释放语义）。
 */
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as THREE from 'three'
import { emptyScene } from '../src/components/studio/design-scene-model'
import { StudioSurface } from '../src/components/studio/studio-lazy'

vi.mock('@react-three/fiber', async () => {
  const React = await import('react')
  return {
    Canvas: ({ children, ...rest }: { children?: React.ReactNode }): React.ReactElement =>
      React.createElement('div', { 'data-testid': 'r3f-canvas', ...rest }, children),
  }
})

vi.mock('@react-three/drei', () => ({
  Grid: (): null => null,
  OrbitControls: (): null => null,
}))

afterEach(() => cleanup())

describe('M65-B0：three 栈接装验证', () => {
  it('three 核心在 jsdom 可加载：场景 / 几何 / 版本可构造', () => {
    expect(THREE.REVISION).toBe('175')
    const scene = new THREE.Scene()
    const geo = new THREE.BoxGeometry(1, 2, 3)
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
    scene.add(mesh)
    expect(scene.children).toHaveLength(1)
    expect(geo.parameters.width).toBe(1)
    expect(geo.parameters.height).toBe(2)
    expect(geo.parameters.depth).toBe(3)
    geo.dispose()
  })

  it('StudioSurface：懒加载骨架 → 挂载 3D 画布（mock Canvas 壳）', async () => {
    const { container } = render(<StudioSurface className="h-40" scene={emptyScene()} />)
    // 懒加载边界：先出现加载锚点（同步首帧；data-* 锚点口径同 E2E）
    expect(container.querySelector('[data-studio-loading]')).toBeTruthy()
    // 动态 import 完成后出现画布容器 + Canvas 壳
    expect(await screen.findByTestId('r3f-canvas')).toBeTruthy()
    expect(container.querySelector('[data-studio-surface]')).toBeTruthy()
  })

  it('卸载 / 重挂载 ×3 无异常（生命周期释放语义）', async () => {
    for (let i = 0; i < 3; i++) {
      const view = render(<StudioSurface className="h-40" scene={emptyScene()} />)
      await screen.findByTestId('r3f-canvas')
      view.unmount()
    }
    expect(screen.queryByTestId('r3f-canvas')).toBeNull()
  })
})
