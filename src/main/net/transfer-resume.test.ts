import { afterEach, describe, expect, it } from 'vitest'
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { encodeFrame, FrameReader } from './frame'
import { pullTransfer, TransferServer, type ReadStreamFactory, type WriteStreamFactory } from './transfer'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const body = Buffer.from('abcdefghijklmnop')
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-resume-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function slowRead(bytes: Buffer, ms: number): ReturnType<ReadStreamFactory> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Readable({
    read() {
      if (timer) return
      timer = setTimeout(() => { this.push(bytes); this.push(null) }, ms)
    },
    destroy(error, done) { clearTimeout(timer); done(error) }
  }) as ReturnType<ReadStreamFactory>
}
async function server(options: { slowHash?: boolean } = {}): Promise<number> {
  const src = directory()
  writeFileSync(join(src, 'file'), body)
  const instance = new TransferServer(0, {
    resolve: (_id, fileId) => ({ fileId, absPath: join(src, 'file'), size: body.length }),
    supportsWait: () => true
  }, '127.0.0.1', options.slowHash ? () => slowRead(body, 350) : createReadStream,
  { handshakeTimeoutMs: 40, idleTimeoutMs: 200, waitHeartbeatMs: 80 })
  await instance.start()
  cleanup.push(() => instance.stop())
  // 只在测试中读取内核分配的回环端口，避免固定端口冲突。
  const listener = (instance as unknown as { server: import('node:net').Server }).server
  return (listener.address() as import('node:net').AddressInfo).port
}
function options(port: number, dst: string) {
  return {
    host: '127.0.0.1', port, selfId: 'receiver', transferId: 'resume', saveDir: dst,
    files: [{ fileId: 'f', relPath: 'file', size: body.length }],
    cancelRef: { canceled: false, socket: null as Socket | null }, onProgress: () => undefined,
    supportsWait: true, idleTimeoutMs: 200, waitHeartbeatMs: 80
  }
}

describe('断点预哈希与终态回收（#53）', () => {
  it('首个 wait 立即越过握手期限，多文件预哈希可跨越多个空闲窗口', async () => {
    const dst = directory(), port = await server()
    for (const name of ['file', 'second']) writeFileSync(join(dst, `${name}.part`), body.subarray(0, 8))
    const opened: ReturnType<ReadStreamFactory>[] = []
    await pullTransfer({ ...options(port, dst),
      files: ['file', 'second'].map(relPath => ({ fileId: relPath, relPath, size: body.length })),
      openReadStream: () => { const stream = slowRead(body.subarray(0, 8), 450); opened.push(stream); return stream }
    })
    for (const name of ['file', 'second']) expect(readFileSync(join(dst, name))).toEqual(body)
    expect(opened).toHaveLength(2)
    expect(opened.every(stream => stream.destroyed)).toBe(true)
  })

  it.each([true, false])('预哈希时取消可立即回收，不再 pull 或打开写流（tw1=%s）', async supportsWait => {
    const dst = directory(), port = await server()
    writeFileSync(join(dst, 'file.part'), body.subarray(0, 8))
    const opts = options(port, dst), opened = slowRead(body.subarray(0, 8), 400)
    const phases: string[] = []; let writes = 0
    const result = pullTransfer({ ...opts, supportsWait,
      openReadStream: () => { setTimeout(() => { opts.cancelRef.canceled = true; opts.cancelRef.socket?.destroy() }, 20); return opened },
      openWriteStream: (path, flags) => { writes++; return createWriteStream(path, flags) },
      onPhase: stage => phases.push(stage)
    })
    await expect(result).rejects.toThrow(/closed|canceled/)
    expect(opened.destroyed).toBe(true)
    await delay(450)
    expect(phases).not.toContain('pull')
    expect(writes).toBe(0)
    expect(readFileSync(join(dst, 'file.part'))).toEqual(body.subarray(0, 8))
  })

  it('预哈希时远端断开也终止读流与迟到回调', async () => {
    const dst = directory()
    writeFileSync(join(dst, 'file.part'), body.subarray(0, 8))
    const listener = createServer(socket => { socket.on('error', () => undefined); setTimeout(() => socket.destroy(), 30) })
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => listener.close(() => resolve())))
    const opened = slowRead(body.subarray(0, 8), 300); let writes = 0
    await expect(pullTransfer({ ...options((listener.address() as import('node:net').AddressInfo).port, dst),
      openReadStream: () => opened, openWriteStream: (path, flags) => { writes++; return createWriteStream(path, flags) }
    })).rejects.toThrow('closed')
    await delay(350)
    expect(opened.destroyed).toBe(true)
    expect(writes).toBe(0)
  })

  it('旧端拒绝 wait 时，逐个慢断点文件在预哈希后重连，整个传输只发送一次 finish', async () => {
    const dst = directory(), frames: string[] = [], sockets = new Set<Socket>()
    for (const name of ['file', 'second']) writeFileSync(join(dst, `${name}.part`), body.subarray(0, 8))
    const listener = createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => undefined)
      socket.setTimeout(40, () => socket.destroy())
      const reader = new FrameReader(frame => {
        frames.push(frame.type)
        if (frame.type === 'wait') { socket.destroy(); return }
        if (frame.type === 'pull') socket.write(Buffer.concat([
          encodeFrame({ type: 'pull-ok', fileId: frame.fileId, len: body.length - frame.offset }),
          body.subarray(frame.offset),
          encodeFrame({ type: 'done', fileId: frame.fileId, sha256: createHash('sha256').update(body).digest('hex') })
        ]))
      }, () => undefined, () => socket.destroy())
      socket.on('data', bytes => reader.feed(bytes))
    })
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => listener.close(() => resolve())) })
    await pullTransfer({ ...options((listener.address() as import('node:net').AddressInfo).port, dst), supportsWait: false,
      files: ['file', 'second'].map(relPath => ({ fileId: relPath, relPath, size: body.length })),
      openReadStream: () => slowRead(body.subarray(0, 8), 300)
    })
    await delay(20)
    expect(frames).toEqual(['pull', 'pull', 'finish'])
    for (const name of ['file', 'second']) expect(readFileSync(join(dst, name))).toEqual(body)
  })

  it('完整 .part 没有尾数据流时，发送端哈希收尾仍保活', async () => {
    const dst = directory(), port = await server({ slowHash: true })
    writeFileSync(join(dst, 'file.part'), body)
    await pullTransfer(options(port, dst))
    expect(readFileSync(join(dst, 'file'))).toEqual(body)
  })

  it('最终写盘尚未结束时取消，销毁写流且不 rename 或进入下一文件', async () => {
    const dst = directory(), port = await server(), opts = options(port, dst)
    let finalStarted!: () => void
    const final = new Promise<void>(resolve => { finalStarted = resolve })
    let finishWrite!: () => void
    let stream!: Writable
    const phases: string[] = []
    const result = pullTransfer({ ...opts, onPhase: stage => phases.push(stage),
      openWriteStream: (path) => {
        writeFileSync(path, '')
        stream = new Writable({ write(chunk, _encoding, done) { writeFileSync(path, chunk, { flag: 'a' }); done() },
          final(done) { finishWrite = done; finalStarted() }
        })
        return stream as ReturnType<WriteStreamFactory>
      }
    })
    const rejected = expect(result).rejects.toThrow(/closed|canceled/)
    await final
    opts.cancelRef.canceled = true
    opts.cancelRef.socket?.destroy()
    await rejected
    expect(stream.destroyed).toBe(true)
    finishWrite()
    await delay(30)
    expect(existsSync(join(dst, 'file'))).toBe(false)
    expect(readFileSync(join(dst, 'file.part'))).toEqual(body)
    expect(phases).not.toContain('write')
    expect(phases).not.toContain('complete')
  })
})
