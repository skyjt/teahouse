import * as ort from 'onnxruntime-web/wasm'
import { RetryableAsyncValue } from './bounded-cache'
import { PaddleOcrService, type OrtModule, type RecognitionResult } from './paddleocr'
import type { OcrBox, OcrLine, OcrResult, OcrToken, OcrWorkerRequest, OcrWorkerResponse } from './ocr'

const OCR_MIN_CONFIDENCE = 0.3
const serviceCache = new RetryableAsyncValue<PaddleOcrService>()
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<OcrWorkerRequest>) => void) | null
  postMessage(message: OcrWorkerResponse): void
}

scope.onmessage = ({ data }) => {
  void recognize(data)
}

async function recognize(request: OcrWorkerRequest): Promise<void> {
  const { id, image, assetBase } = request
  try {
    scope.postMessage({ type: 'progress', id, progress: 0.05, status: 'initializing models' })
    const service = await getService(assetBase)
    scope.postMessage({ type: 'progress', id, progress: 0.1, status: 'recognizing text' })
    const results = await service.recognize(image, {
      onProgress: (event) => {
        const frac = event.progress.total > 0 ? event.progress.current / event.progress.total : 0
        const progress = event.type === 'det' ? 0.1 + frac * 0.2 : 0.3 + frac * 0.65
        scope.postMessage({ type: 'progress', id, progress, status: 'recognizing text' })
      }
    })
    scope.postMessage({ type: 'result', id, result: toOcrResult(results, image.scale) })
  } catch {
    // 不把引擎异常中的张量或识别内容跨线程输出到日志。
    scope.postMessage({ type: 'error', id })
  }
}

async function getService(assetBase: string): Promise<PaddleOcrService> {
  return serviceCache.get(() => createService(assetBase))
}

async function createService(assetBase: string): Promise<PaddleOcrService> {
  // Worker 内仍只用一个 WASM 线程，不创建额外线程池。
  ort.env.wasm.wasmPaths = assetBase
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false

  const [detBuffer, recBuffer, dictText] = await Promise.all([
    fetchArrayBuffer(`${assetBase}PP-OCRv6_tiny_det.onnx`),
    fetchArrayBuffer(`${assetBase}PP-OCRv6_tiny_rec.onnx`),
    fetchText(`${assetBase}ppocrv6_dict.txt`)
  ])

  // PaddleOCR CTC 约定：index 0 是 blank 占位，字典末尾补一个空格类。
  const chars = dictText.replace(/\n+$/, '').split('\n')
  const charactersDictionary = ['', ...chars, ' ']

  const service = new PaddleOcrService({
    ort: ort as unknown as OrtModule,
    detection: { modelBuffer: detBuffer },
    recognition: { modelBuffer: recBuffer, charactersDictionary }
  })
  try {
    await service.initialize()
    return service
  } catch (error) {
    await service.destroy()
    throw error
  }
}

async function fetchArrayBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`OCR 资源加载失败：${path}`)
  return res.arrayBuffer()
}

async function fetchText(path: string): Promise<string> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`OCR 资源加载失败：${path}`)
  return res.text()
}

// PaddleOCR 输出按行（检测框 + 整行文字），转成既有 OcrResult 结构；
// 每行只保留一个 token，图片文字层由浏览器原生选区逐字选择。
function toOcrResult(results: RecognitionResult[], scale: number): OcrResult {
  const divisor = scale > 0 ? scale : 1
  const tokens: OcrToken[] = []
  const lines: OcrLine[] = []
  const textLines: string[] = []

  let lineIndex = 0
  for (const item of results) {
    const text = normalizeText(item.text)
    if (!text || item.confidence < OCR_MIN_CONFIDENCE) continue
    // 还原到原图坐标（PaddleOCR 坐标相对降采样后的图）。
    const bbox: OcrBox = {
      x0: item.box.x / divisor,
      y0: item.box.y / divisor,
      x1: (item.box.x + item.box.width) / divisor,
      y1: (item.box.y + item.box.height) / divisor
    }
    const tokenId = `ocr-${lineIndex}`
    tokens.push({
      id: tokenId,
      text,
      confidence: Math.round(item.confidence * 100),
      bbox,
      lineIndex,
      wordIndex: 0,
      tokenIndex: lineIndex
    })
    lines.push({ id: `line-${lineIndex}`, text, bbox, tokenIds: [tokenId], lineIndex })
    textLines.push(text)
    lineIndex += 1
  }

  return { text: textLines.join('\n'), tokens, lines, scale: 1 }
}

function normalizeText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}
