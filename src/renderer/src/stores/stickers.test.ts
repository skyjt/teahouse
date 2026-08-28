import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageSourceBytes } from '../../../shared/ipc'
import { useStickersStore } from './stickers'

function staticSource(): ImageSourceBytes {
  return {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
    ext: '.png',
    width: 1024,
    height: 256,
    animated: false
  }
}

describe('表情包导入', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('逐张消费专用选择授权，复用压缩链路并继续处理单张失败', async () => {
    const paths = ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']
    const pickStickerImages = vi.fn().mockResolvedValue(paths)
    const fetchStickerImportSource = vi.fn(async (path: string) =>
      path.endsWith('b.png') ? null : staticSource()
    )
    const addSticker = vi
      .fn()
      .mockResolvedValueOnce({ id: 'a', w: 512, h: 128, animated: false })
      .mockResolvedValueOnce({ id: 'c', w: 512, h: 128, animated: false })
    const close = vi.fn()
    const drawImage = vi.fn()

    vi.stubGlobal('window', {
      pantry: { pickStickerImages, fetchStickerImportSource, addSticker }
    })
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1024, height: 256, close }))
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toBlob: (done: (blob: Blob) => void) => done(new Blob(['webp']))
      }))
    })

    const store = useStickersStore()
    await expect(store.importFiles()).resolves.toEqual({ selected: 3, added: 2 })

    expect(pickStickerImages).toHaveBeenCalledOnce()
    expect(fetchStickerImportSource.mock.calls.map(([path]) => path)).toEqual(paths)
    expect(addSticker).toHaveBeenCalledTimes(2)
    expect(addSticker).toHaveBeenNthCalledWith(1, expect.any(ArrayBuffer), '.webp', 512, 128)
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    expect(store.list.map((item) => item.id)).toEqual(['c', 'a'])
    expect(store.importing).toBe(false)
  })

  it('GIF 保留原始字节并在处理后释放位图', async () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38]).buffer
    const close = vi.fn()
    const addSticker = vi.fn().mockResolvedValue({ id: 'gif', w: 160, h: 90, animated: true })
    vi.stubGlobal('window', { pantry: { addSticker } })
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 160, height: 90, close }))

    const store = useStickersStore()
    await expect(
      store.addSource({ bytes, ext: '.gif', width: 160, height: 90, animated: true })
    ).resolves.toBe(true)

    expect(addSticker).toHaveBeenCalledWith(bytes, '.gif', 160, 90)
    expect(close).toHaveBeenCalledOnce()
  })
})
