// Electron 22 真实 IPC/Worker/设置界面；隔离数据与回环网络，不采集桌面或访问外网。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(repo, '.diagnostic-selftest-'))
  require('esbuild').buildSync({ stdin: { contents: ['src/main/store/app-state.ts', 'src/main/util/zip-store.ts']
    .map(file => `export * from ${JSON.stringify(path.join(repo, file))}`).join('\n'), resolveDir: repo },
    bundle: true, platform: 'node', target: 'node16', outfile: path.join(directory, 'fixture.cjs'), logLevel: 'silent' })
  try {
    for (const mode of ['first', 'restart']) {
      const result = spawnSync(require('electron'), [__filename, directory, mode], { cwd: repo, stdio: 'inherit', timeout: 60000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PANTRY_PEERS: '' } })
      assert.ifError(result.error)
      if (mode === 'first') {
        // Windows 通过 TerminateProcess 实现 SIGKILL，父进程可以收到退出码 1。
        assert.ok(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.status === 1),
          `未按预期强制结束测试进程：${result.signal || result.status}`)
      } else {
        assert.equal(result.status, 0, `Electron 诊断自测重启失败：${result.signal || result.status}`)
      }
    }
    assert.equal(fs.existsSync(path.join(directory, 'data/logs/running.json')), false, '正常退出清理标记')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
} else void run().catch(error => { console.error(error); require('electron').app.exit(1) })

async function until(check, label) {
  const end = Date.now() + 12000
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(50) }
  throw new Error(`等待超时：${label}`)
}
async function freePort(type) {
  if (type === 'udp') return new Promise(resolve => {
    const socket = require('node:dgram').createSocket('udp4')
    socket.bind(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) })
  })
  return new Promise(resolve => {
    const server = require('node:net').createServer()
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}

async function run() {
  const { app, BrowserWindow, dialog, clipboard, shell, globalShortcut } = require('electron')
  const directory = process.argv[2], mode = process.argv[3], fixture = require(path.join(directory, 'fixture.cjs'))
  const data = path.join(directory, 'data')
  const [udp, tcp] = await Promise.all(['udp', 'tcp'].map(freePort))
  process.env.PANTRY_USER_DATA = data
  process.env.PANTRY_SMOKE = '1'
  process.env.PANTRY_UDP_PORT = String(udp)
  process.env.PANTRY_TCP_PORT = String(tcp)
  app.disableHardwareAcceleration()
  app.getAppPath = () => repo
  app.getVersion = () => require(path.join(repo, 'package.json')).version
  app.getPreferredSystemLanguages = () => ['zh-CN']
  globalShortcut.register = () => false
  const state = fixture.loadAppState(data, app.getVersion(), tcp, udp, [], 'zh-CN')
  fixture.saveProfile(state, { nick: '私密用户名', company: '私密单位', dept: '', team: '', avatar: -1, fileDir: '' })
  let finished = false
  const quit = app.quit.bind(app)
  app.quit = () => { if (finished) quit() }
  let choice = path.join(directory, '诊断包.zip'), copied = '', revealed = ''
  dialog.showSaveDialog = async () => choice ? { canceled: false, filePath: choice } : { canceled: true }
  clipboard.writeText = value => { copied = value }
  shell.showItemInFolder = value => { revealed = value }
  // 验证业务没有借诊断查询发包，任何非回环地址立即失败。
  const dgram = require('node:dgram'), createSocket = dgram.createSocket
  dgram.createSocket = function (...args) {
    const socket = createSocket.apply(this, args), bind = socket.bind, send = socket.send
    socket.bind = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return bind.call(this, port, address, ...rest) }
    socket.send = function (...params) { assert.equal(params.find(v => typeof v === 'string'), '127.0.0.1'); return send.apply(this, params) }
    return socket
  }
  const net = require('node:net'), listen = net.Server.prototype.listen, connect = net.createConnection
  net.Server.prototype.listen = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return listen.call(this, port, address, ...rest) }
  net.createConnection = function (options, ...rest) { assert.equal(options.host, '127.0.0.1'); return connect.call(this, options, ...rest) }
  require(path.join(repo, 'out/main/index.js'))
  await app.whenReady()
  const main = await until(() => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#/')), '主窗')
  await until(() => main.webContents.executeJavaScript('!!document.querySelector(".shell")'), '主界面')
  await main.webContents.executeJavaScript('window.pantry.openSettings()')
  const settings = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('#/settings')), '设置窗')
  await until(() => settings.webContents.executeJavaScript('!!document.querySelector(".nav button")'), '设置导航')
  await settings.webContents.executeJavaScript(`document.querySelector('.nav button:last-child').click()`)
  await until(() => settings.webContents.executeJavaScript('!!document.querySelector(".diagnostics")'), '诊断入口')
  const invoke = code => settings.webContents.executeJavaScript(code)
  assert.equal(await invoke('document.querySelector(".diagnostic-option input").checked'), false)
  assert.equal((await main.webContents.executeJavaScript('window.pantry.exportDiagnostics(false)')).status, 'failed', '导出限定设置窗')
  assert.equal((await invoke('window.pantry.exportDiagnostics("yes")')).status, 'failed', 'IPC 验证类型')
  assert.equal(await invoke('window.pantry.copyDiagnosticEnvironment()'), true)
  assert.equal(copied.includes('私密用户名'), false)
  assert.equal(copied.includes(directory), false)
  const diagnostics = JSON.parse(copied.slice(copied.indexOf('{'))).diagnostics
  const previousRunFile = path.join(directory, 'tested-run-id')
  if (mode === 'restart') {
    assert.equal(diagnostics.previousExit, 'unclean')
    const result = await invoke('window.pantry.exportDiagnostics(false)')
    assert.equal(result.status, 'saved')
    const bundle = fixture.readZip(choice)
    const previousRunId = fs.readFileSync(previousRunFile, 'utf8')
    const startup = [...bundle].find(([name]) => name.startsWith('logs/') && name.endsWith(`-${previousRunId}.jsonl`))
    assert.ok(startup, '强制结束后仍能导出上一轮启动日志')
    const entries = startup[1].toString().trim().split('\n').map(line => JSON.parse(line))
    assert.ok(entries.some(entry => entry.runId === previousRunId && entry.event === 'app.startup' &&
      entry.stage === 'window-show' && entry.status === 'ready'), '上次启动的显示结果已落盘')
    const text = [...bundle.values()].map(b => b.toString()).join('\n')
    assert.equal(text.includes('app.exception'), true, '上一轮异常线索可导出')
    finished = true
    app.quit()
    return
  }
  // 真实页面抛错，检查 Chromium 异常通知能覆盖隔离世界之外的页面异常，正文不会随 IPC 持久化。
  await invoke(`setTimeout(()=>{throw new TypeError('secret-renderer-message')},0); true`)
  await pause(1200)
  await invoke(`setTimeout(()=>{Promise.reject(new RangeError('secret-rejection-message'))},0); true`)
  await pause(1200)
  // 接近保留上限的真实 JSONL，验证 Worker 重打包不会冻结主线程。
  const uuid = require('node:crypto').randomUUID
  const bulk = JSON.stringify({ at: new Date().toISOString(), runId: uuid(), event: 'message.state', id: uuid(), status: 'sent' }) + '\n'
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(data, 'logs', `${new Date().toISOString().slice(0, 10)}-${uuid()}.jsonl`), bulk.repeat(Math.floor(1048576 / Buffer.byteLength(bulk))))
  let ticks = 0, maxGapMs = 0, previous = Date.now()
  const heartbeat = setInterval(() => { const now = Date.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; ticks++ }, 10)
  const start = Date.now()
  await invoke(`document.querySelector('.diagnostic-actions button').click(); true`)
  await until(() => invoke('document.querySelector(".diagnostic-result")?.textContent.includes("已保存")'), '后台导出成功')
  const exportMs = Date.now() - start
  clearInterval(heartbeat)
  assert.ok(ticks > 0 && maxGapMs < 500, '后台导出期间主线程保持响应')
  const zip = fixture.readZip(choice)
  const text = [...zip.values()].map(b => b.toString()).join('\n')
  for (const secret of ['私密用户名', '私密单位', directory, 'secret-renderer-message', 'secret-rejection-message']) assert.equal(text.includes(secret), false, secret)
  assert.equal(text.includes('renderer.error'), true)
  assert.equal(text.includes('TypeError'), true)
  assert.equal(text.includes('RangeError'), true)
  assert.equal(zip.has('network-addresses.json'), false)
  assert.equal(await invoke('window.pantry.revealDiagnostics()'), true)
  assert.equal(revealed, choice)
  const result = await invoke('window.pantry.exportDiagnostics(true)')
  assert.equal(result.status, 'saved')
  assert.equal(fixture.readZip(choice).has('network-addresses.json'), true)
  choice = ''
  assert.equal((await invoke('window.pantry.exportDiagnostics(false)')).status, 'canceled')
  choice = path.join(directory, 'missing', 'fail.zip')
  assert.equal((await invoke('window.pantry.exportDiagnostics(false)')).status, 'failed')
  const artifacts = path.resolve(process.env.PANTRY_DIAGNOSTIC_ARTIFACTS || path.join(repo, 'docs/reviews/diagnostics-0.60.0'))
  fs.mkdirSync(artifacts, { recursive: true })
  for (const theme of ['light', 'dark']) {
    await invoke(`window.pantry.saveAppSettings({theme:${JSON.stringify(theme)}})`)
    await invoke(`document.activeElement?.blur(); document.querySelector('.diagnostics').scrollIntoView({block:'end'}); true`)
    await pause(200)
    assert.equal(await invoke(`document.documentElement.scrollWidth<=innerWidth && Array.from(document.querySelectorAll('.diagnostic-actions button')).every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})`), true)
    fs.writeFileSync(path.join(artifacts, `${theme}.png`), (await settings.webContents.capturePage()).toPNG())
  }
  await invoke('window.pantry.saveAppSettings({language:"en",fontScale:125})')
  await until(() => invoke('document.querySelector(".diagnostics h2")?.textContent.includes("Diagnostics")'), '英文文案')
  await invoke(`document.activeElement?.blur(); document.querySelector('.diagnostics').scrollIntoView({block:'end'}); true`)
  assert.equal(await invoke('document.querySelector(".diagnostic-result").textContent.includes("Diagnostic bundle saved")'), true, '现有提示随语言切换')
  assert.equal(await invoke('document.documentElement.scrollWidth <= innerWidth'), true, '125% 英文界面无横向溢出')
  fs.writeFileSync(path.join(artifacts, 'english.png'), (await settings.webContents.capturePage()).toPNG())
  fs.writeFileSync(path.join(artifacts, 'runtime.json'), JSON.stringify({ electron: process.versions.electron, node: process.versions.node, exportMs, maxGapMs, ticks, entries: [...zip.keys()] }, null, 2))
  process.emit('uncaughtExceptionMonitor', new TypeError('secret-main-message'), 'uncaughtException')
  console.log(`诊断自测通过：Electron ${process.versions.electron}，后台导出 ${exportMs}ms，隐私/异常/取消/失败/明暗英文界面。`)
  fs.writeFileSync(previousRunFile, diagnostics.runId)
  process.kill(process.pid, 'SIGKILL') // 模拟用户从任务管理器结束进程，下一轮复核同一数据目录。
}
