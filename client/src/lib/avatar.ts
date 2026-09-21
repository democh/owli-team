/**
 * M79-Q：真人图片头像——客户端裁剪工具（设计：上传前本地裁剪，控制体积与形状）。
 *
 * - 居中正方形裁剪 + 缩放到 `size`（默认 256²）；
 * - 输出 WebP（质量 0.9）；浏览器不支持 `toBlob('image/webp')` 时回退 PNG；
 * - 解码失败抛出可读错误（由调用方 toast 透出）。
 */
export const AVATAR_IMAGE_SIZE = 256

export async function cropSquareImage(file: File, size = AVATAR_IMAGE_SIZE): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('图片解析失败：请换一张 PNG / JPEG / WebP 图片')
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const sx = Math.floor((bitmap.width - side) / 2)
    const sy = Math.floor((bitmap.height - side) / 2)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器不支持画布裁剪：请更换浏览器后重试')
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size)
    const webp = await blobOf(canvas, 'image/webp', 0.9)
    if (webp) return webp
    const png = await blobOf(canvas, 'image/png')
    if (!png) throw new Error('头像导出失败：请更换浏览器后重试')
    return png
  } finally {
    bitmap.close()
  }
}

function blobOf(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      // 浏览器不支持目标格式时 toBlob 会回退为 PNG 类型 blob（仍可用——服务端按魔数识别）
      canvas.toBlob((blob) => resolve(blob), type, quality)
    } catch {
      resolve(null)
    }
  })
}
