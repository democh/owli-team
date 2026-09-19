/**
 * M33：图片尺寸探测（零依赖，仅读文件头）——PNG / JPEG / GIF / WebP / BMP。
 *
 * 用途：附件上传时记录像素尺寸（前端缩略图布局防跳变、视频/图片卡片展示、
 * 视觉注入护栏的尺寸校验）。解析失败返回 undefined（不抛错，调用方回退）。
 * 不支持：AVIF / HEIC / TIFF（ISO BMFF / 复杂结构，收益低）与 SVG（文本格式）。
 */

export interface ImageSize {
  width: number
  height: number
}

/** PNG：8 字节签名 + IHDR（宽高为大端 4 字节，偏移 16 / 20） */
function probePng(buf: Buffer): ImageSize | undefined {
  if (buf.length < 24) return undefined
  if (buf.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** JPEG：扫描 SOFn 段（0xFFC0-0xFFCF，排除 C4/C8/CC）；段内高 2 字节、宽 2 字节（大端） */
function probeJpeg(buf: Buffer): ImageSize | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    // 段长度（大端，含自身 2 字节）
    const len = buf.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof && len >= 7) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    // SOS（0xDA）之后是熵编码数据，不再有尺寸段
    if (marker === 0xda) break
    i += 2 + len
  }
  return undefined
}

/** GIF：header + 逻辑屏幕宽高（小端 2 字节，偏移 6 / 8） */
function probeGif(buf: Buffer): ImageSize | undefined {
  if (buf.length < 10) return undefined
  const sig = buf.toString('ascii', 0, 6)
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/** WebP：RIFF 容器，按 VP8X / VP8 / VP8L 三种变体读取 */
function probeWebp(buf: Buffer): ImageSize | undefined {
  if (buf.length < 30) return undefined
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const fourcc = buf.toString('ascii', 12, 16)
  if (fourcc === 'VP8X') {
    // 画布宽高：3 字节小端（值 = 实际 - 1），偏移 24 / 27
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  }
  if (fourcc === 'VP8 ') {
    // 帧标签：0x9D 0x01 0x2A 之后宽高各 2 字节（14 位有效），偏移 26 / 28
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    // 签名 0x2F 后 28 位：14 位宽、14 位高（均 +1），偏移 21 起
    if (buf[20] !== 0x2f) return undefined
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return undefined
}

/** BMP：BITMAPINFOHEADER 宽/高（小端 4 字节有符号，偏移 18 / 22；高度可能为负 = 顶行优先） */
function probeBmp(buf: Buffer): ImageSize | undefined {
  if (buf.length < 26) return undefined
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return undefined
  return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
}

/** 按签名分派探测；未识别 / 损坏返回 undefined */
export function probeImageSize(buf: Buffer): ImageSize | undefined {
  const probes = [probePng, probeJpeg, probeGif, probeWebp, probeBmp]
  for (const probe of probes) {
    try {
      const size = probe(buf)
      if (size && size.width > 0 && size.height > 0) return size
    } catch {
      // 截断 / 结构损坏：尝试下一个探测器
    }
  }
  return undefined
}
