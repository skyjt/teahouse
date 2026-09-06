import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrResult, OcrWorkerRequest, OcrWorkerResponse } from './ocr'

type OcrClient = typeof import('./ocr')
let client: OcrClient
let decode: ReturnType<typeof vi.fn>
let workers: TestWorker[]

class TestBitmap {
  width = 4
  height = 2
  close = vi.fn()
}

class TestWorker {
  onmessage: ((event: MessageEvent<OcrWorkerResponse>) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor(readonly url: URL, readonly options: WorkerOptions) {
    workers.push(this)
  }

  request(): OcrWorkerRequest {
    return this.postMessage.mock.calls.at(-1)![0] as OcrWorkerRequest
  }

  respond(data: OcrWorkerResponse): void {
    this.onmessage?.({ data } as MessageEvent<OcrWorkerResponse>)
  }
}

const result: OcrResult = { text: '茶话间', tokens: [], lines: [], scale: 1 }
const params = (cacheKey = 'image') => ({
  cacheKey,
  source: { bytes: new ArrayBuffer(1), name: 'image.png', size: 1 },
  naturalWidth: 4,
  naturalHeight: 2,
  onProgress: vi.fn()
})

beforeEach(async () => {
  vi.resetModules()
  workers = []
  decode = vi.fn().mockImplementation(async () => new TestBitmap())
  vi.stubGlobal('Worker', TestWorker)
  vi.stubGlobal('ImageBitmap', TestBitmap)
  vi.stubGlobal('createImageBitmap', decode)
  vi.stubGlobal('document', {
    baseURI: 'file:///app/out/renderer/index.html',
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: vi.fn(),
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4)
        })
      })
    })
  })
  client = await import('./ocr')
})

afterEach(() => {
  client.disposeImageTextRecognition()
  vi.unstubAllGlobals()
})

async function nextWorker(): Promise<TestWorker> {
  await vi.waitFor(() => expect(workers.length).toBeGreaterThan(0))
  return workers.at(-1)!
}

describe('图片 OCR Worker 生命周期', () => {
  it('解码开始即互斥，取消后迟到位图只释放，不启动模型或污染缓存', async () => {
    let resolveBitmap!: (value: TestBitmap) => void
    decode.mockImplementationOnce(() => new Promise<TestBitmap>((resolve) => { resolveBitmap = resolve }))
    expect(workers).toHaveLength(0)
    const pending = client.recognizeImageText(params('cancelled'))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.recognizeImageText(params('duplicate'))).rejects.toThrow('正在识别其他图片')
    expect(decode).toHaveBeenCalledTimes(1)
    client.cancelImageTextRecognition()
    await rejected
    const bitmap = new TestBitmap()
    resolveBitmap(bitmap)
    await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
    expect(workers).toHaveLength(0)
    expect(client.getCachedOcrResult('cancelled')).toBeNull()
  })

  it('原生解码未结束时连续取消重启，始终最多一个解码，等待中关闭也不追加工作', async () => {
    const resolvers: Array<(bitmap: TestBitmap) => void> = []
    let pendingDecodes = 0
    let maxPendingDecodes = 0
    decode.mockImplementation(() => {
      pendingDecodes += 1
      maxPendingDecodes = Math.max(maxPendingDecodes, pendingDecodes)
      return new Promise<TestBitmap>((resolve) => {
        resolvers.push((bitmap) => { pendingDecodes -= 1; resolve(bitmap) })
      })
    })
    for (let i = 0; i < 4; i++) {
      const pending = client.recognizeImageText(params(`cancel-${i}`))
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      if (i === 3) client.disposeImageTextRecognition()
      else client.cancelImageTextRecognition()
      await rejected
    }
    const latest = client.recognizeImageText(params('latest'))
    expect(decode).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(0)
    const cancelledBitmap = new TestBitmap()
    resolvers.shift()!(cancelledBitmap)
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
    expect(cancelledBitmap.close).toHaveBeenCalledOnce()
    expect(maxPendingDecodes).toBe(1)
    const latestBitmap = new TestBitmap()
    resolvers.shift()!(latestBitmap)
    const instance = await nextWorker()
    instance.respond({ type: 'result', id: instance.request().id, result })
    await expect(latest).resolves.toEqual(result)
    expect(latestBitmap.close).toHaveBeenCalledOnce()
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('取消推理终止 Worker，旧响应不影响新任务，完成后复用模型并可主动释放', async () => {
    const first = client.recognizeImageText(params('first'))
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const oldWorker = await nextWorker()
    const oldId = oldWorker.request().id
    client.cancelImageTextRecognition()
    await rejected
    expect(oldWorker.terminate).toHaveBeenCalledOnce()

    const second = client.recognizeImageText(params('second'))
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    const current = workers[1]
    oldWorker.respond({ type: 'result', id: oldId, result })
    expect(client.getCachedOcrResult('first')).toBeNull()
    current.respond({ type: 'result', id: current.request().id, result })
    await expect(second).resolves.toEqual(result)
    client.cancelImageTextRecognition()
    expect(current.terminate).not.toHaveBeenCalled()

    const third = client.recognizeImageText(params('third'))
    await vi.waitFor(() => expect(current.postMessage).toHaveBeenCalledTimes(2))
    expect(workers).toHaveLength(2)
    current.respond({ type: 'result', id: current.request().id, result })
    await third
    client.disposeImageTextRecognition()
    expect(current.terminate).toHaveBeenCalledOnce()
  })

  it('大图缩小解码并转移像素缓冲，命中缓存不会解码或创建 Worker', async () => {
    const pending = client.recognizeImageText({ ...params(), naturalWidth: 4400, naturalHeight: 22 })
    const instance = await nextWorker()
    const request = instance.request()
    expect(decode.mock.calls[0][1]).toEqual({ resizeWidth: 2200, resizeHeight: 11, resizeQuality: 'high' })
    expect(instance.url.protocol).toBe('file:')
    expect(instance.options.type).toBe('module')
    expect(request.assetBase).toBe('file:///app/out/renderer/ocr/')
    expect(request.image).toMatchObject({ width: 2200, height: 11, scale: 0.5 })
    expect(instance.postMessage.mock.calls[0][1]).toEqual([request.image.data.buffer])
    instance.respond({ type: 'result', id: request.id, result })
    await pending
    client.disposeImageTextRecognition()
    await expect(client.recognizeImageText(params())).resolves.toEqual(result)
    expect(decode).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(1)
  })

  it('Worker 失败释放任务和模型，后续请求可重试', async () => {
    const pending = client.recognizeImageText(params('failed'))
    const rejected = expect(pending).rejects.toThrow('OCR 识别失败')
    const instance = await nextWorker()
    instance.onerror?.()
    await rejected
    expect(instance.terminate).toHaveBeenCalledOnce()
    expect(client.getCachedOcrResult('failed')).toBeNull()
    const retry = client.recognizeImageText(params('retry'))
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    workers[1].respond({ type: 'result', id: workers[1].request().id, result })
    await expect(retry).resolves.toEqual(result)
  })

  it('空白识别结果不写缓存，已有空白缓存也允许重新识别', async () => {
    const first = client.recognizeImageText(params())
    const instance = await nextWorker()
    const empty = { ...result, text: ' \n ' }
    instance.respond({ type: 'result', id: instance.request().id, result: empty })
    await expect(first).resolves.toEqual(empty)
    expect(client.getCachedOcrResult('image')).toBeNull()
    const second = client.recognizeImageText(params())
    await vi.waitFor(() => expect(instance.postMessage).toHaveBeenCalledTimes(2))
    const stored = { ...result }
    instance.respond({ type: 'result', id: instance.request().id, result: stored })
    await second
    // 通过同一结果引用模拟升级前已留在内存中的空白条目。
    stored.text = ' \n '
    const third = client.recognizeImageText(params())
    await vi.waitFor(() => expect(instance.postMessage).toHaveBeenCalledTimes(3))
    instance.respond({ type: 'result', id: instance.request().id, result })
    await expect(third).resolves.toEqual(result)
    expect(decode).toHaveBeenCalledTimes(3)
  })
})
