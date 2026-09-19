/**
 * 最小 ZIP 读取器（M24）：仅服务于 Office 交付件预览（docx / xlsx / pptx 均为 zip 容器）。
 *
 * - 零依赖：中央目录定位 + `node:zlib` inflateRaw 解压（stored / deflate 两种方式）；
 * - 按需解出：只解调用方关心的条目（`wanted` 谓词），不整包解压；
 * - 防护：zip64 / 未知压缩方式 / 条目越界 / 解压体积上限（防 zip 炸弹）一律报错。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_MARK = 0xffffffff
/** 单条目解压上限（Office 文档单条 XML 极少接近该量级） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export function readZipEntries(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const eocd = findEocd(buf)
  if (eocd === undefined) throw new Error('不是有效的 ZIP 容器')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen
    if (!wanted(name)) continue
    out.set(name, readEntry(buf, name, localOffset, method, compressedSize))
  }
  return out
}

/** 从尾部向前扫描 EOCD（最多 22 + 64KB 注释） */
function findEocd(buf: Buffer): number | undefined {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return undefined
}

function readEntry(
  buf: Buffer,
  name: string,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  if (compressedSize === ZIP64_MARK) throw new Error(`不支持 ZIP64 条目：${name}`)
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
    throw new Error(`ZIP 条目头损坏：${name}`)
  }
  const nameLen = buf.readUInt16LE(localOffset + 26)
  const extraLen = buf.readUInt16LE(localOffset + 28)
  const start = localOffset + 30 + nameLen + extraLen
  const end = start + compressedSize
  if (end > buf.length) throw new Error(`ZIP 条目越界：${name}`)
  const data = buf.subarray(start, end)
  if (method === 0) {
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`ZIP 条目超过解压上限：${name}`)
    return Buffer.from(data)
  }
  if (method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })
    } catch {
      throw new Error(`ZIP 条目解压失败：${name}`)
    }
  }
  throw new Error(`不支持的 ZIP 压缩方式（${method}）：${name}`)
}
