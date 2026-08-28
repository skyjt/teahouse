import { defineStore } from 'pinia'
import type { ImageSourceBytes, StickerView } from '../../../shared/ipc'

// 自定义表情包（F-MSG-7）：收藏入库走"读源→canvas 压缩→入库"流水线（tech-design §7）

const MAX_EDGE = 512

export const useStickersStore = defineStore('stickers', {
  state: () => ({
    list: [] as StickerView[],
    initialized: false,
    importing: false
  }),
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      this.list = await window.pantry.listStickers()
    },

    /** 静图压 ≤512px WebP；GIF ≤2MB 原样收藏。 */
    async addSource(source: ImageSourceBytes): Promise<boolean> {
      const head = new Uint8Array(source.bytes.slice(0, 4))
      const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 // 'GIF'
      if (isGif && source.bytes.byteLength > 2 * 1024 * 1024) return false

      let bitmap: ImageBitmap | null = null
      try {
        bitmap = await createImageBitmap(new Blob([source.bytes]))
        if (isGif) {
          const added = await window.pantry.addSticker(
            source.bytes,
            '.gif',
            bitmap.width,
            bitmap.height
          )
          if (added) this.list = [added, ...this.list]
          return added !== null
        }

        const ratio = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
        const w = Math.max(1, Math.round(bitmap.width * ratio))
        const h = Math.max(1, Math.round(bitmap.height * ratio))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        ctx.drawImage(bitmap, 0, 0, w, h)
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/webp', 0.8)
        )
        if (!blob) return false
        const added = await window.pantry.addSticker(await blob.arrayBuffer(), '.webp', w, h)
        if (added) this.list = [added, ...this.list]
        return added !== null
      } catch {
        return false
      } finally {
        bitmap?.close()
      }
    },

    /** 聊天图片右键「添加到表情」。 */
    async addFromTransfer(transferId: string): Promise<boolean> {
      const source = await window.pantry.fetchStickerSource(transferId)
      return source ? this.addSource(source) : false
    },

    async importFiles(): Promise<{ selected: number; added: number } | null> {
      if (this.importing) return null
      this.importing = true
      try {
        const paths = await window.pantry.pickStickerImages()
        if (!paths) return null
        let added = 0
        for (const path of paths) {
          const source = await window.pantry.fetchStickerImportSource(path)
          if (source && (await this.addSource(source))) added += 1
        }
        return { selected: paths.length, added }
      } finally {
        this.importing = false
      }
    },

    async remove(id: string): Promise<void> {
      await window.pantry.removeSticker(id)
      this.list = this.list.filter((s) => s.id !== id)
    },

    async move(id: string, delta: -1 | 1): Promise<void> {
      const index = this.list.findIndex((s) => s.id === id)
      const next = index + delta
      if (index < 0 || next < 0 || next >= this.list.length) return
      const copy = [...this.list]
      const [item] = copy.splice(index, 1)
      copy.splice(next, 0, item)
      this.list = await window.pantry.reorderStickers(copy.map((s) => s.id))
    }
  }
})
