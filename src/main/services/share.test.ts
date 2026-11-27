import { afterAll, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  evaluateShareRoot,
  fitSharePage,
  listShareDirectory,
  resolveWithinRoot,
  sanitizeSharePath,
  ShareDownloadGate,
  shareDownloadDirName,
  ShareService,
  shareUploadDirName,
  type ShareGrantsStore
} from './share'
import {
  SHARE_DIR_MAX_ENTRIES,
  SHARE_GET_MAX_PATHS,
  SHARE_LIST_PAGE,
  SHARE_LIST_RATE_MAX,
  SHARE_PUT_MAX_BYTES,
  SHARE_SNAPSHOT_TTL,
  type ShareEntry,
  type ShareMode
} from '../../shared/protocol'
import type { ShareGrantRecord } from '../store/share-grants-repo'

const tmpRoots: string[] = []
afterAll(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// 共享文件柜的两条底线（决议 #271/#276）：
// ① 权限判定只看本机配置；② 共享根不许落在会连带暴露隐私的位置。

const HOME = '/home/tea'
const DATA_ROOT = '/home/tea/.config/pantry/data'
const CTX = { home: HOME, dataRoot: DATA_ROOT, caseInsensitive: false }

describe('evaluateShareRoot（共享根策略，决议 #276）', () => {
  it('普通目录放行，并返回归一化后的绝对路径', () => {
    // 用 resolve 做期望值：Windows 上 '/home/tea/共享' 会归一到 'C:\\home\\tea\\共享'
    expect(evaluateShareRoot('/home/tea/共享', CTX)).toEqual({
      ok: true,
      path: resolve('/home/tea/共享')
    })
    expect(evaluateShareRoot('/home/tea/共享/', CTX)).toEqual({
      ok: true,
      path: resolve('/home/tea/共享')
    })
  })

  it('空值与相对路径拒绝', () => {
    expect(evaluateShareRoot('', CTX)).toEqual({ ok: false, reason: 'empty' })
    expect(evaluateShareRoot('   ', CTX)).toEqual({ ok: false, reason: 'empty' })
    expect(evaluateShareRoot('共享', CTX)).toEqual({ ok: false, reason: 'relative' })
    expect(evaluateShareRoot('./共享', CTX)).toEqual({ ok: false, reason: 'relative' })
  })

  it('文件系统根与用户主目录根拒绝', () => {
    expect(evaluateShareRoot('/', CTX)).toEqual({ ok: false, reason: 'fs-root' })
    expect(evaluateShareRoot(HOME, CTX)).toEqual({ ok: false, reason: 'home' })
    expect(evaluateShareRoot(`${HOME}/`, CTX)).toEqual({ ok: false, reason: 'home' })
  })

  it('与应用数据目录相互包含都拒绝——否则会连 chat.db、日志一起共享出去', () => {
    expect(evaluateShareRoot(DATA_ROOT, CTX)).toEqual({ ok: false, reason: 'app-data' })
    // 数据目录内部
    expect(evaluateShareRoot(join(DATA_ROOT, 'images'), CTX)).toEqual({
      ok: false,
      reason: 'app-data'
    })
    // 数据目录的祖先
    expect(evaluateShareRoot('/home/tea/.config/pantry', CTX)).toEqual({
      ok: false,
      reason: 'app-data'
    })
    expect(evaluateShareRoot('/home/tea/.config', CTX)).toEqual({
      ok: false,
      reason: 'app-data'
    })
  })

  it('同名前缀的兄弟目录不算包含，应放行', () => {
    expect(evaluateShareRoot('/home/tea/.config/pantry-shared', CTX).ok).toBe(true)
    expect(evaluateShareRoot(`${DATA_ROOT}-backup`, CTX).ok).toBe(true)
  })

  it('大小写不敏感的文件系统上，改个大小写不能绕过', () => {
    const ctx = { home: HOME, dataRoot: DATA_ROOT, caseInsensitive: true }
    expect(evaluateShareRoot('/HOME/TEA', ctx)).toEqual({ ok: false, reason: 'home' })
    expect(evaluateShareRoot('/home/tea/.CONFIG/Pantry/DATA', ctx)).toEqual({
      ok: false,
      reason: 'app-data'
    })
    // 区分大小写的系统上它们是不同目录，放行
    expect(evaluateShareRoot('/HOME/TEA', CTX).ok).toBe(true)
  })
})

class FakeGrants implements ShareGrantsStore {
  readonly rows = new Map<string, ShareMode>()

  list(): ShareGrantRecord[] {
    return [...this.rows].map(([nodeId, mode]) => ({ nodeId, mode, updatedTs: 0 }))
  }

  loadAll(): Map<string, ShareMode> {
    return new Map(this.rows)
  }

  set(nodeId: string, mode: ShareMode | null): void {
    if (mode === null) this.rows.delete(nodeId)
    else this.rows.set(nodeId, mode)
  }
}

function makeService(
  root: string,
  mode: ShareMode,
  seed: Array<[string, ShareMode]> = []
): { service: ShareService; grants: FakeGrants } {
  const grants = new FakeGrants()
  for (const [nodeId, m] of seed) grants.rows.set(nodeId, m)
  const service = new ShareService({
    getRoot: () => root,
    getDefaultMode: () => mode,
    getGrants: () => grants
  })
  return { service, grants }
}

describe('ShareService 权限判定（决议 #271）', () => {
  it('没设共享根时一律 off，哪怕默认档和例外都开着', () => {
    const { service } = makeService('', 'write', [['bob', 'write']])
    expect(service.modeFor('bob')).toBe('off')
    expect(service.modeFor('anyone')).toBe('off')
    expect(service.isEnabled()).toBe(false)
  })

  it('无例外时回落默认档', () => {
    const { service } = makeService('/srv/share', 'read')
    expect(service.modeFor('bob')).toBe('read')
    expect(service.grantFor('bob')).toBeNull()
  })

  it('例外可以调高，也可以调低', () => {
    const { service } = makeService('/srv/share', 'read', [
      ['up', 'write'],
      ['down', 'off']
    ])
    expect(service.modeFor('up')).toBe('write')
    expect(service.modeFor('down')).toBe('off')
    expect(service.modeFor('other')).toBe('read')
  })

  it('默认不共享时，单个例外就能让文件柜对外可用', () => {
    const { service } = makeService('/srv/share', 'off')
    expect(service.isEnabled()).toBe(false)
    service.setGrant('bob', 'read')
    expect(service.isEnabled()).toBe(true)
    expect(service.modeFor('bob')).toBe('read')
    expect(service.modeFor('alice')).toBe('off')
  })

  it('例外置 null 即恢复跟随默认档，并从存储里删掉', () => {
    const { service, grants } = makeService('/srv/share', 'read', [['bob', 'write']])
    expect(service.modeFor('bob')).toBe('write')
    service.setGrant('bob', null)
    expect(service.modeFor('bob')).toBe('read')
    expect(service.grantFor('bob')).toBeNull()
    expect(grants.rows.has('bob')).toBe(false)
  })

  it('写入例外会落到存储，reload 后仍在', () => {
    const { service, grants } = makeService('/srv/share', 'off')
    service.setGrant('bob', 'write')
    expect(grants.rows.get('bob')).toBe('write')
    service.reload()
    expect(service.modeFor('bob')).toBe('write')
  })

  it('库不可用时例外退化为内存态，判定照常', () => {
    const service = new ShareService({
      getRoot: () => '/srv/share',
      getDefaultMode: () => 'off',
      getGrants: () => null
    })
    service.setGrant('bob', 'read')
    expect(service.modeFor('bob')).toBe('read')
    expect(service.listGrants()).toEqual([])
    service.reload() // 无存储可回灌，例外清空但不应抛错
    expect(service.modeFor('bob')).toBe('off')
  })
})

// ---------- 第 ② 步：目录列举、分页快照、限流与下载授权 ----------

describe('sanitizeSharePath（相对路径清洗，§8.2）', () => {
  it('空串表示共享根，普通相对路径原样返回', () => {
    expect(sanitizeSharePath('')).toBe('')
    expect(sanitizeSharePath('设计稿')).toBe('设计稿')
    expect(sanitizeSharePath('设计稿/2026/切图')).toBe('设计稿/2026/切图')
  })

  it('越权与畸形路径一律拒绝', () => {
    expect(sanitizeSharePath('../etc')).toBeNull()
    expect(sanitizeSharePath('a/../../etc')).toBeNull()
    expect(sanitizeSharePath('a/./b')).toBeNull()
    expect(sanitizeSharePath('/etc/passwd')).toBeNull()
    expect(sanitizeSharePath('\\\\server\\share')).toBeNull()
    expect(sanitizeSharePath('C:/Windows')).toBeNull()
    expect(sanitizeSharePath('a\\b')).toBeNull()
    expect(sanitizeSharePath('a//b')).toBeNull()
    expect(sanitizeSharePath('a/')).toBeNull()
    expect(sanitizeSharePath(123)).toBeNull()
  })

  it('深度与长度超限拒绝', () => {
    expect(sanitizeSharePath(Array(16).fill('a').join('/'))).not.toBeNull()
    expect(sanitizeSharePath(Array(17).fill('a').join('/'))).toBeNull()
    expect(sanitizeSharePath('x'.repeat(256))).toBeNull()
  })
})

describe('目录列举与越界防护（决议 #276）', () => {
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'pantry-share-root-'))
    tmpRoots.push(root)
    return root
  }

  it('目录在前、再按名称；隐藏项不列出', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'b目录'))
    mkdirSync(join(root, 'a目录'))
    writeFileSync(join(root, 'z.txt'), 'zz')
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, '.隐藏'), 'secret')
    mkdirSync(join(root, '.git'))

    const listing = listShareDirectory(root, '')
    expect(listing?.entries.map((e) => e.name)).toEqual(['a目录', 'b目录', 'a.txt', 'z.txt'])
    expect(listing?.entries[0].isDir).toBe(true)
    expect(listing?.entries.find((e) => e.name === 'z.txt')?.size).toBe(2)
    expect(listing?.truncated).toBe(false)
  })

  it('指向共享根之外的符号链接不列出，也解析不出来', () => {
    const root = makeRoot()
    const outside = makeRoot()
    writeFileSync(join(outside, '机密.txt'), 'top secret')
    writeFileSync(join(root, '正常.txt'), 'ok')
    try {
      symlinkSync(outside, join(root, '外链'))
      symlinkSync(join(outside, '机密.txt'), join(root, '外链文件.txt'))
    } catch {
      return // 无权建符号链接的环境（如未开开发者模式的 Windows）跳过
    }
    const listing = listShareDirectory(root, '')
    expect(listing?.entries.map((e) => e.name)).toEqual(['正常.txt'])
    expect(resolveWithinRoot(root, '外链')).toBeNull()
    expect(resolveWithinRoot(root, '外链文件.txt')).toBeNull()
    expect(resolveWithinRoot(root, '正常.txt')).not.toBeNull()
  })

  it('不存在的路径与非目录返回 null', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'f.txt'), 'x')
    expect(listShareDirectory(root, '不存在')).toBeNull()
    expect(listShareDirectory(root, 'f.txt')).toBeNull()
    expect(listShareDirectory('', '')).toBeNull()
  })

  // 决议 #280：早先是"读满 5000 条就 break、之后才排序"，
  // 入选的是文件系统返回顺序的前 5000 条，换台机器看到的内容都可能不同
  it('超过上限的目录先按全量排序再截断，入选的是排序意义上的前 5000 条', () => {
    const root = makeRoot()
    const total = SHARE_DIR_MAX_ENTRIES + 1
    for (let i = 1; i <= total; i++) {
      writeFileSync(join(root, `f${String(i).padStart(5, '0')}.txt`), '')
    }
    const listing = listShareDirectory(root, '')
    expect(listing?.truncated).toBe(true)
    expect(listing?.entries.length).toBe(SHARE_DIR_MAX_ENTRIES)
    expect(listing?.entries[0].name).toBe('f00001.txt')
    expect(listing?.entries[SHARE_DIR_MAX_ENTRIES - 1].name).toBe('f05000.txt')
    expect(listing?.entries.some((e) => e.name === 'f05001.txt')).toBe(false)
  })
})

describe('fitSharePage（分页，§8.2）', () => {
  const entry = (name: string): ShareEntry => ({ name, size: 1, isDir: false, mtime: 1 })

  it('单页不超过条目上限', () => {
    const entries = Array.from({ length: SHARE_LIST_PAGE + 50 }, (_, i) => entry(`f${i}`))
    expect(fitSharePage(entries, 0)).toHaveLength(SHARE_LIST_PAGE)
    expect(fitSharePage(entries, SHARE_LIST_PAGE)[0].name).toBe(`f${SHARE_LIST_PAGE}`)
  })

  it('超长文件名下按信封字节收窄，且至少给一条', () => {
    // 每条约 650B，80 条稳超 32KiB 信封上限
    const long = Array.from({ length: 80 }, (_, i) => entry(`${'名'.repeat(200)}${i}`))
    const page = fitSharePage(long, 0)
    expect(page.length).toBeGreaterThan(0)
    expect(page.length).toBeLessThan(long.length)
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(32 * 1024)
    const huge: ShareEntry[] = [entry('巨'.repeat(255))]
    expect(fitSharePage(huge, 0)).toHaveLength(1)
  })
})

describe('ShareService 应答 list / get（§8.2）', () => {
  function serviceWithRoot(mode: ShareMode = 'read'): { service: ShareService; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'pantry-share-svc-'))
    tmpRoots.push(root)
    const service = new ShareService({
      getRoot: () => root,
      getDefaultMode: () => mode,
      getGrants: () => null
    })
    return { service, root }
  }

  it('未开放的联系人只拿到 deny，探不出目录是否存在', () => {
    const { service, root } = serviceWithRoot('off')
    writeFileSync(join(root, '在的.txt'), 'x')
    expect(service.handleList('bob', { reqId: 'r1', path: '', offset: 0 })).toEqual({
      op: 'deny',
      reqId: 'r1',
      reason: 'off'
    })
    expect(service.handleList('bob', { reqId: 'r2', path: '不存在', offset: 0 })).toEqual({
      op: 'deny',
      reqId: 'r2',
      reason: 'off'
    })
    expect(service.handleGet('bob', ['在的.txt'])).toEqual({ ok: false, reason: 'off' })
  })

  it('perm 如实回报有效权限，对端据此决定是否显示上传入口', () => {
    const writable = serviceWithRoot('write')
    writeFileSync(join(writable.root, 'a.txt'), 'x')
    const w = writable.service.handleList('bob', { reqId: 'r', path: '', offset: 0 })
    expect(w.op === 'list-ok' && w.perm).toBe('write')

    const readable = serviceWithRoot('read')
    writeFileSync(join(readable.root, 'a.txt'), 'x')
    const r = readable.service.handleList('bob', { reqId: 'r', path: '', offset: 0 })
    expect(r.op === 'list-ok' && r.perm).toBe('read')
  })

  it('翻页用同一快照，快照过期或换人则要求从头来', () => {
    const { service, root } = serviceWithRoot()
    for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${i}.txt`), 'x')
    const first = service.handleList('bob', { reqId: 'r1', path: '', offset: 0 }, 1000)
    expect(first.op).toBe('list-ok')
    if (first.op !== 'list-ok') return
    expect(first.total).toBe(5)

    // 翻页期间新增文件不影响本次快照，避免错位
    writeFileSync(join(root, 'f9.txt'), 'x')
    const second = service.handleList(
      'bob',
      { reqId: 'r2', path: '', offset: 2, snapshotId: first.snapshotId },
      1500
    )
    expect(second.op).toBe('list-ok')
    if (second.op === 'list-ok') expect(second.total).toBe(5)

    // 别人拿着同一个快照 ID 也不行
    expect(
      service.handleList(
        'mallory',
        { reqId: 'r3', path: '', offset: 2, snapshotId: first.snapshotId },
        1500
      )
    ).toEqual({ op: 'deny', reqId: 'r3', reason: 'gone' })

    // 超过存活时间即失效
    expect(
      service.handleList(
        'bob',
        { reqId: 'r4', path: '', offset: 2, snapshotId: first.snapshotId },
        1000 + SHARE_SNAPSHOT_TTL + 1
      )
    ).toEqual({ op: 'deny', reqId: 'r4', reason: 'gone' })
  })

  it('更换共享根后，旧目录的分页快照立即失效', () => {
    let root = mkdtempSync(join(tmpdir(), 'pantry-share-old-'))
    tmpRoots.push(root)
    const service = new ShareService({
      getRoot: () => root,
      getDefaultMode: () => 'read',
      getGrants: () => null
    })
    const req = { reqId: 'r', path: '', offset: 0 }
    const first = service.handleList('bob', req)
    expect(first.op).toBe('list-ok')
    if (first.op !== 'list-ok') return
    root = mkdtempSync(join(tmpdir(), 'pantry-share-new-'))
    tmpRoots.push(root)
    expect(service.handleList('bob', { ...req, snapshotId: first.snapshotId })).toMatchObject({ op: 'deny', reason: 'gone' })
  })

  it('同一对端列目录限流，超出回 busy；窗口滑过后恢复', () => {
    const { service } = serviceWithRoot()
    for (let i = 0; i < SHARE_LIST_RATE_MAX; i += 1) {
      expect(service.handleList('bob', { reqId: `r${i}`, path: '', offset: 0 }, 1000).op).toBe(
        'list-ok'
      )
    }
    expect(service.handleList('bob', { reqId: 'over', path: '', offset: 0 }, 1000)).toEqual({
      op: 'deny',
      reqId: 'over',
      reason: 'busy'
    })
    // 换个人不受影响
    expect(service.handleList('carol', { reqId: 'c', path: '', offset: 0 }, 1000).op).toBe('list-ok')
    expect(
      service.handleList('bob', { reqId: 'later', path: '', offset: 0 }, 1000 + 10_001).op
    ).toBe('list-ok')
  })

  it('get 逐条复核路径，任何一条越界就整体拒绝', () => {
    const { service, root } = serviceWithRoot()
    writeFileSync(join(root, 'a.txt'), 'x')
    writeFileSync(join(root, 'b.txt'), 'x')
    const ok = service.handleGet('bob', ['a.txt', 'b.txt'])
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.absPaths).toHaveLength(2)

    expect(service.handleGet('bob', ['a.txt', '../外面.txt'])).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(service.handleGet('bob', ['a.txt', '不存在.txt'])).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(service.handleGet('bob', [''])).toEqual({ ok: false, reason: 'not-found' })
    expect(service.handleGet('bob', [])).toEqual({ ok: false, reason: 'not-found' })
    expect(
      service.handleGet('bob', Array.from({ length: SHARE_GET_MAX_PATHS + 1 }, () => 'a.txt'))
    ).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('ShareDownloadGate（下载一次性授权，决议 #275）', () => {
  it('只对授权过的来源放行，且只放行一次', () => {
    const gate = new ShareDownloadGate()
    expect(gate.consume('bob', 1000)).toBeNull()
    gate.begin('bob', '/tmp/down', 60_000, 1000)
    expect(gate.consume('mallory', 1000)).toBeNull()
    expect(gate.consume('bob', 1000)).toBe('/tmp/down')
    expect(gate.consume('bob', 1000)).toBeNull()
  })

  it('超时的授权不再放行', () => {
    const gate = new ShareDownloadGate()
    gate.begin('bob', '/tmp/down', 60_000, 1000)
    expect(gate.consume('bob', 61_001)).toBeNull()
  })

  it('撤销后立即失效', () => {
    const gate = new ShareDownloadGate()
    const grant = gate.begin('bob', '/tmp/down', 60_000, 1000)
    gate.cancel(grant)
    expect(gate.consume('bob', 1000)).toBeNull()
  })

  // 决议 #280：早先按 peerId 覆盖，第二次登记会把第一次的落点顶掉
  it('同一对端的多次下载按登记顺序先进先出，落点不互相顶掉', () => {
    const gate = new ShareDownloadGate()
    gate.begin('bob', '/tmp/first', 60_000, 1000)
    gate.begin('bob', '/tmp/second', 60_000, 1200)
    expect(gate.consume('bob', 1300)).toBe('/tmp/first')
    expect(gate.consume('bob', 1300)).toBe('/tmp/second')
    expect(gate.consume('bob', 1300)).toBeNull()
  })

  it('撤销只影响本次句柄，不动同一对端的其他在途授权', () => {
    const gate = new ShareDownloadGate()
    gate.begin('bob', '/tmp/first', 60_000, 1000)
    const second = gate.begin('bob', '/tmp/second', 60_000, 1200)
    gate.cancel(second)
    expect(gate.consume('bob', 1300)).toBe('/tmp/first')
    expect(gate.consume('bob', 1300)).toBeNull()
  })

  it('isPending 只认本次句柄，被消费后即为假', () => {
    const gate = new ShareDownloadGate()
    const grant = gate.begin('bob', '/tmp/down', 60_000, 1000)
    expect(gate.isPending(grant, 1000)).toBe(true)
    expect(gate.isPending(grant, 61_001)).toBe(false) // 过期
    expect(gate.consume('bob', 1000)).toBe('/tmp/down')
    expect(gate.isPending(grant, 1000)).toBe(false)
  })
})

describe('shareDownloadDirName（默认落点）', () => {
  it('加「文件柜-」前缀，和聊天里收到的文件目录分开', () => {
    expect(shareDownloadDirName('张三')).toBe('文件柜-张三')
  })

  it('剥掉路径分隔符与保留字符，空名兜底', () => {
    expect(shareDownloadDirName('a/b\\c')).toBe('文件柜-a b c')
    expect(shareDownloadDirName('  ')).toBe('文件柜-未知节点')
    expect(shareDownloadDirName('..')).toBe('文件柜-未知节点')
  })
})

describe('ShareService.handlePut（上传落点与写权限，决议 #272）', () => {
  function svc(mode: ShareMode): { service: ShareService; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'pantry-share-put-'))
    tmpRoots.push(root)
    return {
      service: new ShareService({
        getRoot: () => root,
        getDefaultMode: () => mode,
        getGrants: () => null
      }),
      root
    }
  }

  it('只读与不共享一律拒绝上传', () => {
    expect(svc('read').service.handlePut('bob', 10, '张三')).toBeNull()
    expect(svc('off').service.handlePut('bob', 10, '张三')).toBeNull()
  })

  it('可读可传时落到共享根下以上传者命名的子目录', () => {
    const { service, root } = svc('write')
    expect(service.handlePut('bob', 10, '张三')).toBe(join(realpathSync(root), '张三'))
  })

  it('上传者名字里的分隔符被剥掉，无法越级写到共享根之外', () => {
    const { service, root } = svc('write')
    const real = realpathSync(root)
    // 关键是"落点必须仍在共享根正下方且只有一层"，具体清洗后的名字长什么样不重要
    for (const evil of ['../../etc', 'a/b', 'a\\b', '..', '  ']) {
      const target = service.handlePut('bob', 10, evil)
      expect(target).not.toBeNull()
      expect(dirname(target!)).toBe(real)
      expect(basename(target!)).not.toBe('..')
      expect(basename(target!)).not.toBe('.')
    }
    expect(service.handlePut('bob', 10, '  ')).toBe(join(real, '未知节点'))
  })

  it('按人例外能单独放开上传', () => {
    const { service, root } = svc('read')
    expect(service.handlePut('bob', 10, '张三')).toBeNull()
    service.setGrant('bob', 'write')
    expect(service.handlePut('bob', 10, '张三')).toBe(join(realpathSync(root), '张三'))
  })

  it('超过单次上传上限或非法大小拒绝', () => {
    const { service } = svc('write')
    expect(service.handlePut('bob', SHARE_PUT_MAX_BYTES, '张三')).not.toBeNull()
    expect(service.handlePut('bob', SHARE_PUT_MAX_BYTES + 1, '张三')).toBeNull()
    expect(service.handlePut('bob', -1, '张三')).toBeNull()
    expect(service.handlePut('bob', 1.5, '张三')).toBeNull()
  })

  it('共享根不存在时拒绝', () => {
    const service = new ShareService({
      getRoot: () => join(tmpdir(), 'pantry-不存在的共享根'),
      getDefaultMode: () => 'write',
      getGrants: () => null
    })
    expect(service.handlePut('bob', 10, '张三')).toBeNull()
  })
})

describe('shareUploadDirName（上传落点目录名）', () => {
  it('直接用清洗后的显示名，不加前缀', () => {
    expect(shareUploadDirName('张三')).toBe('张三')
    expect(shareUploadDirName('a/b\\c')).toBe('a b c')
    expect(shareUploadDirName('..')).toBe('未知节点')
    expect(shareUploadDirName('CON.txt')).toBe('_CON.txt')
    expect(shareUploadDirName('nul')).toBe('_nul')
    expect(shareUploadDirName('张三. ')).toBe('张三')
  })
})
