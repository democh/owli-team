/**
 * M57：多用户客户端（auth-store 状态机 + 认证页面）。
 * - bootstrap 四分支：兼容模式直达 / 多用户未登录 → 登录页 / 无账号需令牌 → 令牌入口 / 首登改密；
 * - login：成功 reload；需改密进强制改密页（不 reload）；
 * - handleUnauthorized：仅 ready 态翻转到登录页（登录接口自身 401 不误伤）；
 * - 页面：登录失败回显 / 首启与改密的两次密码不一致校验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ForcePasswordPage, LoginPage, SetupPage } from '../src/pages/AuthPages'
import { useAuthStore } from '../src/stores/auth-store'

const fetchMock = vi.fn()
const reloadMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function mockRoutes(handler: (url: string) => Response): void {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return Promise.resolve(handler(url))
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  reloadMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  // jsdom：location.reload / href 可断言（auth-store 成功后整页 reload）
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { reload: reloadMock, href: 'http://localhost/', assign: vi.fn(), hash: '' },
  })
  useAuthStore.setState({
    phase: 'loading',
    user: null,
    isAdmin: false,
    status: { needsSetup: false, authRequired: false, multiUser: false },
    error: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M57：auth-store 启动引导', () => {
  it('兼容模式（无账号 + 本机开放）→ 直接就绪（合成管理员）', async () => {
    mockRoutes((url) =>
      url.includes('/auth/status')
        ? jsonResponse({ needsSetup: true, authRequired: false, multiUser: false })
        : jsonResponse({
            user: { id: '', username: 'local', displayName: '本地管理员', role: 'admin', legacy: true },
            isAdmin: true,
          }),
    )
    await useAuthStore.getState().bootstrap()
    const state = useAuthStore.getState()
    expect(state.phase).toBe('ready')
    expect(state.isAdmin).toBe(true)
    expect(state.user?.legacy).toBe(true)
  })

  it('多用户 + 未登录（/auth/me 401）→ 登录阶段', async () => {
    mockRoutes((url) =>
      url.includes('/auth/status')
        ? jsonResponse({ needsSetup: false, authRequired: true, multiUser: true })
        : jsonResponse({ error: '未登录或登录已失效：请登录后重试' }, 401),
    )
    await useAuthStore.getState().bootstrap()
    expect(useAuthStore.getState().phase).toBe('login')
  })

  it('无账号 + 需令牌（AUTH_TOKEN 部署）→ 令牌入口', async () => {
    mockRoutes((url) =>
      url.includes('/auth/status')
        ? jsonResponse({ needsSetup: true, authRequired: true, multiUser: false })
        : jsonResponse({ error: '未授权' }, 401),
    )
    await useAuthStore.getState().bootstrap()
    expect(useAuthStore.getState().phase).toBe('token')
  })

  it('首登强制改密（mustChangePassword）→ 改密页', async () => {
    mockRoutes((url) =>
      url.includes('/auth/status')
        ? jsonResponse({ needsSetup: false, authRequired: true, multiUser: true })
        : jsonResponse({
            user: { id: 'u_1', username: 'bob', displayName: 'Bob', role: 'member', mustChangePassword: true },
            isAdmin: false,
          }),
    )
    await useAuthStore.getState().bootstrap()
    expect(useAuthStore.getState().phase).toBe('force-password')
  })
})

describe('M57：登录 / 401 全局处理', () => {
  it('登录成功（无需改密）→ 整页 reload', async () => {
    mockRoutes(() => jsonResponse({ user: { id: 'u_1', username: 'bob', displayName: 'Bob', role: 'member' }, mustChangePassword: false }))
    await useAuthStore.getState().login('bob', 'Passw0rd!x')
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('登录成功但需改密 → 进入改密页（不 reload）；改密成功 → reload', async () => {
    mockRoutes((url) =>
      url.includes('/auth/login')
        ? jsonResponse({ user: { id: 'u_1', username: 'bob', displayName: 'Bob', role: 'member' }, mustChangePassword: true })
        : jsonResponse({ ok: true }),
    )
    await useAuthStore.getState().login('bob', 'Passw0rd!x')
    expect(useAuthStore.getState().phase).toBe('force-password')
    expect(reloadMock).not.toHaveBeenCalled()
    await useAuthStore.getState().changePassword('Passw0rd!x', 'FreshPass2@')
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('handleUnauthorized：仅 ready 态翻转到登录页', () => {
    useAuthStore.setState({ phase: 'ready', user: { id: 'u_1', username: 'a', displayName: 'A', role: 'member' }, isAdmin: false })
    useAuthStore.getState().handleUnauthorized()
    expect(useAuthStore.getState().phase).toBe('login')
    expect(useAuthStore.getState().error).toContain('登录已失效')

    useAuthStore.setState({ phase: 'login', user: null, error: null })
    useAuthStore.getState().handleUnauthorized()
    expect(useAuthStore.getState().phase).toBe('login')
    expect(useAuthStore.getState().error).toBeNull()
  })
})

describe('M57：认证页面', () => {
  it('登录失败（401）→ 页面回显服务端文案', async () => {
    useAuthStore.setState({ phase: 'login' })
    mockRoutes(() => jsonResponse({ error: '用户名或密码错误' }, 401))
    render(<LoginPage />)
    await userEvent.type(screen.getByLabelText('用户名'), 'bob')
    await userEvent.type(screen.getByLabelText('密码'), 'wrong-pass')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('用户名或密码错误'))
  })

  it('首启向导：两次密码不一致 → 本地校验拦截（不发请求）', async () => {
    useAuthStore.setState({ phase: 'setup' })
    mockRoutes(() => jsonResponse({ ok: true }, 201))
    render(<SetupPage />)
    await userEvent.type(screen.getByLabelText('用户名（登录名）'), 'admin')
    await userEvent.type(screen.getByLabelText('密码（至少 10 位，含两类字符）'), 'Str0ngPass!x')
    await userEvent.type(screen.getByLabelText('确认密码'), 'Different!x')
    await userEvent.click(screen.getByRole('button', { name: /创建并进入/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('两次输入的密码不一致'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('强制改密页：两次新密码不一致 → 本地校验拦截', async () => {
    useAuthStore.setState({ phase: 'force-password', user: { id: 'u_1', username: 'bob', displayName: 'Bob', role: 'member' } })
    mockRoutes(() => jsonResponse({ ok: true }))
    render(<ForcePasswordPage />)
    await userEvent.type(screen.getByLabelText('当前密码（初始密码）'), 'InitPass1!')
    await userEvent.type(screen.getByLabelText('新密码（至少 10 位，含两类字符）'), 'FreshPass2@')
    await userEvent.type(screen.getByLabelText('确认新密码'), 'Mismatch3#')
    await userEvent.click(screen.getByRole('button', { name: /修改密码并进入/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('两次输入的新密码不一致'))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
