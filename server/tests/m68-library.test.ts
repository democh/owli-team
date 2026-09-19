/**
 * M68 单测：用户素材库（MaterialStore + LibraryService）——
 * - Store：属主隔离（get/remove 非属主 undefined）/ 列表过滤（query / kind / 新→旧）/ 容量统计 / removeOf；
 * - Service：上传（白名单 / 空 / 正常落盘 + 建行）/ 删除双清（行 + 文件）/ 内容解析 / copy-on-use 入仓 / 账号级联；
 * - 配额闸门：注入的 assertUserStorage 抛错 → upload 返回引导文案（不落盘）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config.js'
import { LibraryService } from '../src/library/service.js'
import { MaterialStore } from '../src/store/materials.js'
import { openDatabase } from '../src/store/db.js'
import { HttpError } from '../src/util/http-error.js'
import { makeTmpDir } from './helpers.js'

function makeEnv() {
  const dir = makeTmpDir('ma-m68-library-')
  const db = openDatabase(path.join(dir, 'app.db'))
  const materials = new MaterialStore(db)
  const cfg = { workspaceDir: path.join(dir, 'workspace'), dataDir: path.join(dir, 'data') } as AppConfig
  const service = new LibraryService({ cfg, materials })
  return { dir, db, materials, service, workspaceDir: cfg.workspaceDir }
}

/** 1x1 PNG 字节（上传夹具） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('M68 MaterialStore：属主隔离与列表', () => {
  it('insert / get：非属主取不到（不泄漏存在性）；列表按新→旧 + query / kind 过滤', () => {
    const { materials } = makeEnv()
    const a = materials.insert({
      id: 'mat_a',
      ownerId: 'u1',
      name: '猫咪图.png',
      kind: 'image',
      ext: '.png',
      sizeBytes: 10,
      relPath: 'u_u1/mat_a.png',
      source: 'upload',
      createdAt: '2026-09-19T08:00:00.000Z',
    })
    materials.insert({
      id: 'mat_b',
      ownerId: 'u1',
      name: '演示视频.mp4',
      kind: 'video',
      ext: '.mp4',
      sizeBytes: 20,
      relPath: 'u_u1/mat_b.mp4',
      source: 'upload',
      createdAt: '2026-09-19T09:00:00.000Z',
    })
    materials.insert({
      id: 'mat_c',
      ownerId: 'u2',
      name: '别人的.png',
      kind: 'image',
      ext: '.png',
      sizeBytes: 30,
      relPath: 'u_u2/mat_c.png',
      source: 'upload',
    })

    expect(materials.get('u1', 'mat_a')?.name).toBe(a.name)
    expect(materials.get('u2', 'mat_a')).toBeUndefined() // 非属主
    expect(materials.remove('u2', 'mat_a')).toBeUndefined() // 非属主删除失败
    expect(materials.get('u1', 'mat_a')).toBeDefined()

    // 新→旧
    expect(materials.list('u1').map((x) => x.id)).toEqual(['mat_b', 'mat_a'])
    // query（子串）
    expect(materials.list('u1', { query: '猫咪' }).map((x) => x.id)).toEqual(['mat_a'])
    // kind
    expect(materials.list('u1', { kind: 'video' }).map((x) => x.id)).toEqual(['mat_b'])
    // 属主隔离
    expect(materials.list('u2').map((x) => x.id)).toEqual(['mat_c'])
    // 容量
    expect(materials.countOf('u1')).toBe(2)
    expect(materials.bytesOf('u1')).toBe(30)
  })

  it('insert：audio 种类回读不归并（kind 映射保留 audio）', () => {
    const { materials } = makeEnv()
    materials.insert({ id: 'mat_au', ownerId: 'u1', name: '配乐.mp3', kind: 'audio', ext: '.mp3', sizeBytes: 5, relPath: 'u_u1/mat_au.mp3', source: 'upload' })
    expect(materials.get('u1', 'mat_au')?.kind).toBe('audio')
    expect(materials.list('u1', { kind: 'audio' }).map((x) => x.id)).toEqual(['mat_au'])
  })

  it('removeOf：批量删除返回全部行（供文件清理）', () => {
    const { materials } = makeEnv()
    materials.insert({ id: 'mat_1', ownerId: 'u1', name: 'a.png', kind: 'image', ext: '.png', sizeBytes: 1, relPath: 'u_u1/mat_1.png', source: 'upload' })
    materials.insert({ id: 'mat_2', ownerId: 'u1', name: 'b.png', kind: 'image', ext: '.png', sizeBytes: 1, relPath: 'u_u1/mat_2.png', source: 'upload' })
    const removed = materials.removeOf('u1')
    expect(removed.map((x) => x.id).sort()).toEqual(['mat_1', 'mat_2'])
    expect(materials.countOf('u1')).toBe(0)
  })
})

describe('M68 LibraryService：上传 / 删除双清 / 入仓 / 级联', () => {
  it('upload：正常落盘 + 建行（owner 段目录 u_<uid>；原文件名安全化）', () => {
    const { service, materials, workspaceDir } = makeEnv()
    const res = service.upload('user-1', { name: '素材 图/../x.png', buffer: PNG })
    expect('error' in res).toBe(false)
    const record = res as Exclude<typeof res, { error: string }>
    expect(record.ownerId).toBe('user-1')
    expect(record.kind).toBe('image')
    expect(record.relPath.startsWith('u_user-1/')).toBe(true)
    expect(record.name).not.toContain('/') // 路径字符安全化
    expect(fs.existsSync(path.join(workspaceDir, '_library', record.relPath))).toBe(true)
    expect(materials.countOf('user-1')).toBe(1)
  })

  it('upload：白名单 / 空内容 / 超大 拒绝（不落盘不建行）', () => {
    const { service, materials } = makeEnv()
    expect(service.upload('u', { name: 'evil.exe', buffer: PNG })).toEqual({ error: expect.stringContaining('不支持的文件类型') })
    expect(service.upload('u', { name: 'a.png', buffer: Buffer.alloc(0) })).toEqual({ error: expect.stringContaining('为空') })
    expect(service.upload('u', { name: 'a.png', buffer: Buffer.alloc(201 * 1024 * 1024) })).toEqual({
      error: expect.stringContaining('200MB'),
    })
    expect(materials.countOf('u')).toBe(0)
  })

  it('upload：音频白名单入库（kind=audio；mp3 落盘 + 建行）', () => {
    const { service, materials, workspaceDir } = makeEnv()
    const res = service.upload('u', { name: 'SoundHelix-Song-1.mp3', buffer: PNG })
    expect('error' in res).toBe(false)
    const record = res as Exclude<typeof res, { error: string }>
    expect(record.kind).toBe('audio')
    expect(record.mime).toBe('audio/mpeg')
    expect(fs.existsSync(path.join(workspaceDir, '_library', record.relPath))).toBe(true)
    expect(materials.countOf('u')).toBe(1)
  })

  it('upload：配额闸门拒绝 → 透出引导文案（不落盘）', () => {
    const dir = makeTmpDir('ma-m68-quota-')
    const db = openDatabase(path.join(dir, 'app.db'))
    const materials = new MaterialStore(db)
    const service = new LibraryService({
      cfg: { workspaceDir: path.join(dir, 'workspace'), dataDir: path.join(dir, 'data') } as AppConfig,
      materials,
      assertUserStorage: () => {
        throw new HttpError(403, '存储空间不足（已用 99 MB / 上限 100 MB）：请删除不再使用的会话或文件，或联系管理员调整配额')
      },
    })
    const res = service.upload('u', { name: 'a.png', buffer: PNG })
    expect(res).toEqual({ error: expect.stringContaining('存储空间不足') })
    expect(materials.countOf('u')).toBe(0)
  })

  it('remove：行 + 文件双清；contentOf 在删除后不可解析', () => {
    const { service, materials, workspaceDir } = makeEnv()
    const record = service.upload('u', { name: 'a.png', buffer: PNG }) as Exclude<ReturnType<LibraryService['upload']>, { error: string }>
    const abs = path.join(workspaceDir, '_library', record.relPath)
    expect(service.contentOf('u', record.id)?.abs).toBe(abs)

    expect(service.remove('other', record.id)).toBe(false) // 非属主
    expect(service.remove('u', record.id)).toBe(true)
    expect(materials.get('u', record.id)).toBeUndefined()
    expect(fs.existsSync(abs)).toBe(false)
    expect(service.contentOf('u', record.id)).toBeUndefined()
  })

  it('toSession：copy-on-use 入仓（拷贝到会话工作区 library/ref-*；源素材保留）', () => {
    const { service, workspaceDir, materials } = makeEnv()
    const record = service.upload('u', { name: 'b.png', buffer: PNG }) as Exclude<ReturnType<LibraryService['upload']>, { error: string }>
    const sessionDir = path.join(workspaceDir, 's_demo')
    fs.mkdirSync(sessionDir, { recursive: true })
    const svc = new LibraryService({
      cfg: { workspaceDir, dataDir: path.join(workspaceDir, '..', 'data') } as AppConfig,
      materials,
    })
    const res = svc.toSession('u', record.id, 's_demo')
    // 未注入 sessionDirOf → 会话工作区不可用
    expect(res).toEqual({ error: '会话工作区不可用' })

    const svc2 = new LibraryService({
      cfg: { workspaceDir, dataDir: path.join(workspaceDir, '..', 'data') } as AppConfig,
      materials,
      sessionDirOf: (sid) => path.join(workspaceDir, sid),
      canAccessSession: (uid, sid) => uid === 'u' && sid === 's_demo',
    })
    const ok = svc2.toSession('u', record.id, 's_demo')
    expect('error' in ok).toBe(false)
    const copied = ok as { path: string; kind: string }
    expect(copied.kind).toBe('image')
    expect(copied.path.startsWith('library/ref-')).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, copied.path))).toBe(true)
    // 源仍在（拷贝非搬移）；非授权会话拒绝
    expect(fs.existsSync(path.join(workspaceDir, '_library', record.relPath))).toBe(true)
    expect(svc2.toSession('u', record.id, 's_other')).toEqual({ error: '会话不存在或无权访问' })
  })

  it('removeOf：账号级联清空行 + 属主目录', () => {
    const { service, materials, workspaceDir } = makeEnv()
    service.upload('u1', { name: 'a.png', buffer: PNG })
    service.upload('u1', { name: 'b.png', buffer: PNG })
    service.upload('u2', { name: 'c.png', buffer: PNG })
    const n = service.removeOf('u1')
    expect(n).toBe(2)
    expect(materials.countOf('u1')).toBe(0)
    expect(materials.countOf('u2')).toBe(1) // 他人不受影响
    expect(fs.existsSync(path.join(workspaceDir, '_library', 'u_u1'))).toBe(false)
    expect(fs.existsSync(path.join(workspaceDir, '_library', 'u_u2'))).toBe(true)
  })
})
