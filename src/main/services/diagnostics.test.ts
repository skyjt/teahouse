import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticsService, diagnosticError, writeDiagnosticBundle } from './diagnostics'
import { readZip } from '../util/zip-store'

const directories: string[] = []
const services: DiagnosticsService[] = []
async function fixture(): Promise<{ dir: string; log: DiagnosticsService }> {
  const dir = await mkdtemp(join(tmpdir(), 'pantry-diagnostics-'))
  directories.push(dir)
  const log = new DiagnosticsService(join(dir, 'logs'))
  services.push(log)
  await log.ready
  return { dir, log }
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(log => log.close()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

it('默认 ZIP 两次脱敏，保留关联 ID/系统码；真实地址须显式选择，复制摘要无需读取业务数据', async () => {
  const { dir, log } = await fixture()
  const id = randomUUID()
  const error = Object.assign(new Error('/Users/某人/工资表.xlsx 聊天正文 token=secret'), { code: 'EACCES' })
  error.stack = 'Error: 聊天正文\n    at private (/Users/某人/项目/out/main/index.js:120:4)'
  log.record('transfer.error', { transferId: id, peerId: 'user-secret', host: '10.20.30.40',
    reason: 'write-error', stage: 'write', body: '聊天正文', path: '/Users/某人/工资表.xlsx', token: 'secret' }, error)
  await log.flush()
  const forged = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.jsonl`
  await writeFile(join(log.directory, forged), JSON.stringify({ at: new Date().toISOString(), runId: log.runId,
    event: 'message.state', body: '聊天正文', host: '10.20.30.40', errorCode: '/Users/某人', errorType: '私密姓名' }) + '\n')
  const privateFile = join(dir, 'private.txt')
  await writeFile(privateFile, 'secret-symlink')
  await symlink(privateFile, join(log.directory, `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.jsonl`))
  const target = join(dir, '诊断.zip')
  await log.exportBundle(target, { version: '0.60.0' }, false, writeDiagnosticBundle)
  const zip = readZip(target)
  const text = [...zip.values()].map(bytes => bytes.toString()).join('\n')
  for (const secret of ['聊天正文', '工资表', '/Users/', 'token=', 'secret', '10.20.30.40', 'user-secret', '私密姓名']) expect(text).not.toContain(secret)
  expect(text).toContain(id)
  expect(text).toContain('EACCES')
  expect(text).toContain('index.js:120:4')
  expect(text).toContain('write-error')
  expect(zip.has('network-addresses.json')).toBe(false)
  await log.exportBundle(target, {}, true, writeDiagnosticBundle)
  const addresses = JSON.parse(readZip(target).get('network-addresses.json')!.toString())
  expect(addresses).toContainEqual({ alias: log.alias('10.20.30.40'), address: '10.20.30.40' })
  expect(log.exportedPath()).toBe(target)
  expect((await readdir(dir)).some(name => name.endsWith('.tmp'))).toBe(false)
})

it('保留异常退出标记与致命异常元数据，正常关闭清理标记，匿名标识跨重启稳定', async () => {
  const { log } = await fixture()
  const alias = log.alias('192.168.1.8')
  const error = Object.assign(new TypeError('private-content'), { code: 'ERR_TEST_FAILURE', stack: 'Error: private-content\n at /private/Index-' + 'a'.repeat(6000) + '.js:1:1' })
  log.fatal(error)
  await log.flush()
  const fatalFiles = (await readdir(log.directory)).filter(name => name.endsWith('.jsonl'))
  for (const name of fatalFiles) expect((await stat(join(log.directory, name))).size).toBeLessThan(2048)
  const restarted = new DiagnosticsService(log.directory)
  services.push(restarted)
  const earlyAlias = restarted.alias('192.168.1.8')
  await restarted.ready
  expect(earlyAlias).toBe(alias)
  expect(restarted.status().previousExit).toBe('unclean')
  expect(restarted.alias('192.168.1.8')).toBe(alias)
  await restarted.close()
  await expect(stat(join(log.directory, 'running.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const clean = new DiagnosticsService(log.directory)
  services.push(clean)
  await clean.ready
  expect(clean.status().previousExit).toBe('clean-or-first-run')
})

it('日志轮转/保留上限、突发队列和重复事件均受限', async () => {
  const { log } = await fixture()
  await log.flush()
  const today = new Date().toISOString().slice(0, 10)
  const old = `2000-01-01-${randomUUID()}.jsonl`
  await writeFile(join(log.directory, old), 'expired\n')
  for (let i = 0; i < 12; i++) await writeFile(join(log.directory, `${today}-${randomUUID()}.jsonl`), Buffer.alloc(1024 * 1024, 32))
  for (let i = 0; i < 100; i++) log.record('network.listen', { status: 'failed', kind: 'udp', port: 17878 })
  await log.flush()
  for (let i = 0; i < 5000; i++) log.record('message.state', { id: randomUUID(), status: 'sent' })
  await log.flush()
  const files = (await readdir(log.directory)).filter(name => name.endsWith('.jsonl'))
  expect(files).not.toContain(old)
  const sizes = await Promise.all(files.map(name => stat(join(log.directory, name))))
  expect(sizes.reduce((sum, s) => sum + s.size, 0)).toBeLessThanOrEqual(10 * 1024 * 1024)
  expect(sizes.every(s => s.size <= 1024 * 1024)).toBe(true)
  const text = (await Promise.all(files.map(name => readFile(join(log.directory, name), 'utf8')))).join('')
  expect(text).toContain('"repeated":99')
  expect(text).toContain('logs.dropped')
})

it('日志目录不可写时仍导出内存线索，失败不覆盖原附件，并拒绝并发导出', async () => {
  const { dir } = await fixture()
  const blocked = join(dir, 'blocked')
  await writeFile(blocked, 'ordinary-file')
  const log = new DiagnosticsService(blocked)
  services.push(log)
  await log.ready
  log.record('capture.state', { status: 'failed', reason: 'capture-failed' }, new Error('私密正文'))
  const target = join(dir, 'report.zip')
  await log.exportBundle(target, {}, false, writeDiagnosticBundle)
  expect(readZip(target).get('logs/memory.jsonl')!.toString()).toContain('capture-failed')
  expect(log.status().persistentLog).toBe(false)
  const before = await readFile(target)
  await expect(log.exportBundle(target, {}, false, async () => { throw new Error('disk-full') })).rejects.toThrow('disk-full')
  expect(await readFile(target)).toEqual(before)
  let finish!: () => void
  const pending = log.exportBundle(target, {}, false, () => new Promise(resolve => { finish = resolve }))
  await expect(log.exportBundle(target, {}, false, writeDiagnosticBundle)).rejects.toThrow('busy')
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  let stopped = false
  const closing = log.close().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(stopped).toBe(false)
  finish()
  await pending
  await closing
  expect(diagnosticError({ name: { toString: () => 'Error', secret: 'private' } })).toEqual({ errorType: 'Error' })
  expect(diagnosticError({ name: '用户名', message: '私密', code: 'token=private', stack: '私密' })).toEqual({ errorType: 'Error' })
})

it('启动阶段在首次异步初始化和批量刷盘前即可读取，并能随诊断包导出', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pantry-startup-'))
  directories.push(dir)
  const log = new DiagnosticsService(join(dir, 'logs'))
  services.push(log)
  log.checkpoint('electron-ready', 'starting')
  log.checkpoint('window-load', 'timeout', 2)
  const file = `${new Date().toISOString().slice(0, 10)}-${log.runId}.jsonl`
  const lines = readFileSync(join(log.directory, file), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(lines.map(row => [row.event, row.stage, row.status, row.attempt])).toEqual([
    ['app.startup', 'electron-ready', 'starting', undefined], ['app.startup', 'window-load', 'timeout', 2]
  ])
  const zip = join(dir, 'startup.zip')
  await log.exportBundle(zip, {}, false, writeDiagnosticBundle)
  const exported = readZip(zip).get(`logs/${file}`)!.toString().trim().split('\n').map(line => JSON.parse(line))
  expect(exported).toEqual(lines)
})
