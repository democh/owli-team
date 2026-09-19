/**
 * SSH「本地」预置：本机（127.0.0.1）默认配置探测 —— OS 用户名 / SSH Agent / 默认私钥 / 22 端口可达。
 *
 * 供「连接管理 → 新建 SSH」的「本地（本机）」一键填入。认证优先级：
 * agent（SSH_AUTH_SOCK 非空，无凭据落库即用）> key（~/.ssh 默认私钥存在）> password（仍需用户填写密码）。
 * 探测依赖全部可注入（测试不触真实 ~/.ssh 与网络）；失败路径一律降级为布尔 / 缺省，不抛错。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SshAuthMethod, SshLocalPreset } from '@multi-agent/shared'

/** 默认私钥候选（按优先级；以 ~ 形式回传，服务端读取时展开） */
const KEY_CANDIDATES = ['~/.ssh/id_ed25519', '~/.ssh/id_rsa', '~/.ssh/id_ecdsa'] as const

const LOCAL_HOST = '127.0.0.1'
const DEFAULT_SSH_PORT = 22
const PROBE_TIMEOUT_MS = 600

export interface SshLocalPresetDeps {
  /** 用户主目录（默认 os.homedir） */
  homeDir?: string
  /** 进程环境变量（默认 process.env；看 SSH_AUTH_SOCK） */
  env?: NodeJS.ProcessEnv
  /** 本机用户名（默认 os.userInfo().username；极端环境回退 USER / USERNAME） */
  username?: string
  /** 端口可达探测（默认 TCP connect；测试注入以免触网） */
  probePort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
}

/** TCP 可达探测：connect / timeout / error 三路收敛为布尔（不抛错） */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    const finish = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 本机登录用户（os.userInfo 在无 uid 的极端环境下抛错，回退环境变量） */
function defaultUsername(env: NodeJS.ProcessEnv): string {
  try {
    return os.userInfo().username
  } catch {
    return env.USER ?? env.USERNAME ?? 'root'
  }
}

/** 探测本机默认 SSH 配置（键：主机 / 端口 / 用户名 / 认证方式 + 两个就绪标记） */
export async function detectSshLocalPreset(deps: SshLocalPresetDeps = {}): Promise<SshLocalPreset> {
  const home = deps.homeDir ?? os.homedir()
  const env = deps.env ?? process.env
  const username = deps.username ?? defaultUsername(env)
  const probe = deps.probePort ?? probeTcp

  const agentAvailable = Boolean(env.SSH_AUTH_SOCK)
  const keyPath = KEY_CANDIDATES.find((candidate) => fs.existsSync(path.join(home, candidate.slice(2))))
  const authMethod: SshAuthMethod = agentAvailable ? 'agent' : keyPath ? 'key' : 'password'
  const sshdReachable = await probe(LOCAL_HOST, DEFAULT_SSH_PORT, PROBE_TIMEOUT_MS)

  return {
    name: '本地',
    host: LOCAL_HOST,
    port: DEFAULT_SSH_PORT,
    username,
    authMethod,
    ...(authMethod === 'key' && keyPath ? { privateKeyPath: keyPath } : {}),
    agentAvailable,
    sshdReachable,
  }
}
