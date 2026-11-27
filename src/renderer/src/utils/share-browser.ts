import { computed, ref } from 'vue'
import { tr } from './i18n'
import {
  SHARE_FAIL_TEXT,
  SHARE_UPLOAD_FAIL_TEXT,
  type ShareBrowseFailReason,
  type TransferView
} from '../../../shared/ipc'
import type { ShareEntry } from '../../../shared/protocol'

// 每次调用都有独立的目录、选中与传输状态，供聊天侧栏和文件柜页签复用。
// 调用方切换联系人时须 resetBrowse；传输事件的订阅与释放也由调用方负责。
export function useShareBrowser(getPeerId: () => string | null) {
  const entries = ref<ShareEntry[]>([])
  const path = ref('')
  const perm = ref<'read' | 'write'>('read')
  const snapshotId = ref('')
  const total = ref(0)
  const truncated = ref(false)
  const loading = ref(false)
  const loadingMore = ref(false)
  const failReason = ref<ShareBrowseFailReason | null>(null)
  const moreFailReason = ref<ShareBrowseFailReason | null>(null)
  const picked = ref(new Set<string>())
  const cursor = ref(-1)
  const downloading = ref(false)
  const uploading = ref(false)
  const note = ref('')
  const transfer = ref<TransferView | null>(null)
  // 切走再切回同一联系人仍是新批次；目录另计批次，导航不使正在发起的传输失效。
  let peerRevision = 0
  let browseRevision = 0

  const canUpload = computed(() => perm.value === 'write' && !loading.value && !failReason.value)
  const hasMore = computed(() => entries.value.length < total.value)
  const failText = computed(() => (failReason.value ? tr(SHARE_FAIL_TEXT[failReason.value]) : ''))
  const moreFailText = computed(() => (moreFailReason.value ? tr(SHARE_FAIL_TEXT[moreFailReason.value]) : ''))
  const pickedCount = computed(() => picked.value.size)
  const pickedSize = computed(() => entries.value
    .filter((e) => picked.value.has(e.name) && !e.isDir)
    .reduce((sum, e) => sum + e.size, 0))
  const allLoadedPicked = computed(() => entries.value.length > 0 && entries.value.every((e) => picked.value.has(e.name)))
  // 全选只覆盖已加载条目，不能让用户误认为选中了尚未取回的页。
  const pickAllLabel = computed(() => hasMore.value ? tr('选择已加载') : tr('全选'))
  const crumbs = computed(() => {
    const list = [{ name: tr('文件柜'), path: '' }]
    let acc = ''
    for (const seg of path.value ? path.value.split('/') : []) {
      acc = acc ? `${acc}/${seg}` : seg
      list.push({ name: seg, path: acc })
    }
    return list
  })
  const progressPercent = computed(() => {
    const t = transfer.value
    if (!t || t.totalSize <= 0) return 0
    return Math.min(100, Math.round((t.bytesDone / t.totalSize) * 100))
  })
  const transferActive = computed(() => transfer.value?.status === 'accepted' || transfer.value?.status === 'offering')

  function childPath(name: string): string {
    return path.value ? `${path.value}/${name}` : name
  }

  function resetBrowse(): void {
    peerRevision += 1
    browseRevision += 1
    loading.value = false
    loadingMore.value = false
    downloading.value = false
    uploading.value = false
    perm.value = 'read'
    snapshotId.value = ''
    transfer.value = null
    note.value = ''
    entries.value = []
    total.value = 0
    truncated.value = false
    path.value = ''
    picked.value = new Set()
    cursor.value = -1
    failReason.value = null
    moreFailReason.value = null
  }

  function showFailure(reason: ShareBrowseFailReason): void {
    failReason.value = reason
    perm.value = 'read'
    snapshotId.value = ''
    entries.value = []
    picked.value = new Set()
    cursor.value = -1
    total.value = 0
    truncated.value = false
  }

  async function load(next: string, keepPick = false): Promise<void> {
    const peerId = getPeerId()
    if (!peerId) return
    const revision = ++browseRevision
    path.value = next
    loading.value = true
    loadingMore.value = false
    failReason.value = null
    moreFailReason.value = null
    if (!keepPick) {
      picked.value = new Set()
      cursor.value = -1
    }
    const result = await window.pantry.browseShare(peerId, next, 0)
    // 导航、刷新或切换联系人后，旧请求不能覆盖条目、错误提示或加载状态。
    if (revision !== browseRevision || getPeerId() !== peerId) return
    loading.value = false
    if (!result.ok) {
      showFailure(result.reason)
      return
    }
    path.value = result.path
    perm.value = result.perm
    snapshotId.value = result.snapshotId
    entries.value = result.entries
    if (keepPick) {
      picked.value = new Set(result.entries.filter((entry) => picked.value.has(entry.name)).map((entry) => entry.name))
      cursor.value = -1
    }
    total.value = result.total
    truncated.value = result.truncated
  }

  // 翻页失败保留已加载条目；快照失效从首页重取并保留选择。
  async function loadMore(): Promise<void> {
    const peerId = getPeerId()
    if (!peerId || loadingMore.value || loading.value || !hasMore.value) return
    const revision = browseRevision
    loadingMore.value = true
    moreFailReason.value = null
    const result = await window.pantry.browseShare(
      peerId,
      path.value,
      entries.value.length,
      snapshotId.value
    )
    if (revision !== browseRevision || getPeerId() !== peerId) return
    loadingMore.value = false
    if (!result.ok) {
      if (result.reason === 'gone') {
        await load(path.value, true)
        return
      }
      if (result.reason === 'off' || result.reason === 'no-perm') {
        showFailure(result.reason)
        return
      }
      // 暂时的翻页失败只落在列表末尾，保留已取到的条目。
      moreFailReason.value = result.reason
      return
    }
    perm.value = result.perm
    entries.value = [...entries.value, ...result.entries]
    total.value = result.total
    snapshotId.value = result.snapshotId
  }

  function goUp(): void {
    if (crumbs.value.length < 2) return
    void load(crumbs.value[crumbs.value.length - 2].path)
  }

  function clickRow(index: number, modifiers: { shift: boolean; mod: boolean }): void {
    const entry = entries.value[index]
    if (!entry) return
    if (modifiers.shift && cursor.value >= 0) {
      pickRange(cursor.value, index)
      return
    }
    if (modifiers.mod) {
      togglePick(entry.name)
      cursor.value = index
      return
    }
    picked.value = new Set([entry.name])
    cursor.value = index
  }

  function openRow(index: number): void {
    const entry = entries.value[index]
    if (!entry) return
    if (entry.isDir) void load(childPath(entry.name))
    else void download(false, [childPath(entry.name)])
  }

  function togglePick(name: string): void {
    const next = new Set(picked.value)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    picked.value = next
  }

  function pickRange(from: number, to: number): void {
    const [a, b] = from <= to ? [from, to] : [to, from]
    const next = new Set(picked.value)
    for (let i = a; i <= b; i += 1) {
      const entry = entries.value[i]
      if (entry) next.add(entry.name)
    }
    picked.value = next
    cursor.value = to
  }

  function toggleAll(): void {
    picked.value = allLoadedPicked.value ? new Set() : new Set(entries.value.map((e) => e.name))
  }

  function moveCursor(delta: number, extend: boolean): void {
    if (entries.value.length === 0) return
    const from = cursor.value < 0 ? (delta > 0 ? -1 : 0) : cursor.value
    const next = Math.max(0, Math.min(entries.value.length - 1, from + delta))
    if (extend && cursor.value >= 0) pickRange(cursor.value, next)
    else {
      picked.value = new Set([entries.value[next].name])
      cursor.value = next
    }
  }

  async function download(saveAs: boolean, only?: string[]): Promise<void> {
    const peerId = getPeerId()
    if (!peerId) return
    const paths = only ?? [...picked.value].map((name) => childPath(name))
    if (paths.length === 0 || downloading.value || loading.value || failReason.value) return
    const revision = peerRevision
    const directoryRevision = browseRevision
    downloading.value = true
    note.value = ''
    transfer.value = null
    const result = await window.pantry.downloadShare(peerId, paths, saveAs)
    if (revision !== peerRevision || getPeerId() !== peerId) return
    downloading.value = false
    if (!result.ok) {
      note.value = tr(SHARE_FAIL_TEXT[result.reason])
      return
    }
    if (result.canceled) return
    if (!only && directoryRevision === browseRevision) picked.value = new Set()
    if (!transfer.value) note.value = tr('已开始下载')
  }

  // 上传落到对方共享根下以上传者命名的子目录，与当前浏览位置无关（决议 #272）。
  async function upload(directory: boolean): Promise<void> {
    const peerId = getPeerId()
    if (!peerId || !canUpload.value || uploading.value) return
    const revision = peerRevision
    uploading.value = true
    note.value = ''
    transfer.value = null
    const result = await window.pantry.uploadShare(peerId, undefined, directory)
    if (revision !== peerRevision || getPeerId() !== peerId) return
    uploading.value = false
    if (!result.ok) {
      note.value = tr(SHARE_UPLOAD_FAIL_TEXT[result.reason])
      return
    }
    if (!result.canceled && !transfer.value) note.value = tr('正在上传 {0} 个文件', { 0: result.fileCount })
  }

  async function uploadDropped(localPaths: string[]): Promise<void> {
    const peerId = getPeerId()
    if (!peerId || !canUpload.value || uploading.value) return
    if (localPaths.length === 0) return
    const revision = peerRevision
    uploading.value = true
    note.value = ''
    transfer.value = null
    const granted = await window.pantry.grantFilePaths(localPaths)
    if (revision !== peerRevision || getPeerId() !== peerId) return
    const result = await window.pantry.uploadShare(peerId, granted)
    if (revision !== peerRevision || getPeerId() !== peerId) return
    uploading.value = false
    if (!result.ok) {
      note.value = tr(SHARE_UPLOAD_FAIL_TEXT[result.reason])
      return
    }
    if (!result.canceled && !transfer.value) note.value = tr('正在上传 {0} 个文件', { 0: result.fileCount })
  }

  function cancelTransfer(): void {
    if (transfer.value) void window.pantry.cancelTransfer(transfer.value.transferId)
  }

  function revealTransfer(): void {
    if (transfer.value) void window.pantry.revealTransfer(transfer.value.transferId)
  }

  function updateTransfer(view: TransferView): void {
    if (view.peerId !== getPeerId() || !view.msgId.startsWith('share:')) return
    transfer.value = view
    const up = view.direction === 'out'
    if (view.status === 'done') note.value = up ? tr('上传完成') : tr('下载完成')
    else if (view.status === 'failed') note.value = up ? tr('上传失败，可重试') : tr('下载失败，可重试')
    else if (view.status === 'canceled') note.value = tr('已取消')
  }

  return {
    entries, path, perm, snapshotId, total, truncated,
    loading, loadingMore, failReason, moreFailReason, picked, cursor,
    downloading, uploading, note, transfer, canUpload, hasMore,
    failText, moreFailText, pickedCount, pickedSize, allLoadedPicked, pickAllLabel,
    crumbs, progressPercent, transferActive, childPath, resetBrowse, load,
    loadMore, goUp, clickRow, openRow, togglePick, pickRange,
    toggleAll, moveCursor, download, upload, uploadDropped, cancelTransfer,
    revealTransfer, updateTransfer
  }
}
