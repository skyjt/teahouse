import type { ImageViewerNavigation } from '../../shared/ipc'
import type { MsgRepo } from '../store/msg-repo'

/** 从已授权的当前图片反查会话，分批跳过不可用媒体，避免加载整个聊天历史。 */
export async function getImageViewerNavigation(
  transferId: string,
  messages: MsgRepo,
  resolveMedia: (id: string) => Promise<{ msgId: string; name: string } | null>
): Promise<ImageViewerNavigation | null> {
  const media = await resolveMedia(transferId)
  const anchor = media ? messages.get(media.msgId) : undefined
  if (!media || !anchor || anchor.kind !== 'image' || anchor.status === 'recalled') return null
  const { conv_id: convId, seq } = anchor

  async function adjacent(direction: 'previous' | 'next'): Promise<string | null> {
    let cursor = seq
    for (;;) {
      const rows = messages.imagePage(convId, cursor, direction, 50)
      for (const row of rows) {
        let ref: { transferId?: unknown; transferIds?: unknown } | null
        try {
          ref = JSON.parse(row.file_ref ?? 'null')
        } catch {
          continue
        }
        if (!ref || typeof ref !== 'object') continue
        const ids = [ref.transferId, ...(Array.isArray(ref.transferIds) ? ref.transferIds : [])]
        for (const id of new Set(ids)) {
          if (typeof id !== 'string' || !id || id.length > 64) continue
          const candidate = await resolveMedia(id)
          if (candidate?.msgId !== row.id) continue
          // 媒体校验包含异步 I/O；期间撤回或移除的消息不再参与导航。
          const current = messages.get(row.id)
          if (current?.kind === 'image' && current.status !== 'recalled' && current.conv_id === convId) {
            return id
          }
        }
      }
      if (rows.length < 50) return null
      cursor = rows[rows.length - 1].seq
    }
  }

  const previous = await adjacent('previous')
  const next = await adjacent('next')
  const current = messages.get(anchor.id)
  if (!current || current.kind !== 'image' || current.status === 'recalled') return null
  return { name: media.name, previous, next }
}
