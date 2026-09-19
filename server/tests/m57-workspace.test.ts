/**
 * M57 测试：工作区用户维度布局（WP5）。
 * - WorkspaceService.resolveDir / canvasFileFor 四分支（显式 / 无属主 / 新布局 / 旧路径兼容回退）；
 * - ArtifactStore 尊重解析器：嵌套目录读写、removeSession 只删根内目录（外部挂载拒绝）；
 * - purgeUser：u_<uid> 整树 + 旧平面布局逐会话清理，且不动其他用户目录；
 * - migrateWorkspaceLayout：搬迁 + dry-run + 重复执行幂等。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateWorkspaceLayout } from '../src/scripts/migrate-workspace.js'
import { makeEnv } from './helpers.js'

function writeFileUnder(root: string, rel: string, content = 'x'): string {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
  return full
}

describe('M57：WorkspaceService 路径解析', () => {
  it('resolveDir：无属主 → 平面旧路径；有属主 → u_<uid> 嵌套；新未建且旧存在 → 兼容回退；显式 workspaceDir 优先', () => {
    const env = makeEnv()
    const legacySession = env.sessions.create(['pm'], '旧布局会话')
    const owner = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
    const owned = env.sessions.create(['pm'], '归属会话', { ownerId: owner.id })

    // 无属主 → 平面旧路径
    expect(env.workspace.resolveDir(legacySession.id)).toBe(path.join(env.cfg.workspaceDir, legacySession.id))
    // 有属主且两处目录都不存在 → 新嵌套路径
    const nested = path.join(env.cfg.workspaceDir, `u_${owner.id}`, owned.id)
    expect(env.workspace.resolveDir(owned.id)).toBe(nested)
    // 新布局目录建立后 → 新路径
    fs.mkdirSync(nested, { recursive: true })
    expect(env.workspace.resolveDir(owned.id)).toBe(nested)
    // 新布局缺失但旧平面目录存在（迁移前）→ 兼容回退旧路径
    const owned2 = env.sessions.create(['pm'], '归属会话2', { ownerId: owner.id })
    const legacy2 = path.join(env.cfg.workspaceDir, owned2.id)
    fs.mkdirSync(legacy2, { recursive: true })
    expect(env.workspace.resolveDir(owned2.id)).toBe(legacy2)
    // 显式 workspaceDir（repo / worktree 模式）优先
    const explicit = path.join(env.cfg.workspaceDir, 'explicit-dir')
    env.sessions.setWorkspace(owned.id, explicit)
    expect(env.workspace.resolveDir(owned.id)).toBe(explicit)
  })

  it('canvasFileFor：无属主 / 旧文件回退平面路径；有属主且新文件缺席 → 嵌套路径', () => {
    const env = makeEnv()
    const owner = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
    const owned = env.sessions.create(['pm'], '画布会话', { ownerId: owner.id })
    const legacyFile = path.join(env.cfg.dataDir, 'canvas', `${owned.id}.json`)
    const nestedFile = path.join(env.cfg.dataDir, 'canvas', `u_${owner.id}`, `${owned.id}.json`)

    // 两处都不存在 → 新嵌套路径（惰性创建）
    expect(env.workspace.canvasFileFor(owned.id)).toBe(nestedFile)
    // 旧平面文件存在而新文件不在 → 兼容回退
    writeFileUnder(path.join(env.cfg.dataDir, 'canvas'), `${owned.id}.json`, '{}')
    expect(env.workspace.canvasFileFor(owned.id)).toBe(legacyFile)
    // 新文件出现 → 新路径
    writeFileUnder(path.join(env.cfg.dataDir, 'canvas'), path.join(`u_${owner.id}`, `${owned.id}.json`), '{}')
    expect(env.workspace.canvasFileFor(owned.id)).toBe(nestedFile)
  })
})

describe('M57：ArtifactStore 与嵌套布局', () => {
  it('存读删：嵌套目录生效；repo / worktree 外部根拒绝删除', () => {
    const env = makeEnv()
    const owner = env.users.create({ username: 'carol', displayName: 'Carol', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '交付件会话', { ownerId: owner.id })

    const dir = env.artifacts.ensureSessionDir(session.id)
    expect(dir).toBe(path.join(env.cfg.workspaceDir, `u_${owner.id}`, session.id))
    fs.writeFileSync(path.join(dir, 'report.md'), '# hi', 'utf8')
    expect(env.artifacts.list(session.id).map((a) => a.path)).toContain('report.md')

    env.artifacts.removeSession(session.id)
    expect(fs.existsSync(dir)).toBe(false)

    // 外部挂载（显式 workspaceDir 指向 workspace 之外）→ removeSession 拒绝删除
    const outside = fs.mkdtempSync(path.join(env.cfg.dataDir, 'outside-'))
    writeFileUnder(outside, 'keep.txt')
    const external = env.sessions.create(['pm'], '外挂会话', { ownerId: owner.id, workspaceDir: outside })
    env.artifacts.removeSession(external.id)
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })
})

describe('M57：删除账号磁盘清理（purgeUser）', () => {
  it('清理 u_<uid> 整树 + 旧平面布局；其他用户目录保留', async () => {
    const env = makeEnv()
    const owner = env.users.create({ username: 'dave', displayName: 'Dave', passwordHash: 'x', role: 'member' })
    const other = env.users.create({ username: 'erin', displayName: 'Erin', passwordHash: 'x', role: 'member' })
    const s1 = env.sessions.create(['pm'], '嵌套会话', { ownerId: owner.id })
    const s2 = env.sessions.create(['pm'], '旧布局会话', { ownerId: owner.id })

    // 新布局：workspace/u_<uid>/s1 + canvas/u_<uid>/s1.json
    writeFileUnder(path.join(env.cfg.workspaceDir, `u_${owner.id}`, s1.id), 'a.md')
    writeFileUnder(path.join(env.cfg.dataDir, 'canvas'), path.join(`u_${owner.id}`, `${s1.id}.json`), '{}')
    // 旧布局：workspace/s2 + canvas/s2.json
    writeFileUnder(path.join(env.cfg.workspaceDir, s2.id), 'b.md')
    writeFileUnder(path.join(env.cfg.dataDir, 'canvas'), `${s2.id}.json`, '{}')
    // 其他用户：不动
    const otherFile = writeFileUnder(path.join(env.cfg.workspaceDir, `u_${other.id}`, 's_other'), 'keep.md')

    const warnings = await env.workspace.purgeUser(owner.id, [s1.id, s2.id])
    expect(warnings).toEqual([])
    expect(fs.existsSync(path.join(env.cfg.workspaceDir, `u_${owner.id}`))).toBe(false)
    expect(fs.existsSync(path.join(env.cfg.dataDir, 'canvas', `u_${owner.id}`))).toBe(false)
    expect(fs.existsSync(path.join(env.cfg.workspaceDir, s2.id))).toBe(false)
    expect(fs.existsSync(path.join(env.cfg.dataDir, 'canvas', `${s2.id}.json`))).toBe(false)
    expect(fs.existsSync(otherFile)).toBe(true)
  })
})

describe('M57：工作区布局搬迁脚本', () => {
  it('搬迁旧平面目录与画布；dry-run 不动文件；重复执行幂等', () => {
    const env = makeEnv()
    const owner = env.users.create({ username: 'frank', displayName: 'Frank', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '待搬迁会话', { ownerId: owner.id })

    const legacyDir = writeFileUnder(path.join(env.cfg.workspaceDir, session.id), 'notes.md', '# n')
    const legacyCanvas = writeFileUnder(path.join(env.cfg.dataDir, 'canvas'), `${session.id}.json`, '{"v":1}')

    // dry-run：只记录计划，不落盘
    const preview = migrateWorkspaceLayout(env.db, { workspaceDir: env.cfg.workspaceDir, dataDir: env.cfg.dataDir }, { dryRun: true })
    expect(preview.moved).toHaveLength(1)
    expect(preview.movedCanvas).toHaveLength(1)
    expect(fs.existsSync(legacyDir)).toBe(true)
    expect(fs.existsSync(legacyCanvas)).toBe(true)

    // 实际搬迁
    const run = migrateWorkspaceLayout(env.db, { workspaceDir: env.cfg.workspaceDir, dataDir: env.cfg.dataDir })
    expect(run.failed).toEqual([])
    expect(run.moved).toEqual([path.join(`u_${owner.id}`, session.id)])
    expect(run.movedCanvas).toEqual([path.join(`u_${owner.id}`, `${session.id}.json`)])
    expect(fs.existsSync(path.join(env.cfg.workspaceDir, `u_${owner.id}`, session.id, 'notes.md'))).toBe(true)
    expect(fs.existsSync(path.join(env.cfg.dataDir, 'canvas', `u_${owner.id}`, `${session.id}.json`))).toBe(true)
    expect(fs.existsSync(legacyDir)).toBe(false)

    // 重复执行：幂等（目标已存在 → 跳过）
    const again = migrateWorkspaceLayout(env.db, { workspaceDir: env.cfg.workspaceDir, dataDir: env.cfg.dataDir })
    expect(again.moved).toEqual([])
    expect(again.movedCanvas).toEqual([])
    // 搬迁后 resolver 命中新路径
    expect(env.workspace.resolveDir(session.id)).toBe(path.join(env.cfg.workspaceDir, `u_${owner.id}`, session.id))
  })
})
