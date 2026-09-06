import type { OcrLine } from './ocr'

export interface ImageTextLineLayout {
  key: number
  text: string
  style: Record<string, string>
}

// 固定测量字号仅用于取得原生文字盒，显示尺寸由 OCR 行框及双轴缩放决定。
export const IMAGE_TEXT_MEASURE_SIZE = 16

export interface ImageTextLineBox {
  key: number
  text: string
  left: number
  top: number
  width: number
  height: number
}

export interface ImageTextMetrics {
  width: number
  height: number
  offsetX: number
  offsetY: number
}

/** 与主进程 OCR 缓存的行数、单行文本边界一致，不拆字或截断识别文字。 */
export function getImageTextLineBoxes(
  lines: readonly OcrLine[],
  width: number,
  height: number
): ImageTextLineBox[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || lines.length > 5000) {
    return []
  }
  return lines
    .map((line, key) => ({ line, key }))
    .filter(({ line }) => {
      const { x0, y0, x1, y1 } = line.bbox
      return line.text.length > 0 && line.text.length <= 2000 &&
        Number.isSafeInteger(line.lineIndex) && line.lineIndex >= 0 &&
        [x0, y0, x1, y1].every(Number.isFinite) &&
        x1 > x0 && y1 > y0 && x0 < width && y0 < height && x1 > 0 && y1 > 0
    })
    .sort((a, b) => a.line.lineIndex - b.line.lineIndex)
    .map(({ line, key }) => {
      const { x0, y0, x1, y1 } = line.bbox
      const left = Math.max(0, x0)
      const top = Math.max(0, y0)
      return {
        key,
        text: line.text,
        left,
        top,
        width: Math.min(width, x1) - left,
        height: Math.min(height, y1) - top
      }
    })
}

export function layoutImageTextLines(
  lines: readonly ImageTextLineBox[],
  measure: (line: ImageTextLineBox) => ImageTextMetrics | undefined
): ImageTextLineLayout[] {
  return lines.flatMap((line) => {
    const metrics = measure(line)
    if (!metrics || !Object.values(metrics).every(Number.isFinite) || metrics.width <= 0 || metrics.height <= 0) return []
    const scaleX = line.width / metrics.width
    const scaleY = line.height / metrics.height
    // 行高从测量基准改成真实文字盒高度后，基线随半行距移动；一并补偿原生选区偏移。
    const offsetY = metrics.offsetY + (metrics.height - IMAGE_TEXT_MEASURE_SIZE) / 2
    // ponytail: 按整行拟合字位；特殊排版需要精确字位时再扩展 OCR 字符坐标。
    return [{
      key: line.key,
      text: line.text,
      style: {
        left: `${line.left - metrics.offsetX * scaleX}px`,
        top: `${line.top - offsetY * scaleY}px`,
        width: `${metrics.width}px`,
        height: `${metrics.height}px`,
        fontSize: `${IMAGE_TEXT_MEASURE_SIZE}px`,
        lineHeight: `${metrics.height}px`,
        transform: `scale(${scaleX}, ${scaleY})`
      }
    }]
  })
}
