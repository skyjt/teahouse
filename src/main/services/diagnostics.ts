import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { arch, cpus, networkInterfaces, platform, release, totalmem } from 'node:os'
import { SCREEN_END_REASONS, SCREEN_REJECT_REASONS } from '../../shared/protocol'
import { writeStoreZip, type ZipEntry } from '../util/zip-store'

const DAY = 86_400_000
const MAX_TOTAL = 10 * 1024 * 1024
const MAX_FILE = 1024 * 1024
const MAX_QUEUE = 256 * 1024
const LOG_NAME = /^\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.jsonl$/
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const STARTUP_STAGES = [
  'electron-ready', 'profile', 'language', 'protocols', 'window-create', 'window-load', 'dom-ready',
  'ready-to-show', 'ui-mounted', 'window-show', 'tray', 'shortcuts', 'network', 'screen-lock', 'auto-launch', 'update-source'
] as const
export type StartupStage = typeof STARTUP_STAGES[number]
export type StartupCheckpoint = (stage: StartupStage, status: 'starting' | 'ready' | 'failed' | 'timeout',
  attempt?: number, error?: unknown) => void
const VALUES = new Set([
  ...STARTUP_STAGES, 'timeout',
  'starting', 'ready', 'failed', 'unavailable', 'file', 'memory', 'udp', 'tcp',
  'in', 'out', 'offering', 'accepted', 'done', 'declined', 'canceled', 'expired',
  'pending', 'sent', 'delivered', 'queued', 'recalled', 'connect', 'connected',
  'prepare', 'pull', 'receive', 'verify', 'write', 'complete', 'served', 'disconnected',
  'viewer', 'sharer', 'requesting', 'awaiting-consent', 'preparing', 'connecting', 'active', 'ended',
  'auto', 'economy', 'standard', 'smooth', 'text', 'image', 'sticker', 'files', 'system', 'screen',
  'normal', 'abnormal', 'crashed', 'killed', 'oom', 'launch-failed', 'integrity-failure',
  'clean-exit', 'abnormal-exit', 'still-running', 'unknown', 'main', 'renderer', 'gpu', 'utility',
  'error', 'rejection', 'vue', 'bootstrap', 'unresponsive', 'responsive', 'load',
  'socket-error', 'closed', 'write-error', 'part-read-error', 'hash-mismatch', 'size-mismatch',
  'path-escape', 'bad-frame', 'bad-json', 'frame-too-large', 'not-found', 'forbidden',
  'screen-unavailable', 'arm64-wayland', 'window-hide-failed', 'capture-failed', 'capture-window-failed',
  ...SCREEN_END_REASONS, ...SCREEN_REJECT_REASONS
])
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'])
const ERROR_CODES = /^(?:E[A-Z0-9_]{1,35}|SQLITE_[A-Z_]{1,35}|ERR_[A-Z_]{1,40})$/

export type DiagnosticEvent = 'app.startup' | 'app.start' | 'app.stop' | 'app.previous-exit' | 'app.exception' |
  'process.exit' | 'window.health' | 'renderer.error' | 'store.open' | 'network.listen' |
  'message.state' | 'transfer.state' | 'transfer.phase' | 'transfer.error' |
  'capture.state' | 'screen.state' | 'logs.dropped' | 'bundle.export'
export type DiagnosticFields = Record<string, unknown>
export type DiagnosticReporter = (event: DiagnosticEvent, fields?: DiagnosticFields, error?: unknown) => void

/** 错误正文可能含 SQL、消息、文件名和凭据；只取类型、系统码与编译后行列位置。 */
export function diagnosticError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {}
  try {
    const e = error as { name?: unknown; code?: unknown; stack?: unknown }
    const result: Record<string, unknown> = { errorType: typeof e.name === 'string' && ERROR_NAMES.has(e.name) ? e.name : 'Error' }
    if (typeof e.code === 'string' && ERROR_CODES.test(e.code)) result.errorCode = e.code
    if (typeof e.stack === 'string') {
      // 不保留任意函数名、绝对路径或第一行错误正文。
      const positions = e.stack.slice(0, 8192).split('\n').slice(1, 9)
        .map(line => line.match(/(?:[/\\])((?:index|[A-Za-z]{1,64}-[\w-]{6,64})\.js):(\d{1,8}):(\d{1,8})\)?$/)?.slice(1).join(':'))
        .filter(Boolean)
      if (positions.length) result.positions = positions
    }
    return result
  } catch { return { errorType: 'Error' } }
}

export interface DiagnosticBundleJob {
  directory: string
  target: string
  temporary: string
  environment: Record<string, unknown>
  summary: string
  memory: string
  network?: Array<{ alias: string; address: string }>
}

async function logFiles(directory: string): Promise<Array<{ name: string; size: number; modified: number }>> {
  const names = await readdir(directory).catch(() => [] as string[])
  const result: Array<{ name: string; size: number; modified: number }> = []
  for (const name of names.filter(n => LOG_NAME.test(n)).sort()) {
    const stat = await lstat(join(directory, name)).catch(() => null)
    if (stat?.isFile()) result.push({ name, size: stat.size, modified: stat.mtimeMs })
  }
  return result.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name))
}

/** 导出再次校验磁盘字段，兼容截断日志并排除手工附加的正文/路径。 */
function sanitizedLog(bytes: Buffer): Buffer {
  const lines: string[] = []
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line || Buffer.byteLength(line) > 2048) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(record.at)) || !UUID.test(String(record.runId)) ||
        !/^(app\.(start|startup|stop|previous-exit|exception)|process\.exit|window\.health|renderer\.error|store\.open|network\.listen|message\.state|transfer\.(state|phase|error)|capture\.state|screen\.state|logs\.dropped|bundle\.export)$/.test(String(record.event))) continue
      const safe: Record<string, unknown> = { at: record.at, runId: record.runId, event: record.event }
      for (const [key, value] of Object.entries(record)) {
        if (key === 'level' && ['info', 'warn', 'error'].includes(String(value))) safe[key] = value
        else if (['id', 'sessionId', 'transferId', 'msgId'].includes(key) && typeof value === 'string' && UUID.test(value)) safe[key] = value
        else if (['peerId', 'host', 'localAddress'].includes(key) && typeof value === 'string' && /^[a-f0-9]{16}$/.test(value)) safe[key] = value
        else if (['stage', 'status', 'direction', 'reason', 'role', 'mode', 'kind', 'process'].includes(key) && typeof value === 'string' && VALUES.has(value)) safe[key] = value
        else if (['attempt', 'port', 'localPort', 'bytes', 'total', 'count', 'durationMs', 'fps', 'exitCode', 'windowId', 'line', 'column', 'repeated'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value)) safe[key] = value
        else if (key === 'version' && typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value)) safe[key] = value
        else if (key === 'errorType' && typeof value === 'string' && ERROR_NAMES.has(value)) safe[key] = value
        else if (key === 'errorCode' && typeof value === 'string' && ERROR_CODES.test(value)) safe[key] = value
        else if (key === 'positions' && Array.isArray(value)) safe[key] = value.filter(p => typeof p === 'string' && /^(?:index|[A-Za-z]{1,64}-[\w-]{6,64})\.js:\d{1,8}:\d{1,8}$/.test(p)).slice(0, 8)
      }
      lines.push(JSON.stringify(safe) + '\n')
    } catch { /* 尾部半行或旧格式不阻断诊断包 */ }
  }
  return Buffer.from(lines.join(''))
}

/** 只在 Worker 内调用：读取受限日志，复用无依赖 ZIP，原子替换目标。 */
export async function writeDiagnosticBundle(job: DiagnosticBundleJob): Promise<void> {
  const entries: ZipEntry[] = [
    { name: 'summary.txt', data: Buffer.from(job.summary) },
    { name: 'environment.json', data: Buffer.from(JSON.stringify(job.environment, null, 2)) }
  ]
  if (job.network) entries.push({ name: 'network-addresses.json', data: Buffer.from(JSON.stringify(job.network, null, 2)) })
  let remaining = MAX_TOTAL
  const cutoff = new Date(Date.now() - 6 * DAY).toISOString().slice(0, 10)
  for (const file of (await logFiles(job.directory)).reverse()) {
    if (file.name.slice(0, 10) < cutoff || file.size > remaining) continue
    // O_NOFOLLOW 在支持的平台上堵住 lstat/open 竞态；Windows 再用句柄 fstat 校验。
    const handle = await open(join(job.directory, file.name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(() => null)
    if (!handle) continue
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_FILE || stat.size > remaining) continue
      const bytes = Buffer.alloc(stat.size)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      // 并发写入只取已完整写入的行，不截断 JSON。
      const end = bytes.subarray(0, bytesRead).lastIndexOf(10) + 1
      if (end) { entries.push({ name: `logs/${file.name}`, data: sanitizedLog(bytes.subarray(0, end)) }); remaining -= end }
    } finally { await handle.close() }
  }
  if (job.memory) entries.push({ name: 'logs/memory.jsonl', data: Buffer.from(job.memory) })
  const temporary = job.temporary
  try {
    // wx 预留，防止覆盖既有文件或符号链接；ZIP writer 只写这个本次创建的临时文件。
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 })
    writeStoreZip(temporary, entries)
    await rename(temporary, job.target)
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

export class DiagnosticsService {
  readonly runId = randomUUID()
  readonly ready: Promise<void>
  private readonly salt: string
  private queue: string[] = []
  private queueBytes = 0
  private memory: string[] = []
  private memoryBytes = 0
  private dropped = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | undefined
  private startupFile = ''
  private file = ''
  private fileBytes = 0
  private closed = false
  private diskOk = true
  private persistenceErrors = 0
  private markerCreated = false
  private previousExit: 'clean-or-first-run' | 'unclean' | 'unknown' = 'unknown'
  private repeats = new Map<string, { at: number; count: number }>()
  private addresses = new Map<string, string>()
  private exporting: Promise<void> | undefined
  private lastExport = ''

  constructor(readonly directory: string) {
    // 启动时仅同步读 65 字节，确保任何早期业务事件都使用同一匿名盐；热路径仍异步写日志。
    let existing = ''
    try {
      const fd = openSync(join(directory, 'identity-salt'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const bytes = Buffer.alloc(65)
        const size = readSync(fd, bytes, 0, bytes.length, 0)
        const value = bytes.subarray(0, size).toString('utf8')
        if (/^[a-f0-9]{64}$/.test(value)) existing = value
      } finally { closeSync(fd) }
    } catch { /* 首次启动或不可读：本轮使用新盐，初始化失败会在摘要注明。 */ }
    this.salt = existing || randomBytes(32).toString('hex')
    this.ready = this.initialize(!existing).catch(() => { this.diskOk = false; this.persistenceErrors++ })
  }

  private async initialize(saveSalt: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (saveSalt) await writeFile(join(this.directory, 'identity-salt'), this.salt, { flag: 'wx', mode: 0o600 })
    this.previousExit = await lstat(join(this.directory, 'running.json')).then(() => 'unclean' as const,
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? 'clean-or-first-run' as const : 'unknown' as const)
    await writeFile(join(this.directory, 'running.json'), JSON.stringify({ runId: this.runId, startedAt: new Date().toISOString() }), { mode: 0o600 })
    this.markerCreated = true
    await this.prune(0)
    this.record('app.previous-exit', { status: this.previousExit === 'unclean' ? 'abnormal' : 'normal' })
  }

  alias(value: string): string {
    const alias = createHmac('sha256', this.salt).update(value.slice(0, 256)).digest('hex').slice(0, 16)
    if (isIP(value) && this.addresses.size < 2048) this.addresses.set(alias, value)
    return alias
  }

  readonly record: DiagnosticReporter = (event, fields = {}, error) => {
    if (this.closed) return
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      if (['id', 'sessionId', 'transferId', 'msgId'].includes(key) && typeof value === 'string' && UUID.test(value)) safe[key] = value
      else if (key === 'version' && typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value)) safe[key] = value
      else if (['peerId', 'host', 'localAddress'].includes(key) && typeof value === 'string') safe[key] = this.alias(value)
      else if (['stage', 'status', 'direction', 'reason', 'role', 'mode', 'kind', 'process'].includes(key) && typeof value === 'string') safe[key] = VALUES.has(value) ? value : 'unknown'
      else if (['attempt', 'port', 'localPort', 'bytes', 'total', 'count', 'durationMs', 'fps', 'exitCode', 'windowId', 'line', 'column'].includes(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = Math.max(-2147483648, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
    }
    Object.assign(safe, diagnosticError(error))
    const key = JSON.stringify([event, safe])
    const now = Date.now()
    const repeat = this.repeats.get(key)
    if (repeat && now - repeat.at < 5000) { repeat.count++; return }
    if (this.repeats.size >= 256) this.flushRepeats()
    if (repeat?.count) this.enqueue(event, { ...safe, repeated: repeat.count })
    this.repeats.set(key, { at: now, count: 0 })
    this.enqueue(event, safe)
  }

  private flushRepeats(): void {
    for (const [key, entry] of this.repeats) {
      if (!entry.count) continue
      const [event, fields] = JSON.parse(key) as [DiagnosticEvent, Record<string, unknown>]
      this.enqueue(event, { ...fields, repeated: entry.count })
    }
    this.repeats.clear()
  }

  readonly checkpoint: StartupCheckpoint = (stage, status, attempt, error) => {
    this.record('app.startup', { stage, status, attempt }, error)
  }

  // A native startup call can block the event loop before the usual log batch is written.
  private writeStartupLine(line: string): boolean {
    try {
      const file = this.startupFile || join(this.directory, `${new Date().toISOString().slice(0, 10)}-${this.runId}.jsonl`)
      let flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0)
      if (!this.startupFile) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        flags |= constants.O_CREAT | constants.O_EXCL
      }
      const fd = openSync(file, flags, 0o600)
      this.startupFile = file
      try { writeFileSync(fd, line) } finally { closeSync(fd) }
      return true
    } catch { return false }
  }

  private enqueue(event: DiagnosticEvent, fields: Record<string, unknown>): void {
    const level = fields.errorType || fields.reason === 'crashed' ? 'error' : fields.status === 'failed' || fields.status === 'abnormal' ? 'warn' : 'info'
    const line = JSON.stringify({ at: new Date().toISOString(), runId: this.runId, level, event, ...fields }) + '\n'
    const bytes = Buffer.byteLength(line)
    if (bytes > 2048 || this.queueBytes + bytes > MAX_QUEUE) { this.dropped++; return }
    this.memory.push(line); this.memoryBytes += bytes
    while (this.memoryBytes > MAX_QUEUE) this.memoryBytes -= Buffer.byteLength(this.memory.shift()!)
    if (event === 'app.startup' && this.writeStartupLine(line)) return
    this.queue.push(line); this.queueBytes += bytes
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 1000)
    this.timer.unref()
  }

  private async prune(reserve: number): Promise<void> {
    const files = await logFiles(this.directory)
    let total = files.reduce((sum, f) => sum + f.size, reserve + 2048)
    const cutoff = new Date(Date.now() - 6 * DAY).toISOString().slice(0, 10)
    for (const file of files) {
      if (file.name.slice(0, 10) < cutoff || file.size > MAX_FILE || total > MAX_TOTAL) {
        await rm(join(this.directory, file.name), { force: true })
        total -= file.size
        if (file.name === this.file) { this.file = ''; this.fileBytes = 0 }
      }
    }
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.flushRepeats()
    if (this.writing) return this.writing
    this.writing = this.drain().finally(() => { this.writing = undefined })
    return this.writing
  }

  private async drain(): Promise<void> {
    await this.ready
    // 只允许一批在途；写盘慢时其余记录留在有上限的队列，不能堆积 Promise/批次。
    while (this.queue.length || this.dropped) {
      if (this.dropped) {
        const count = this.dropped; this.dropped = 0
        this.queue.push(JSON.stringify({ at: new Date().toISOString(), runId: this.runId, event: 'logs.dropped', count }) + '\n')
      }
      const batch = this.queue.join('')
      this.queue = []; this.queueBytes = 0
      try {
        const day = new Date().toISOString().slice(0, 10)
        const bytes = Buffer.byteLength(batch)
        await this.prune(bytes)
        if (!this.file.startsWith(day) || this.fileBytes + bytes > MAX_FILE) {
          this.file = `${day}-${randomUUID()}.jsonl`; this.fileBytes = 0
        }
        const handle = await open(join(this.directory, this.file), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o600)
        try { await handle.writeFile(batch) } finally { await handle.close() }
        this.fileBytes += bytes
        this.diskOk = true
      } catch { this.diskOk = false; this.persistenceErrors++ }
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  async close(): Promise<void> {
    this.record('app.stop')
    this.closed = true
    await this.flush()
    await this.exporting
    if (this.diskOk && this.markerCreated) await rm(join(this.directory, 'running.json'), { force: true }).catch(() => undefined)
  }

  /** 仅致命异常使用同步小写入；进程默认退出行为保持不变，运行标记留给下次启动。 */
  fatal(error: unknown): void {
    const line = JSON.stringify({ at: new Date().toISOString(), runId: this.runId, event: 'app.exception', level: 'error', ...diagnosticError(error) }) + '\n'
    try { writeFileSync(join(this.directory, `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.jsonl`), line, { flag: 'wx', mode: 0o600 }) }
    catch { /* 致命退出不得被日志错误覆盖 */ }
  }

  status(): Record<string, unknown> {
    return { previousExit: this.previousExit, persistentLog: this.diskOk, persistenceErrors: this.persistenceErrors, runId: this.runId, retentionDays: 7, maxLogMiB: 10 }
  }

  async exportBundle(target: string, environment: Record<string, unknown>, includeNetwork: boolean,
    runWorker: (job: DiagnosticBundleJob) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('closed')
    if (this.exporting) throw new Error('busy')
    let finish!: () => void
    this.exporting = new Promise(resolve => { finish = resolve })
    try {
      await this.flush()
      const report = { ...environment, diagnostics: this.status() }
      await runWorker({ directory: this.directory, target, environment: report,
        temporary: `${target}.${randomUUID()}.tmp`,
        summary: diagnosticSummary(report), memory: this.persistenceErrors ? this.memory.join('') : '',
        ...(includeNetwork ? { network: [...this.addresses].map(([alias, address]) => ({ alias, address })) } : {}) })
      this.lastExport = target
      this.record('bundle.export', { status: 'done' })
    } catch (error) { this.record('bundle.export', { status: 'failed' }, error); throw error }
    finally { this.exporting = undefined; finish() }
  }

  exportedPath(): string { return this.lastExport }
}

export function diagnosticSummary(environment: Record<string, unknown>): string {
  return '茶话间 / Teahouse 诊断信息\n' +
    '请说明发生时间、操作步骤和预期结果；传输问题建议双方导出。\n' +
    'Include the time, steps and expected result; export from both peers for transfer issues.\n' +
    '不含聊天/文件内容；日志可能被保留上限截断。异常退出标记仅表示未完成正常关闭。\n' +
    'No chat/file content. Logs are bounded. An unclean marker does not identify the cause of a crash.\n\n' +
    JSON.stringify(environment, null, 2) + '\n'
}

/** 只读应用所在会话；不启动 shell、截图、权限弹窗或网络探测。 */
export async function diagnosticEnvironment(log: DiagnosticsService): Promise<Record<string, unknown>> {
  await log.ready
  const environment: Record<string, unknown> = { os: platform(), release: release(), architecture: arch(),
    cpuCount: cpus().length, memoryMiB: Math.round(totalmem() / 1048576) }
  if (platform() === 'linux') {
    const distro = (await readFile('/etc/os-release', 'utf8').catch(() => '')).slice(0, 16384)
    const fields: Record<string, string> = {}
    for (const line of distro.split('\n')) {
      const match = line.match(/^(ID|VERSION_ID)=["']?([a-zA-Z0-9_.-]{1,64})["']?$/)
      if (match) fields[match[1]] = match[2]
    }
    environment.distribution = fields
    const session = process.env.XDG_SESSION_TYPE
    environment.session = ['x11', 'wayland', 'tty'].includes(session ?? '') ? session : 'unknown'
    const desktop = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().split(':')
    environment.desktop = desktop.filter(d => ['gnome', 'kde', 'dde', 'deepin', 'ukui', 'xfce', 'mate', 'cinnamon', 'unity', 'lxqt'].includes(d))
    environment.displaySet = Boolean(process.env.DISPLAY)
    environment.waylandDisplaySet = Boolean(process.env.WAYLAND_DISPLAY)
    environment.sessionBusSet = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)
  }
  environment.interfaces = Object.values(networkInterfaces()).flatMap(items => (items ?? []).map(item => ({
    address: log.alias(item.address), family: item.family, internal: item.internal,
    prefix: item.cidr?.split('/')[1] ?? null
  })))
  return environment
}
