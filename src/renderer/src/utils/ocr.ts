import type { ImageOcrSource } from '../../../shared/ipc'

export const OCR_AUTO_MAX_PIXELS = 1_500_000
export const OCR_AUTO_MAX_BYTES = 3 * 1024 * 1024

const OCR_MAX_SIDE = 2200
const OCR_MIN_CONFIDENCE = 18
const OCR_WORKER_PATH = 'ocr/worker.min.js'
const OCR_CORE_PATH = 'ocr/core'
const OCR_LANG_PATH = 'ocr/lang'

export interface OcrBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrToken {
  id: string
  text: string
  confidence: number
  bbox: OcrBox
  lineIndex: number
  wordIndex: number
  tokenIndex: number
}

export interface OcrLine {
  id: string
  text: string
  bbox: OcrBox
  tokenIds: string[]
  lineIndex: number
}

export interface OcrResult {
  text: string
  tokens: OcrToken[]
  lines: OcrLine[]
  scale: number
}

type ProgressListener = (progress: number, status: string) => void

interface TesseractLoggerMessage {
  progress: number
  status: string
}

interface TesseractBbox {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface TesseractSymbol {
  text: string
  confidence: number
  bbox: TesseractBbox
}

interface TesseractWord {
  text: string
  confidence: number
  bbox: TesseractBbox
  symbols?: TesseractSymbol[]
}

interface TesseractLine {
  text: string
  bbox: TesseractBbox
  words?: TesseractWord[]
}

interface TesseractParagraph {
  lines?: TesseractLine[]
}

interface TesseractBlock {
  paragraphs?: TesseractParagraph[]
}

interface TesseractPage {
  text?: string
  blocks?: TesseractBlock[] | null
}

interface TesseractRecognizeResult {
  data: TesseractPage
}

interface OcrWorker {
  recognize(
    image: Blob | HTMLCanvasElement,
    options?: Record<string, unknown>,
    output?: { text?: boolean; blocks?: boolean }
  ): Promise<TesseractRecognizeResult>
  setParameters(params: Record<string, string>): Promise<unknown>
}

interface TesseractModule {
  createWorker(
    langs?: string | string[],
    oem?: number,
    options?: Record<string, unknown>,
    config?: Record<string, string>
  ): Promise<OcrWorker>
}

const progressListeners = new Set<ProgressListener>()
const resultCache = new Map<string, OcrResult>()
let workerPromise: Promise<OcrWorker> | null = null

export function getCachedOcrResult(cacheKey: string): OcrResult | null {
  return resultCache.get(cacheKey) ?? null
}

export function isAutoOcrCandidate(width: number, height: number, bytes: number): boolean {
  return width * height <= OCR_AUTO_MAX_PIXELS && bytes <= OCR_AUTO_MAX_BYTES
}

export function getSelectedOcrText(tokens: OcrToken[], selectedIds: Set<string>): string {
  const selected = tokens
    .filter((token) => selectedIds.has(token.id))
    .sort((a, b) => a.lineIndex - b.lineIndex || a.tokenIndex - b.tokenIndex)
  if (selected.length === 0) return ''

  const lines: string[] = []
  let currentLine = selected[0].lineIndex
  let lineText = ''
  let previousToken: OcrToken | null = null

  for (const token of selected) {
    if (token.lineIndex !== currentLine) {
      if (lineText.trim()) lines.push(lineText.trim())
      currentLine = token.lineIndex
      lineText = ''
      previousToken = null
    }
    lineText += shouldInsertSpace(previousToken, token) ? ` ${token.text}` : token.text
    previousToken = token
  }
  if (lineText.trim()) lines.push(lineText.trim())
  return lines.join('\n')
}

export function getOcrResultText(result: OcrResult): string {
  const text = result.text.trim()
  if (text) return text
  return getSelectedOcrText(result.tokens, new Set(result.tokens.map((token) => token.id))).trim()
}

export async function recognizeImageText(params: {
  cacheKey: string
  source: ImageOcrSource
  naturalWidth: number
  naturalHeight: number
  onProgress: ProgressListener
}): Promise<OcrResult> {
  const cached = resultCache.get(params.cacheKey)
  if (cached) {
    params.onProgress(1, 'cached')
    return cached
  }

  progressListeners.add(params.onProgress)
  try {
    params.onProgress(0, 'preparing image')
    const sourceBlob = new Blob([params.source.bytes], { type: mimeFromName(params.source.name) })
    const prepared = await prepareImageForOcr(sourceBlob, params.naturalWidth, params.naturalHeight)
    const worker = await getWorker()
    params.onProgress(0.08, 'recognizing text')
    const recognized = await worker.recognize(prepared.blob, {}, { text: true, blocks: true })
    const result = normalizeOcrResult(recognized.data, prepared.scale)
    resultCache.set(params.cacheKey, result)
    params.onProgress(1, 'ready')
    return result
  } finally {
    progressListeners.delete(params.onProgress)
  }
}

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = loadTesseract().then(async (tesseract) => {
      const worker = await tesseract.createWorker(['chi_sim', 'eng'], 1, {
        workerPath: OCR_WORKER_PATH,
        corePath: OCR_CORE_PATH,
        langPath: OCR_LANG_PATH,
        workerBlobURL: false,
        cacheMethod: 'write',
        logger: (message: TesseractLoggerMessage): void => {
          const progress = normalizeProgress(message.progress, message.status)
          for (const listener of progressListeners) listener(progress, message.status)
        }
      })
      await worker.setParameters({
        tessedit_pageseg_mode: '11',
        preserve_interword_spaces: '1',
        user_defined_dpi: '150'
      })
      return worker
    })
  }
  return workerPromise
}

async function loadTesseract(): Promise<TesseractModule> {
  return (await import('tesseract.js')) as unknown as TesseractModule
}

async function prepareImageForOcr(
  blob: Blob,
  naturalWidth: number,
  naturalHeight: number
): Promise<{ blob: Blob; scale: number }> {
  const longestSide = Math.max(naturalWidth, naturalHeight)
  const scale = longestSide <= OCR_MAX_SIDE ? 1 : OCR_MAX_SIDE / longestSide
  const width = Math.max(1, Math.round(naturalWidth * scale))
  const height = Math.max(1, Math.round(naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('OCR 图片预处理失败')
  await drawBlobToCanvas(ctx, blob, width, height)
  const downscaled = await canvasToBlob(canvas)
  return { blob: downscaled, scale }
}

async function drawBlobToCanvas(
  ctx: CanvasRenderingContext2D,
  blob: Blob,
  width: number,
  height: number
): Promise<void> {
  try {
    const bitmap = await createImageBitmap(blob)
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    return
  } catch {
    const image = await loadBlobImage(blob)
    ctx.drawImage(image, 0, 0, width, height)
  }
}

function loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('OCR 图片解码失败'))
    }
    image.src = url
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('OCR 图片转换失败'))
    }, 'image/png')
  })
}

function normalizeOcrResult(page: TesseractPage, scale: number): OcrResult {
  const tokens: OcrToken[] = []
  const lines: OcrLine[] = []
  let lineIndex = 0
  let tokenIndex = 0

  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const lineTokens: string[] = []
        const lineId = `line-${lineIndex}`
        let wordIndex = 0
        for (const word of line.words ?? []) {
          const units = splitWordIntoTokens(word)
          for (const unit of units) {
            const text = normalizeText(unit.text)
            if (!text || unit.confidence < OCR_MIN_CONFIDENCE) continue
            const token: OcrToken = {
              id: `ocr-${tokenIndex}`,
              text,
              confidence: unit.confidence,
              bbox: scaleBox(unit.bbox, scale),
              lineIndex,
              wordIndex,
              tokenIndex
            }
            tokens.push(token)
            lineTokens.push(token.id)
            tokenIndex += 1
          }
          wordIndex += 1
        }
        if (lineTokens.length > 0) {
          lines.push({
            id: lineId,
            text: normalizeText(line.text),
            bbox: scaleBox(line.bbox, scale),
            tokenIds: lineTokens,
            lineIndex
          })
          lineIndex += 1
        }
      }
    }
  }

  return {
    text: normalizePageText(page.text, tokens),
    tokens,
    lines,
    scale
  }
}

function splitWordIntoTokens(word: TesseractWord): Array<{
  text: string
  confidence: number
  bbox: TesseractBbox
}> {
  const symbols = word.symbols ?? []
  if (symbols.length > 0) {
    return symbols.map((symbol) => ({
      text: symbol.text,
      confidence: symbol.confidence,
      bbox: symbol.bbox
    }))
  }
  return [{ text: word.text, confidence: word.confidence, bbox: word.bbox }]
}

function scaleBox(box: TesseractBbox, scale: number): OcrBox {
  const divisor = scale > 0 ? scale : 1
  return {
    x0: box.x0 / divisor,
    y0: box.y0 / divisor,
    x1: box.x1 / divisor,
    y1: box.y1 / divisor
  }
}

function normalizeText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function normalizePageText(text: string | undefined, tokens: OcrToken[]): string {
  const cleaned = (text ?? '').trim()
  if (cleaned) return cleaned
  return getSelectedOcrText(tokens, new Set(tokens.map((token) => token.id)))
}

function shouldInsertSpace(previous: OcrToken | null, next: OcrToken): boolean {
  if (!previous || !next) return false
  if (previous.wordIndex === next.wordIndex) return false
  return /[A-Za-z0-9]$/.test(previous.text) && /^[A-Za-z0-9]/.test(next.text)
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'image/png'
}

function normalizeProgress(progress: number, status: string): number {
  const safe = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
  if (status.includes('loading')) return Math.max(0.05, safe * 0.25)
  if (status.includes('initializing')) return Math.max(0.1, Math.min(0.35, safe * 0.35))
  if (status.includes('recognizing')) return 0.35 + safe * 0.6
  return safe
}
