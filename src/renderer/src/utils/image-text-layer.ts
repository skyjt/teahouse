import type { OcrLine } from './ocr'

export interface ImageTextLineLayout {
  key: number
  text: string
  style: Record<string, string>
}

/** 与主进程 OCR 缓存的行数、单行文本边界一致，不拆字或截断识别文字。 */
export function layoutImageTextLines(
  lines: readonly OcrLine[],
  width: number,
  height: number,
  measure: (text: string, fontSize: number) => number
): ImageTextLineLayout[] {
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
    .flatMap(({ line, key }) => {
      const { x0, y0, x1, y1 } = line.bbox
      const left = Math.max(0, x0)
      const top = Math.max(0, y0)
      const lineWidth = Math.min(width, x1) - left
      const lineHeight = Math.min(height, y1) - top
      // 字号来自原图检测框，属于图像坐标，不使用界面字号 token。
      // ponytail: 按整行系统字体拟合字位；特殊排版需要精确字位时再扩展 OCR 字符坐标。
      const textWidth = measure(line.text, lineHeight)
      if (!Number.isFinite(textWidth) || textWidth <= 0) return []
      return [{
        key,
        text: line.text,
        style: {
          left: `${left}px`,
          top: `${top}px`,
          width: `${textWidth}px`,
          height: `${lineHeight}px`,
          fontSize: `${lineHeight}px`,
          lineHeight: `${lineHeight}px`,
          transform: `scaleX(${lineWidth / textWidth})`
        }
      }]
    })
}
