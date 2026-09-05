import type { ObjectDirective } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedImageBinding } from './cached-image'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('近视口缩略图队列', () => {
  let directive: ObjectDirective<HTMLImageElement, CachedImageBinding>
  let notify: IntersectionObserverCallback
  const source = { bytes: new ArrayBuffer(4), ext: 'png', width: 1600, height: 1200, animated: false }
  const pantry = {
    hasImageThumbnail: vi.fn(), fetchStickerSource: vi.fn(), cacheImageThumbnail: vi.fn()
  }
  const close = vi.fn()
  const getContext = vi.fn()

  function hook(name: 'mounted' | 'updated' | 'unmounted', el: HTMLImageElement, value?: CachedImageBinding) {
    const run = directive[name] as (el: HTMLImageElement, binding: { value?: CachedImageBinding }) => void
    run(el, { value })
  }
  function mount(id: string, cache: boolean | undefined = true) {
    const el = {
      src: '', dataset: {}, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      removeAttribute(this: { src: string }) { this.src = '' }
    } as unknown as HTMLImageElement
    hook('mounted', el, { transferId: id, cache })
    return el
  }
  function enter(elements: HTMLImageElement[], isIntersecting = true) {
    notify(elements.map((target) => ({ target, isIntersecting })) as unknown as IntersectionObserverEntry[], {} as IntersectionObserver)
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    pantry.hasImageThumbnail.mockResolvedValue(false)
    pantry.fetchStickerSource.mockResolvedValue(source)
    pantry.cacheImageThumbnail.mockResolvedValue(true)
    getContext.mockReturnValue({ drawImage: vi.fn() })
    vi.stubGlobal('window', { pantry })
    vi.stubGlobal('document', {
      documentElement: { dataset: { rendering: 'software' } },
      createElement: () => ({ getContext, toBlob: (done: (blob: Blob) => void) => done(new Blob(['缩略图'])) })
    })
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close }))
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback }
      observe() { /* 测试显式推送近视口状态 */ }
      unobserve() { /* 同上 */ }
    })
    directive = (await import('./cached-image')).vCachedImage
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each([['software', 2], ['hardware', 4], ['', 2]] as const)('%s 整段流水线最多 %s 路，写回完成才释放槽位', async (profile, limit) => {
    document.documentElement.dataset.rendering = profile
    const writing = deferred<boolean>()
    pantry.cacheImageThumbnail.mockReturnValue(writing.promise)
    const images = Array.from({ length: 8 }, (_, i) => mount(`m${i}`))
    enter(images)
    await vi.waitFor(() => expect(pantry.cacheImageThumbnail).toHaveBeenCalledTimes(limit))
    expect(pantry.fetchStickerSource).toHaveBeenCalledTimes(limit)
    expect(close).toHaveBeenCalledTimes(limit)
    writing.resolve(true)
    await vi.waitFor(() => expect(images.every((el) => el.src.startsWith('pantry-thumb:'))).toBe(true))
    expect(pantry.fetchStickerSource).toHaveBeenCalledTimes(8)
    expect(close).toHaveBeenCalledTimes(8)
  })

  it('滚出、卸载和改绑丢弃无需求的排队项，共享项保留其他视图，重新进入可补载', async () => {
    const lookup = deferred<boolean>()
    pantry.hasImageThumbnail.mockReturnValue(lookup.promise)
    const runningA = mount('running-a'), runningB = mount('running-b'), orphan = mount('orphan')
    const sharedA = mount('shared'), sharedB = mount('shared'), rebound = mount('old')
    enter([runningA, runningB, orphan, sharedA, sharedB, rebound])
    enter([orphan], false)
    hook('unmounted', runningA)
    hook('unmounted', sharedA)
    hook('updated', rebound, { transferId: 'new', cache: true })
    enter([rebound])
    lookup.resolve(false)
    await vi.waitFor(() => expect(rebound.src).toBe('pantry-thumb://new'))
    expect(pantry.fetchStickerSource.mock.calls.map(([id]) => id)).toEqual(['running-a', 'running-b', 'shared', 'new'])
    expect(sharedB.src).toBe('pantry-thumb://shared')
    expect(sharedA.src).toBe('')
    expect(runningA.src).toBe('')
    expect(orphan.src).toBe('')
    enter([orphan])
    await vi.waitFor(() => expect(orphan.src).toBe('pantry-thumb://orphan'))
    const cached = mount('shared')
    enter([cached])
    expect(cached.src).toBe('pantry-thumb://shared')
    expect(pantry.fetchStickerSource.mock.calls.filter(([id]) => id === 'shared')).toHaveLength(1)
  })

  it.each(['lookup', 'source', 'missing', 'animated', 'small', 'decode', 'canvas', 'write'] as const)(
    '%s 退路仍使用原图，队列继续运行且位图会释放', async (failure) => {
      if (failure === 'lookup') pantry.hasImageThumbnail.mockRejectedValueOnce(new Error('读取失败'))
      if (failure === 'source') pantry.fetchStickerSource.mockRejectedValueOnce(new Error('源图失败'))
      if (failure === 'missing') pantry.fetchStickerSource.mockResolvedValueOnce(null)
      if (failure === 'animated') pantry.fetchStickerSource.mockResolvedValueOnce({ ...source, animated: true })
      if (failure === 'small') pantry.fetchStickerSource.mockResolvedValueOnce({ ...source, width: 200, height: 100 })
      if (failure === 'decode') vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('解码失败'))
      if (failure === 'canvas') getContext.mockReturnValueOnce(null)
      if (failure === 'write') pantry.cacheImageThumbnail.mockResolvedValueOnce(false)
      const fallback = mount('fallback')
      enter([fallback])
      await vi.waitFor(() => expect(fallback.src).toBe('pantry-img://fallback'))
      const next = mount('next')
      enter([next])
      await vi.waitFor(() => expect(next.src).toBe('pantry-thumb://next'))
      expect(close).toHaveBeenCalledTimes(failure === 'canvas' || failure === 'write' ? 2 : 1)
    }
  )

  it('磁盘命中不读原图，cache=false 保留直接原图路径，无观察器仍可加载', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const original = mount('original', false)
    expect(original.src).toBe('pantry-img://original')
    pantry.hasImageThumbnail.mockResolvedValue(true)
    const cached = mount('disk')
    await vi.waitFor(() => expect(cached.src).toBe('pantry-thumb://disk'))
    expect(pantry.fetchStickerSource).not.toHaveBeenCalled()
    expect(pantry.hasImageThumbnail.mock.calls).toEqual([['disk']])
  })

  it('完成结果超过 512 项时，进行中的同源请求继续共享', async () => {
    const lookup = deferred<boolean>()
    pantry.hasImageThumbnail.mockImplementation((id: string) => id === 'pending' ? lookup.promise : Promise.resolve(true))
    const pendingA = mount('pending')
    const cached = Array.from({ length: 513 }, (_, i) => mount(`disk${i}`))
    enter([pendingA, ...cached])
    await vi.waitFor(() => expect(cached[512].src).toBe('pantry-thumb://disk512'))
    const pendingB = mount('pending')
    enter([pendingB])
    expect(pantry.hasImageThumbnail.mock.calls.filter(([id]) => id === 'pending')).toHaveLength(1)
    lookup.resolve(true)
    await vi.waitFor(() => expect([pendingA.src, pendingB.src]).toEqual(['pantry-thumb://pending', 'pantry-thumb://pending']))
  })
})
