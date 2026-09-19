/**
 * AgentAvatar：生图优先 → 加载失败回退渐变 + 图标 → 无图无渐变时中性底兜底。
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { AgentDefinition } from '@multi-agent/shared'
import { AgentAvatar } from '../src/components/agents/AgentAvatar'

function makeAgent(avatar: AgentDefinition['avatar']): AgentDefinition {
  return {
    id: 'pm',
    name: '费利',
    role: '产品经理',
    title: '',
    description: '',
    capabilities: [],
    group: 'development',
    avatar,
    handoff: [],
  }
}

describe('AgentAvatar', () => {
  it('无 agent 时不渲染用户头像，兜底中性底 + 图标', () => {
    const { container } = render(<AgentAvatar size={32} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('配置 image 时优先渲染生图资产', () => {
    const { container } = render(<AgentAvatar agent={makeAgent({ image: '/avatars/pm.png' })} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/avatars/pm.png')
  })

  it('图片加载失败回退渐变 + 图标', () => {
    const { container } = render(
      <AgentAvatar agent={makeAgent({ image: '/avatars/broken.png', gradient: ['#f59e0b', '#fbbf24'], icon: 'clipboard-list' })} />,
    )
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    const fallback = container.querySelector('div[style*="linear-gradient"]')
    expect(fallback).not.toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('无 image 且无渐变时渲染中性底 + 图标', () => {
    const { container } = render(<AgentAvatar agent={makeAgent({ icon: 'rocket' })} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('thinking / done / error 状态角标按需渲染，animated=false 时全关', () => {
    const agent = makeAgent({ image: '/avatars/pm.png' })
    const { container: thinking } = render(<AgentAvatar agent={agent} state="thinking" />)
    expect(thinking.querySelectorAll('.pa-dot')).toHaveLength(3)

    const { container: done } = render(<AgentAvatar agent={agent} state="done" />)
    expect(done.querySelector('.pa-star')).not.toBeNull()

    const { container: error } = render(<AgentAvatar agent={agent} state="error" />)
    expect(error.querySelector('.pa-bolt')).not.toBeNull()

    const { container: quiet } = render(<AgentAvatar agent={agent} state="error" animated={false} />)
    expect(quiet.querySelector('.pa-bolt')).toBeNull()
  })
})
