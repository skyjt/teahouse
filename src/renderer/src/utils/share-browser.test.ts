import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PantryApi, ShareBrowseResult, TransferView } from '../../../shared/ipc'
import { useCabinetStore } from '../stores/cabinet'
import { useShareBrowser } from './share-browser'

const api = {
  browseShare: vi.fn<PantryApi['browseShare']>(),
  downloadShare: vi.fn<PantryApi['downloadShare']>(),
  uploadShare: vi.fn<PantryApi['uploadShare']>(),
  grantFilePaths: vi.fn<PantryApi['grantFilePaths']>(),
  cancelTransfer: vi.fn(),
  revealTransfer: vi.fn(),
  listRecentShareUploads: vi.fn()
}
const page = (...names: string[]): Extract<ShareBrowseResult, { ok: true }> => ({
  ok: true, path: '资料', perm: 'write', snapshotId: 'snapshot', offset: 0,
  total: 3, truncated: false,
  entries: names.map(name => ({ name, size: 10, isDir: false, mtime: 0 }))
})

function deferred<T>() {
  let resolve!: (result: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  api.listRecentShareUploads.mockResolvedValue([])
  setActivePinia(createPinia())
  vi.stubGlobal('window', { pantry: api })
})
afterEach(() => vi.unstubAllGlobals())

it('翻页失败保留首屏与选择，重试续页；刷新失败才清空列表', async () => {
  const browser = useShareBrowser(() => 'alice')
  api.browseShare.mockResolvedValueOnce(page('a'))
  await browser.load('资料')
  browser.togglePick('a')
  api.browseShare.mockResolvedValueOnce({ ok: false, reason: 'busy' })
  await browser.loadMore()
  expect(browser.entries.value.map(e => e.name)).toEqual(['a'])
  expect(browser.picked.value).toEqual(new Set(['a']))
  expect(browser.failReason.value).toBeNull()
  expect(browser.moreFailReason.value).toBe('busy')
  api.browseShare.mockResolvedValueOnce(page('b', 'c'))
  await browser.loadMore()
  expect(api.browseShare).toHaveBeenLastCalledWith('alice', '资料', 1, 'snapshot')
  expect(browser.entries.value.map(e => e.name)).toEqual(['a', 'b', 'c'])
  expect(browser.moreFailReason.value).toBeNull()
  api.browseShare.mockResolvedValueOnce({ ok: false, reason: 'offline' })
  await browser.load('资料')
  expect(browser.entries.value).toEqual([])
  expect(browser.failReason.value).toBe('offline')
})

it('权限被收回后，分页与刷新都收起上传入口并清除失效的选择', async () => {
  const browser = useShareBrowser(() => 'alice')
  api.browseShare.mockResolvedValueOnce(page('a'))
  await browser.load('资料')
  expect(browser.canUpload.value).toBe(true)
  api.browseShare.mockResolvedValueOnce({ ...page('b'), perm: 'read' })
  await browser.loadMore()
  expect(browser.canUpload.value).toBe(false)
  browser.togglePick('a')
  api.browseShare.mockResolvedValueOnce({ ok: false, reason: 'off' })
  await browser.loadMore()
  expect(browser.failReason.value).toBe('off')
  expect(browser.entries.value).toEqual([])
  expect(browser.pickedCount.value).toBe(0)
  api.browseShare.mockResolvedValueOnce(page('a'))
  await browser.load('资料')
  const reply = deferred<ShareBrowseResult>()
  api.browseShare.mockReturnValueOnce(reply.promise)
  const pending = browser.load('子目录')
  expect(browser.canUpload.value).toBe(false)
  reply.resolve({ ok: false, reason: 'off' })
  await pending
  await browser.upload(false)
  expect(api.uploadShare).not.toHaveBeenCalled()
  expect(browser.path.value).toBe('子目录')
})

it('快照失效从首页重取，保留已选项并清除翻页错误', async () => {
  const browser = useShareBrowser(() => 'alice')
  api.browseShare.mockResolvedValueOnce(page('a'))
  await browser.load('资料')
  browser.togglePick('a')
  api.browseShare.mockResolvedValueOnce({ ok: false, reason: 'gone' }).mockResolvedValueOnce(page('a', 'b'))
  await browser.loadMore()
  expect(api.browseShare).toHaveBeenLastCalledWith('alice', '资料', 0)
  expect(browser.picked.value).toEqual(new Set(['a']))
  expect(browser.moreFailReason.value).toBeNull()
  expect(browser.loadingMore.value).toBe(false)
})

it('主文件柜与侧栏状态独立，切换联系人后忽略旧分页结果', async () => {
  const cabinet = useCabinetStore()
  const sidebar = useShareBrowser(() => 'alice')
  api.browseShare.mockResolvedValueOnce(page('a'))
  cabinet.selectPeer('alice')
  await Promise.resolve()
  expect(sidebar.entries.value).toEqual([])
  const response = deferred<ShareBrowseResult>()
  api.browseShare.mockReturnValueOnce(response.promise)
  const pending = cabinet.loadMore()
  api.browseShare.mockResolvedValueOnce(page('bob-file'))
  cabinet.selectPeer('bob')
  await Promise.resolve()
  response.resolve(page('old-alice-file'))
  await pending
  expect(cabinet.entries.map(e => e.name)).toEqual(['bob-file'])
  expect(cabinet.loadingMore).toBe(false)
  cabinet.togglePick('bob-file')
  expect(sidebar.picked.value.size).toBe(0)
  cabinet.selectMine()
  expect(cabinet.entries).toEqual([])
  expect(cabinet.picked.size).toBe(0)
})

it.each([
  ['成功', page('old-file')],
  ['失败', { ok: false, reason: 'offline' }]
] satisfies Array<[string, ShareBrowseResult]>)(
  '连续导航后忽略旧目录的%s结果', async (_label, oldResult) => {
    const browser = useShareBrowser(() => 'alice')
    const response = deferred<ShareBrowseResult>()
    api.browseShare.mockReturnValueOnce(response.promise)
    const pending = browser.load('旧目录')
    const current = { ...page('new-file'), path: '新目录' }
    api.browseShare.mockResolvedValueOnce(current)
    await browser.load('新目录')
    response.resolve(oldResult)
    await pending
    expect(browser.path.value).toBe('新目录')
    expect(browser.entries.value).toEqual(current.entries)
    expect(browser.failReason.value).toBeNull()
  }
)

it('旧请求先返回时不能清除新请求的加载状态', async () => {
  const browser = useShareBrowser(() => 'alice')
  const old = deferred<ShareBrowseResult>()
  const current = deferred<ShareBrowseResult>()
  api.browseShare.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const first = browser.load('旧目录')
  const second = browser.load('新目录')
  old.resolve(page('old-file'))
  await first
  expect(browser.loading.value).toBe(true)
  expect(browser.entries.value).toEqual([])
  current.resolve({ ...page('new-file'), path: '新目录' })
  await second
  expect(browser.loading.value).toBe(false)
  expect(browser.path.value).toBe('新目录')
})

it.each([
  ['成功', page('old-page-file')],
  ['快照失效', { ok: false, reason: 'gone' }]
] satisfies Array<[string, ShareBrowseResult]>)(
  '切换目录后忽略旧分页的%s结果，仍可加载新目录的下一页', async (_label, oldResult) => {
    const browser = useShareBrowser(() => 'alice')
    api.browseShare.mockResolvedValueOnce(page('old-file'))
    await browser.load('资料')
    const response = deferred<ShareBrowseResult>()
    api.browseShare.mockReturnValueOnce(response.promise)
    const pending = browser.loadMore()
    const current = { ...page('new-file'), path: '新目录', snapshotId: 'new-snapshot' }
    api.browseShare.mockResolvedValueOnce(current)
    await browser.load('新目录')
    expect(browser.loadingMore.value).toBe(false)
    response.resolve(oldResult)
    await pending
    expect(api.browseShare).toHaveBeenCalledTimes(3)
    expect(browser.entries.value).toEqual(current.entries)
    expect(browser.snapshotId.value).toBe('new-snapshot')
    api.browseShare.mockResolvedValueOnce({ ...current, entries: page('next-file').entries })
    await browser.loadMore()
    expect(api.browseShare).toHaveBeenLastCalledWith('alice', '新目录', 1, 'new-snapshot')
    expect(browser.entries.value.map(e => e.name)).toEqual(['new-file', 'next-file'])
  }
)

it('切到其他联系人再切回来，也不接受首次浏览的结果', async () => {
  const cabinet = useCabinetStore()
  const response = deferred<ShareBrowseResult>()
  api.browseShare.mockReturnValueOnce(response.promise)
    .mockResolvedValueOnce(page('bob-file'))
    .mockResolvedValueOnce(page('fresh-alice-file'))
  cabinet.selectPeer('alice')
  cabinet.selectPeer('bob')
  cabinet.selectPeer('alice')
  await Promise.resolve()
  response.resolve(page('stale-alice-file'))
  await response.promise
  expect(cabinet.entries.map(e => e.name)).toEqual(['fresh-alice-file'])
  expect(cabinet.loading).toBe(false)
})

it('拖入文件等待授权期间切走再切回，不再发起旧上传', async () => {
  let peerId = 'alice'
  const browser = useShareBrowser(() => peerId)
  browser.perm.value = 'write'
  const response = deferred<string[]>()
  api.grantFilePaths.mockReturnValueOnce(response.promise)
  api.uploadShare.mockResolvedValue({ ok: true, fileCount: 1 })
  const pending = browser.uploadDropped(['/allowed'])
  peerId = 'bob'
  browser.resetBrowse()
  peerId = 'alice'
  browser.resetBrowse()
  browser.perm.value = 'write'
  response.resolve(['/allowed'])
  await pending
  expect(api.uploadShare).not.toHaveBeenCalled()
  expect(browser.uploading.value).toBe(false)
  expect(browser.note.value).toBe('')
})

it('同一联系人内切换目录，不丢弃正在发起的上传结果', async () => {
  const browser = useShareBrowser(() => 'alice')
  browser.perm.value = 'write'
  const response = deferred<Awaited<ReturnType<PantryApi['uploadShare']>>>()
  api.uploadShare.mockReturnValueOnce(response.promise)
  const pending = browser.upload(false)
  api.browseShare.mockResolvedValueOnce({ ...page('file'), path: '新目录' })
  await browser.load('新目录')
  expect(browser.uploading.value).toBe(true)
  response.resolve({ ok: true, fileCount: 1 })
  await pending
  expect(browser.uploading.value).toBe(false)
  expect(browser.note.value).toBe('正在上传 1 个文件')
})

it('切走再切回后的旧下载结果不清除新选择或新请求的忙碌状态', async () => {
  let peerId = 'alice'
  const browser = useShareBrowser(() => peerId)
  const old = deferred<Awaited<ReturnType<PantryApi['downloadShare']>>>()
  const current = deferred<Awaited<ReturnType<PantryApi['downloadShare']>>>()
  api.downloadShare.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  browser.togglePick('old-file')
  const first = browser.download(false)
  peerId = 'bob'
  browser.resetBrowse()
  peerId = 'alice'
  browser.resetBrowse()
  browser.togglePick('new-file')
  const second = browser.download(false)
  old.resolve({ ok: true })
  await first
  expect(browser.downloading.value).toBe(true)
  expect([...browser.picked.value]).toEqual(['new-file'])
  expect(browser.note.value).toBe('')
  current.resolve({ ok: true })
  await second
  expect(browser.downloading.value).toBe(false)
  expect(browser.picked.value.size).toBe(0)
})

it('单击、组合键与键盘扩选保持一致，全选只包含已加载条目', async () => {
  const browser = useShareBrowser(() => 'alice')
  api.browseShare.mockResolvedValueOnce(page('a', 'b'))
  await browser.load('资料')
  expect(browser.pickAllLabel.value).toBe('选择已加载')
  browser.clickRow(0, { shift: false, mod: false })
  browser.clickRow(1, { shift: false, mod: true })
  expect([...browser.picked.value]).toEqual(['a', 'b'])
  browser.clickRow(0, { shift: false, mod: true })
  expect([...browser.picked.value]).toEqual(['b'])
  browser.clickRow(0, { shift: true, mod: false })
  expect(browser.pickedCount.value).toBe(2)
  browser.toggleAll()
  expect(browser.pickedCount.value).toBe(0)
  browser.moveCursor(1, false)
  browser.moveCursor(-1, true)
  expect(browser.pickedSize.value).toBe(20)
  browser.total.value = 2
  expect(browser.pickAllLabel.value).toBe('全选')
})

it('下载使用当前目录与独立数组，取消保留选择，成功后清除选择', async () => {
  const browser = useShareBrowser(() => 'alice')
  api.browseShare.mockResolvedValueOnce(page('a'))
  await browser.load('资料')
  browser.togglePick('a')
  api.downloadShare.mockResolvedValueOnce({ ok: true, canceled: true })
  await browser.download(true)
  expect(api.downloadShare).toHaveBeenLastCalledWith('alice', ['资料/a'], true)
  expect(browser.picked.value.has('a')).toBe(true)
  api.downloadShare.mockResolvedValueOnce({ ok: true })
  await browser.download(false)
  expect(browser.picked.value.size).toBe(0)
  expect(browser.note.value).toBe('已开始下载')
})

it('只读不上传，拖入路径经授权后上传；切换联系人不误发文件', async () => {
  let peerId = 'alice'
  const browser = useShareBrowser(() => peerId)
  await browser.upload(false)
  expect(api.uploadShare).not.toHaveBeenCalled()
  browser.perm.value = 'write'
  api.grantFilePaths.mockResolvedValueOnce(['/allowed'])
  api.uploadShare.mockResolvedValueOnce({ ok: true, fileCount: 1 })
  await browser.uploadDropped(['/allowed', '/denied'])
  expect(api.uploadShare).toHaveBeenLastCalledWith('alice', ['/allowed'])
  expect(browser.note.value).toBe('正在上传 1 个文件')
  api.grantFilePaths.mockImplementationOnce(async () => {
    peerId = 'bob'
    browser.resetBrowse()
    return ['/allowed']
  })
  await browser.uploadDropped(['/allowed'])
  expect(api.uploadShare).toHaveBeenCalledTimes(1)
  expect(browser.uploading.value).toBe(false)
})

it('传输进度只接收当前联系人文件柜任务，完成后可定位文件', () => {
  const browser = useShareBrowser(() => 'alice')
  const transfer: TransferView = {
    transferId: 't', msgId: 'share:t', convId: '', peerId: 'alice', direction: 'in',
    status: 'accepted', bytesDone: 50, totalSize: 100, fileCount: 1, name: 'a',
    expiresAt: 0, savedPath: '', direct: false
  }
  browser.updateTransfer({ ...transfer, peerId: 'bob' })
  browser.updateTransfer({ ...transfer, msgId: 'chat:t' })
  expect(browser.transfer.value).toBeNull()
  browser.updateTransfer(transfer)
  expect(browser.progressPercent.value).toBe(50)
  expect(browser.transferActive.value).toBe(true)
  browser.cancelTransfer()
  expect(api.cancelTransfer).toHaveBeenCalledWith('t')
  browser.updateTransfer({ ...transfer, status: 'done', bytesDone: 100 })
  expect(browser.note.value).toBe('下载完成')
  browser.revealTransfer()
  expect(api.revealTransfer).toHaveBeenCalledWith('t')
})
