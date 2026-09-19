import fs from 'node:fs'
import path from 'node:path'
import type { Artifact, ArtifactKind } from '@multi-agent/shared'
import { ensureDir, resolveInRoot } from '../util/paths.js'

// ---------- M24：类型分类（渲染器选择依据） ----------

const MARKDOWN_EXT = new Set(['.md', '.markdown'])
const HTML_EXT = new Set(['.html', '.htm'])
const CHART_EXT = new Set(['.mmd', '.mermaid'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif', '.bmp', '.tiff', '.tif'])
/** M31：视频（画布媒体创作产物 / 上传素材；ArtifactsView 直出 <video>） */
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v'])
const OFFICE_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'])
const PDF_EXT = new Set(['.pdf'])
/** 结构化表格数据（前端解析为表格） */
const DATA_EXT = new Set(['.csv', '.tsv'])
/** 源码 / 配置 / 文本（shiki 高亮；白名单外回退纯文本） */
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonl', '.jsonc',
  '.css', '.scss', '.less',
  '.py', '.go', '.java', '.rs', '.sh', '.bash', '.zsh', '.sql', '.vue', '.svelte',
  '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.properties',
  '.xml', '.xsl', '.xslt',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php', '.rb', '.kt', '.kts', '.swift', '.lua', '.dart',
  '.gradle', '.tex', '.proto', '.graphql', '.gql', '.prisma',
  '.bat', '.cmd', '.ps1',
  '.txt', '.log', '.text',
])
/** 无扩展名构建文件（按 basename 归 code） */
const CODE_BASENAME = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile'])
/** 二进制 / 压缩 / 媒体扩展：read() 绝不按 utf8 读取（office / pdf / zip / 字体 / 音视频…） */
const BINARY_EXT = new Set([
  ...OFFICE_EXT,
  ...PDF_EXT,
  // M33：白名单内但不在 office/code 集的二进制格式（避免误按 utf8 内联 / JSON 包裹）
  '.odt', '.ods', '.odp',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.ttc',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.mp4', '.m4v', '.mov', '.avi', '.webm', '.mkv',
  '.exe', '.dll', '.dylib', '.so', '.bin', '.wasm', '.class', '.jar', '.pyc',
  '.sqlite', '.db', '.dat', '.psd', '.sketch',
])
/** 二进制图片（svg 为文本，可内联复制源码） */
const BINARY_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.bmp', '.tiff', '.tif'])

function baseName(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase()
}

export function classifyKind(filePath: string): ArtifactKind {
  const ext = path.extname(filePath).toLowerCase()
  const base = baseName(filePath)
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  // 约定优于配置：*.chart.json = echarts 图表配置（普通 .json 仍为 code）
  if (base.endsWith('.chart.json')) return 'chart'
  if (HTML_EXT.has(ext)) return 'html'
  if (CHART_EXT.has(ext)) return 'chart'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (OFFICE_EXT.has(ext)) return 'office'
  if (PDF_EXT.has(ext)) return 'pdf'
  if (DATA_EXT.has(ext)) return 'data'
  if (CODE_EXT.has(ext) || CODE_BASENAME.has(base) || base === '.env' || base.startsWith('.env.')) return 'code'
  return 'other'
}

export function isBinaryExt(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_IMAGE_EXT.has(ext) || BINARY_EXT.has(ext)
}

/**
 * 交付件存储：workspace/<sessionId>/ 以磁盘为唯一真相（§22）。
 *
 * M6：支持注入会话工作区解析器（override）——repo / worktree 模式下会话工作区根
 * 由 `sessions.workspace_dir` 决定（WorkspaceService.dirFor），不再固定为 workspace/<sid>。
 */
export class ArtifactStore {
  /** sessionId:path -> agentId（内存态作者标记，重启后丢描述字段但不丢文件） */
  private authors = new Map<string, string>()

  constructor(
    private readonly root: string,
    /** 会话工作区根解析器（返回 undefined 时回退 sandbox 路径 workspace/<sid>） */
    private readonly override?: (sessionId: string) => string | undefined,
  ) {
    ensureDir(this.root)
  }

  /** 只读路径：仅拼接路径，不创建目录（修复读写混用导致的副作用） */
  sessionDir(sessionId: string): string {
    return this.override?.(sessionId) ?? path.join(this.root, sessionId)
  }

  /** 写入路径：工具在工作区内落地文件前调用 */
  ensureSessionDir(sessionId: string): string {
    const dir = this.sessionDir(sessionId)
    ensureDir(dir)
    return dir
  }

  resolveSafe(sessionId: string, relPath: string): string {
    const dir = this.sessionDir(sessionId)
    if (!fs.existsSync(dir)) throw new Error('会话工作区不存在')
    return resolveInRoot(dir, relPath)
  }

  markAuthor(sessionId: string, relPath: string, agentId: string): void {
    this.authors.set(`${sessionId}:${relPath}`, agentId)
  }

  authorOf(sessionId: string, relPath: string): string | undefined {
    return this.authors.get(`${sessionId}:${relPath}`)
  }

  list(sessionId: string): Artifact[] {
    const dir = this.sessionDir(sessionId)
    if (!fs.existsSync(dir)) return []
    const out: Artifact[] = []
    const walk = (current: string, depth: number): void => {
      if (depth > 6 || out.length > 500) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
        } else if (entry.isFile()) {
          const stat = fs.statSync(full)
          const rel = path.relative(dir, full).split(path.sep).join('/')
          out.push({
            path: rel,
            size: stat.size,
            mtime: stat.mtimeMs,
            kind: classifyKind(rel),
            authorAgentId: this.authorOf(sessionId, rel),
            updatedAt: new Date(stat.mtimeMs).toISOString(),
          })
        }
      }
    }
    walk(dir, 0)
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  read(
    sessionId: string,
    relPath: string,
    maxBytes: number,
  ): { fullPath: string; size: number; binary: boolean; content?: string; truncated?: boolean } {
    const fullPath = this.resolveSafe(sessionId, relPath)
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error('交付件不存在')
    }
    const size = fs.statSync(fullPath).size
    const binary = isBinaryExt(fullPath)
    if (binary || size > maxBytes) {
      return { fullPath, size, binary }
    }
    return { fullPath, size, binary, content: fs.readFileSync(fullPath, 'utf8'), truncated: false }
  }

  removeSession(sessionId: string): void {
    const dir = path.join(this.root, sessionId)
    // 仅删除 workspace 根下的会话目录
    const rootReal = fs.realpathSync(this.root)
    if (!path.resolve(dir).startsWith(rootReal + path.sep)) return
    fs.rmSync(dir, { recursive: true, force: true })
    for (const key of [...this.authors.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.authors.delete(key)
    }
  }
}
