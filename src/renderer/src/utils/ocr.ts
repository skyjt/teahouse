import type { ImageOcrSource } from '../../../shared/ipc'
import { BoundedLruCache } from './bounded-cache'

// 超大图先降采样：省内存、提速；PaddleOCR 检测内部还会缩到 960，识别用此分辨率裁剪。
const OCR_MAX_SIDE = 2200

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

interface PreparedImage {
  width: number
  height: number
  data: Uint8Array
  scale: number
}

const resultCache = new BoundedLruCache<string, OcrResult>(16)
export interface OcrWorkerRequest {
  id: number
  assetBase: string
  image: PreparedImage
}

export type OcrWorkerResponse =
  | { type: 'progress'; id: number; progress: number; status: string }
  | { type: 'result'; id: number; result: OcrResult }
  | { type: 'error'; id: number }

interface RecognitionTask {
  id: number
  cacheKey: string
  onProgress: ProgressListener
  resolve: (result: OcrResult) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let workerBusy = false
let activeTask: RecognitionTask | null = null
let preparingImage: Promise<PreparedImage> | null = null
let nextTaskId = 0

export function getCachedOcrResult(cacheKey: string): OcrResult | null {
  return resultCache.get(cacheKey) ?? null
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

export function recognizeImageText(params: {
  cacheKey: string
  source: ImageOcrSource
  naturalWidth: number
  naturalHeight: number
  onProgress: ProgressListener
}): Promise<OcrResult> {
  if (activeTask) return Promise.reject(new Error('正在识别其他图片'))
  const cached = resultCache.get(params.cacheKey)
  if (cached?.text.trim()) {
    params.onProgress(1, 'cached')
    return Promise.resolve(cached)
  }

  // 从异步解码之前占住唯一任务，重复点击不能堆积图片或模型任务。
  return new Promise((resolve, reject) => {
    const task: RecognitionTask = { id: ++nextTaskId, cacheKey: params.cacheKey, onProgress: params.onProgress, resolve, reject }
    activeTask = task
    void (async () => {
      params.onProgress(0, 'preparing image')
      // 原生位图解码无法中断，取消后仍占住预处理槽，下一张等其释放。
      if (preparingImage) await preparingImage.catch(() => {})
      if (activeTask !== task) return
      const preparation = prepareImageForOcr(
        params.source.bytes, params.source.name, params.naturalWidth, params.naturalHeight,
        () => activeTask !== task
      )
      preparingImage = preparation
      let prepared: PreparedImage
      try {
        prepared = await preparation
      } finally {
        if (preparingImage === preparation) preparingImage = null
      }
      if (activeTask !== task) return
      const instance = getWorker()
      workerBusy = true
      const request: OcrWorkerRequest = {
        id: task.id,
        assetBase: new URL('ocr/', document.baseURI).href,
        image: prepared
      }
      instance.postMessage(request, [prepared.data.buffer])
    })().catch((error: unknown) => {
      if (activeTask !== task) return
      stopWorker()
      activeTask = null
      task.reject(error instanceof Error ? error : new Error('OCR 识别失败'))
    })
  })
}

export function cancelImageTextRecognition(): void {
  const task = activeTask
  if (!task) return
  activeTask = null
  // 解码阶段可保留上一张已闲置的模型；推理中的 Worker 必须终止。
  if (workerBusy) stopWorker()
  task.reject(new DOMException('图片文字识别已取消', 'AbortError'))
}

export function disposeImageTextRecognition(): void {
  cancelImageTextRecognition()
  stopWorker()
}

function stopWorker(): void {
  worker?.terminate()
  worker = null
  workerBusy = false
}

function getWorker(): Worker {
  if (worker) return worker
  // Vite 构建为同源独立文件，不使用 Blob，不需要放宽 worker-src。
  const instance = new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module' })
  worker = instance
  instance.onmessage = ({ data }: MessageEvent<OcrWorkerResponse>) => {
    const task = activeTask
    if (worker !== instance || !task || data.id !== task.id) return
    if (data.type === 'progress') {
      task.onProgress(data.progress, data.status)
      return
    }
    workerBusy = false
    activeTask = null
    if (data.type === 'result') {
      if (data.result.text.trim()) resultCache.set(task.cacheKey, data.result)
      task.onProgress(1, 'ready')
      task.resolve(data.result)
    } else {
      stopWorker()
      task.reject(new Error('OCR 识别失败'))
    }
  }
  instance.onerror = instance.onmessageerror = () => {
    if (worker !== instance) return
    stopWorker()
    const task = activeTask
    activeTask = null
    task?.reject(new Error('OCR 识别失败'))
  }
  return instance
}

async function prepareImageForOcr(
  bytes: ArrayBuffer,
  name: string,
  naturalWidth: number,
  naturalHeight: number,
  cancelled: () => boolean
): Promise<PreparedImage> {
  const blob = new Blob([bytes], { type: mimeFromName(name) })
  const { source, width: natW, height: natH } = await decodeImage(blob, naturalWidth, naturalHeight, cancelled)
  if (cancelled()) {
    if (source instanceof ImageBitmap) source.close()
    throw new DOMException('图片文字识别已取消', 'AbortError')
  }
  const longestSide = Math.max(natW, natH) || 1
  const scale = longestSide <= OCR_MAX_SIDE ? 1 : OCR_MAX_SIDE / longestSide
  const width = Math.max(1, Math.round(natW * scale))
  const height = Math.max(1, Math.round(natH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) {
    if (source instanceof ImageBitmap) source.close()
    throw new Error('OCR 图片预处理失败')
  }
  try {
    ctx.drawImage(source, 0, 0, width, height)
    const imageData = ctx.getImageData(0, 0, width, height)
    return { width, height, data: new Uint8Array(imageData.data.buffer), scale }
  } finally {
    if (source instanceof ImageBitmap) source.close()
    canvas.width = canvas.height = 0
  }
}

async function decodeImage(
  blob: Blob,
  fallbackWidth: number,
  fallbackHeight: number,
  cancelled: () => boolean
): Promise<{ source: ImageBitmap | HTMLImageElement; width: number; height: number }> {
  try {
    const scale = Math.min(1, OCR_MAX_SIDE / Math.max(fallbackWidth, fallbackHeight))
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(fallbackWidth * scale)),
      resizeHeight: Math.max(1, Math.round(fallbackHeight * scale)),
      resizeQuality: 'high'
    })
    return { source: bitmap, width: fallbackWidth, height: fallbackHeight }
  } catch {
    if (cancelled()) throw new DOMException('图片文字识别已取消', 'AbortError')
    const image = await loadBlobImage(blob)
    return {
      source: image,
      width: image.naturalWidth || fallbackWidth,
      height: image.naturalHeight || fallbackHeight
    }
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
