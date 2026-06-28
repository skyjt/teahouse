# 茶话间（Teahouse）技术设计文档

| | |
|---|---|
| 状态 | v0.96，P1 本地交付候选；Linux arm64 发布锁定 Ruby 2.5 兼容 ffi 依赖 |
| 日期 | 2026-06-28 |
| 关系 | 上游：[requirements.md](requirements.md)（功能）、[protocol.md](protocol.md)（协议）、[ui-design.md](ui-design.md)（界面）；硬约束：根 README「开发红线」（Electron 22.3.27 / Chrome 108 / Node 16.17 焊死） |

## 1. 选型决策总表

| 项 | 决策 | 理由（一句话） |
|---|---|---|
| 语言 | **TypeScript**（main / preload / renderer / shared 全量） | 协议报文、IPC 契约、库表全靠类型撑住多人/长期维护 |
| 构建 | **electron-vite**（Vite 5） | 一份配置管三端产物；renderer 目标 `chrome108`、main/preload 目标 `node16`，红线在构建层强制 |
| 渲染框架 | **Vue 3 + Pinia** | 组件模型贴合三栏布局；生态对中文社区友好；Chrome 108 完全兼容 |
| 样式 | **原生 CSS + CSS 变量**（ui-design §9 token 直接映射），Vue SFC scoped；不引组件库/Tailwind | 视觉自绘才能做出"微信感"；避免组件库默认样式拉低质感 |
| 图标与品牌 | **项目内自绘线性 SVG + 茶杯气泡 logo** | UI 图标线性 1.6px 风格与 UI 文档一致；品牌 logo 三件套复用同一轮廓；不依赖 emoji/system 字形，不引入组件库或图标依赖 |
| 数据库 | **better-sqlite3 锁定 9.6.0**（同步 API + WAL + FTS5） | 主进程单线程同步访问最简单可靠；已对 Electron 22 ABI=110 实测编译+运行通过。`.npmrc` 以 `runtime=electron` 让 native 构建始终面向 Electron 而非开发机 Node（开发机 Node 太新会编不过老版本源码） |
| 图片处理 | **渲染进程 canvas**（缩略图、表情包压缩 WebP） | Chromium 108 原生支持 `toBlob('image/webp')`；**不引 sharp** 等 native 库，避开老 glibc 等编译雷区 |
| 日志 | 自写轻量 logger（分级、按天分文件、保留 7 天、可打包导出） | 几十行的事，不引依赖 |
| 配置 | 自写 `config.json` 原子写（临时文件 + rename） | 同上；electron-store 新版本对 Node16 不友好 |
| 打包 | **electron-builder 24.x** | 兼容 Electron 22；NSIS（x64）/ deb+AppImage / dmg+zip universal 一站式 |
| 单测 | **vitest**（跑在开发机 Node，测纯逻辑） | 协议编解码、补发队列、路径清洗、身份映射都是纯函数，最值得测 |
| E2E | Playwright `_electron`（**实测验证**与 Electron 22 的配对版本；不通则退 WebdriverIO） | 三平台冒烟仍以手测清单为主 |
| 开发机要求 | Node ≥ 18（仅工具链；产物运行时是 Electron 内置 Node 16.17，与开发机无关） | Vite 5 要求 |

依赖纪律（呼应 README 红线）：所有依赖**精确锁版本**；新增依赖前先查 `engines` 与是否含 native 模块；native 模块只允许 better-sqlite3 一个。

## 2. 进程与窗口模型

```
主进程（Node 16.17）
 ├─ 网络层（UDP 17878 / TCP 17879）   ← 全部网络 IO 在主进程
 ├─ 存储层（better-sqlite3，同步）
 ├─ 系统集成（托盘/通知/快捷键/自启/单实例锁）
 └─ 窗口管理
     ├─ 主窗口（三栏，960×640 起，关闭=隐藏到托盘，沉浸式无标题栏，决议 #49）
     ├─ 设置窗口（640×480，懒创建，单例，沉浸式无标题栏）
     └─ 截图窗口（每屏一个，frameless+透明+置顶，截完即毁）
渲染进程（Chromium 108，sandbox）
 └─ Vue 3 应用（UI 全部状态经 IPC 同步）
```

> 架构总览图：[assets/architecture.mmd](assets/architecture.mmd)（IDE / GitHub 可直接预览渲染）。

- `app.requestSingleInstanceLock()`：二开实例 → 唤起已有主窗。
- 主窗 `show: false` + `ready-to-show` 再显示，避免白屏闪烁。
- **沉浸式无标题栏**（决议 #49/#51/#52）：macOS `titleBarStyle: 'hiddenInset'`（主窗 `trafficLightPosition` x=68 置于列表栏顶部，56px 导航栏放不下三钮；设置窗 x=12）；Windows / Linux `frame: false`（Windows 保留默认 `thickFrame`，边缘缩放与 Aero Snap 不受影响）。拖拽带（顶部 32px）分平台实现：macOS / Windows 用 `-webkit-app-region: drag`；**Linux 禁用 CSS 拖拽区**——Electron 在 Linux 上的 drag region 命中计算不可靠（受桌面环境/缩放影响，UOS 实测会吞掉客户区点击，决议 #52），改为渲染层 Pointer Capture + 主进程 `win:begin-drag` / `win:end-drag`（`screen.getCursorScreenPoint()` 间隔 16ms 跟随移窗，窗口销毁/二次 begin 自动清理），双击走 `win:toggle-maximize`。Windows / Linux 的最小化 / 最大化 / 关闭经 IPC `win:minimize` / `win:toggle-maximize` / `win:close`（`BrowserWindow.fromWebContents` 定位窗口）；最大化状态经事件 `win:maximized-changed` 推送图标切换。**渲染层严禁用 DOM `window.close()` 关窗**（决议 #59）：Electron 对渲染层发起的关闭走 `CloseImmediately`，绕过主进程 `close` 事件，"关闭进托盘"拦截会失效直接退出——必须走 `win:close` 由主进程 `BrowserWindow.close()` 标准流程。不使用透明窗口，Win7 软渲染下安全。若 UOS 复测仍异常，预案：Linux 回退 `frame: true`。
- 安全基线（README 红线落点）：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；严格 CSP（`default-src 'self'`）；`will-navigate` 全拦截、`setWindowOpenHandler` 一律 deny；渲染进程只加载本地资源。
- **日志脱敏**（决议 #22）：logger 永不记录消息正文/文件内容，只记元数据（消息 ID、类型、长度、对端 nodeId）——"导出诊断日志"不等于泄聊天。
- 通知：用 Electron `Notification`（Win7 下 Electron 自带仿原生降级实现；macOS 26 未签名场景列入冒烟清单）。通知正文走 `main/notifications.ts` 生成系统安全摘要，emoji 降级为 `[表情]`，避免 UOS / Win7 系统通知缺字方框；Linux / Windows 显式传入本地应用图标路径（开发态 `build/icons/window-icon.png`，打包态 `resources/icons/pantry.png`），不依赖桌面环境反查 `.desktop` 图标。
- 私聊窗口震动（决议 #109/#110/#112）：渲染层只发 `msg:nudge` IPC，`ChatService` 负责构造 `msg(kind:"nudge")`、发送端限流、接收端限流和本地系统提示落库。发送成功后写入“你发送了一次窗口震动”系统消息；接收未限流时写入“对方发来一次窗口震动”系统消息。若该单聊免打扰，服务层不发 `'nudge'` 事件，主进程不唤起、不置前、不震动；否则通过服务层 `'nudge'` 事件回到 `index.ts`，主进程短暂置前并操作 `BrowserWindow` 做短抖，renderer 收到 `msg:nudge-received` 后 `openConv(single:<peerId>)` 精准切到发起人单聊。震动不进补发队列、不产生未读、不写 FTS；窗口已最大化/全屏时不强行移动，只做系统闪烁/弹跳兜底。
- PK 分歧解决（决议 #139）：渲染层只发 `msg:pk` IPC（玩法 `dice|rps`），主进程服务层使用 `crypto.randomInt` 在发送瞬间生成骰子或猜拳结果，构造 `msg(kind:"pk")` 并写库。PK 是在线即时消息：单聊发送前要求对端在线；群聊由 `GroupsService` 取当前在线成员快照后逐成员扇出，离线成员不入发送队列、不补发。发送失败只把本地消息标失败，用户重试时复用同一 `msgId`、同一 payload 和同一结果，不重新随机。接收端只校验并落库载荷结果，不重新随机；renderer 只播放本地动画。PK 是轻娱乐，不引入承诺揭示、签名、加密、公平证明、排行榜或外网素材。
- 端口被占：启动时 bind 失败 → 主窗弹引导浮层（跳设置-高级改端口），网络层降级为"离线模式"不崩溃。

## 3. 代码结构

```
src/
├─ shared/                 # 三端共享，零运行时依赖
│  ├─ protocol.ts          # 报文类型/常量（protocol.md 的 TS 化，唯一来源）
│  ├─ ipc.ts               # IPC 通道名 + 请求/响应/事件类型
│  └─ model.ts             # Peer / Message / Conversation / Transfer / Group / Sticker
├─ main/
│  ├─ index.ts             # 启动时序：锁 → 配置 → DB 迁移 → 窗口 → 网络
│  ├─ windows/             # main-window / settings-window / capture-window / tray
│  ├─ net/
│  │  ├─ udp.ts            # socket 收发、广播目标计算（多网卡枚举）、每源限速
│  │  ├─ codec.ts          # 信封编解码 + 入站校验（字段白名单/长度，手写校验器）
│  │  ├─ discovery.ts      # entry/alive/exit/presence/profile/gossip、探活、离线判定
│  │  ├─ range-sync.ts     # scan-ranges 低频同步扫描范围；不直接执行扫描
│  │  ├─ peer-registry.ts  # 节点表（内存 + 落库）、profileRev 比对、节点缓存
│  │  ├─ messenger.ts      # msg/ack、退避重传、补发队列、去重
│  │  └─ transfer.ts       # TCP server/client、pull 流、SHA-256、限并发、断点位
│  ├─ store/
│  │  ├─ db.ts             # 打开/迁移（用户版本号 PRAGMA user_version 递增迁移）
│  │  ├─ repo/*.ts         # peers / conversations / messages / groups / transfers / stickers / queue / dedup
│  │  └─ fts.ts            # 中文按字预切 + FTS5 查询
│  ├─ services/
│  │  ├─ chat.ts           # 发消息编排：写库→网络→状态回推（核心用例层）
│  │  ├─ contacts.ts       # 通讯录树聚合、探活编排
│  │  ├─ capture.ts        # desktopCapturer 抓屏 → 截图窗 → 裁剪落剪贴板
│  │  ├─ porter.ts         # 导出（HTML/TXT/备份包）与导入（身份映射+去重）
│  │  ├─ settings.ts       # config.json、数据目录迁移、自启（linux 写 autostart desktop 文件）
│  │  └─ updater.ts        # 局域网自更新编排（决议 #166/#170）：同平台版本比对择源、索包请求复核、本地包查找、后续 SHA-256+版本核对、触发安装重启
│  ├─ ipc/                 # handle 注册（只做参数校验+转发 services）、事件推送
│  └─ util/                # logger / paths / sanitize（文件名清洗）/ atomic-write / self-package（deb 自重打包·nsis 定位自留包）/ apply-update（替换重启）
├─ preload/index.ts        # contextBridge 暴露 window.pantry（按 shared/ipc.ts 类型）
└─ renderer/
   ├─ app/                 # 三栏壳、路由（chat / contacts / 空状态）
   ├─ views/               # ChatView / ContactsView / SettingsApp（设置窗复用同包不同入口）/ CaptureApp
   ├─ components/          # bubble/* file-card avatar tree search-panel emoji-panel virtual-list
   ├─ stores/              # pinia：peers / convs / messages / transfers / ui / settings
   ├─ ipc.ts               # window.pantry 的薄封装 + 事件订阅分发到 store
   └─ styles/tokens.css    # ui-design §9 的 CSS 变量
```

分层铁律：renderer 永不直接碰网络/磁盘/DB——一切经 IPC；main 的 `services/` 是用例编排层，`net/`、`store/` 互不感知，由 service 串联。

远期预留（决议 #21）：将来的本地 AI 开放接口（`local-api/`，HTTP/WS 或 MCP 服务器）将作为与 `ipc/` **并列的第二个"前台"**，复用同一 `services/` 层——界面能做的（查消息、发消息、订阅事件），接口天然也能做，不需要改动业务层。当前版本不实现，但任何人不得把业务逻辑写进 `ipc/` 层（会堵死这个口子）。

## 4. IPC 契约（摘要）

调用（`ipcRenderer.invoke`，全部走 `shared/ipc.ts` 类型）：

| 通道 | 说明 |
|---|---|
| `peers:list` / `peers:probe` / `peers:addManual` / `peers:scan` / `peers:scan-all-ranges` / `peers:set-remark` | 通讯录、探活（F-DISC-8）、手动 IP、单网段扫描、全部已保存网段扫描、本地备注；同步来的网段来源随 `SettingsView.scanRangeItems` 展示 |
| `conv:list` / `conv:pin` / `conv:mute` / `conv:markRead` / `conv:remove` | 会话列表操作 |
| `msg:page(convId, beforeTs, n)` / `msg:send` / `msg:resend` / `msg:recall` / `msg:nudge` / `msg:pk` / `msg:search` | 消息分页（倒序游标）、发送、重发、撤回、私聊窗口震动、PK 分歧解决、当前会话历史搜索 |
| `file:grant-paths` / `file:offer` / `file:direct` / `group-file:offer` / `file:accept` / `file:cancel` / `file:reveal` | 文件传输四件套；`file:grant-paths` 只为拖拽 / 粘贴产生的本地路径登记一次性授权，`file:offer` / `group-file:offer` 仍必须消耗授权；`file:direct` 由发送方文件卡片触发，在已有私聊普通文件 transfer 上发送 `file-ctl {op:"direct"}`；群聊发送为多条点对点 transfer 的发送侧编排且不支持直接发送 |
| `group:create` / `group:update` | 讨论组 |
| `search:query(q, scope)` | 全局搜索（联系人/组/记录/文件 四分类一次返回） |
| `sticker:addFromMessage` / `sticker:list` / `sticker:remove` / `sticker:reorder` | 表情包 |
| `data:export` / `data:import` | 导出导入；导出可带会话与时间范围 |
| `settings:get` / `settings:save-profile` / `settings:save-app` / `settings:pick-dir` | 设置读取、资料保存、应用设置、文件保存目录选择 |
| `shot:start` | 触发截图流程 |

事件（main → renderer，`webContents.send`）：`peers:updated`、`msg:new`、`msg:status`（发送中/已送达/排队/失败）、`msg:nudge-received`、`transfer:progress`（节流 ≤4 次/s）、`transfer:done|failed`、`group:updated`、`net:state`（在线/端口冲突/网卡变化）、`net:scan-progress`（主界面全局网段刷新进度，节流推送）、`badge:update`。

## 5. 数据库设计（SQLite，WAL）

```sql
peers(node_id TEXT PK, nick, remark, company, dept, team, avatar INT, host, platform,
      ip, udp_port INT, tcp_port INT, profile_rev INT, caps TEXT, ver TEXT,
      first_seen INT, last_seen INT)                        -- online 状态只存内存
conversations(id TEXT PK, type TEXT,            -- 'single'|'group'
      peer_or_group_id TEXT, last_ts INT, unread INT,
      pinned INT, muted INT, draft TEXT)
messages(id TEXT PK,                            -- 协议 msgId，全局唯一
      conv_id TEXT, sender_id TEXT, is_mine INT,
      kind TEXT, content TEXT, file_ref TEXT,   -- kind: text|file|image|sticker|system|pk；file_ref: JSON；群发文件可含 transferIds；PK 存 pkRef
      ts INT, seq INT,                          -- seq: 本地单调递增，时钟漂移兜底排序
      status TEXT)                              -- sending|sent|queued|failed|recalled
messages_fts(fts5: msg_id UNINDEXED, text)      -- 入库时中文按字空格预切；查询 phrase 匹配
groups(group_id TEXT PK, name, members TEXT, rev INT, updated_by, updated_ts INT,
      creator_ip TEXT, creator_id TEXT, admin_secret_hash TEXT, admin_hint TEXT)
transfers(transfer_id TEXT PK, msg_id, peer_id, direction, files TEXT,
      status, bytes_done INT, total INT, ts INT)
send_queue(msg_id TEXT PK, peer_id, envelope TEXT, created INT, attempts INT)
dedup(msg_id TEXT PK, recv_ts INT)
stickers(id TEXT PK, path, w INT, h INT, animated INT, sort INT, added INT)
```

- 索引：`messages(conv_id, ts, seq)`、`peers(last_seen)`、`send_queue(peer_id)`、`transfers(status)`。
- `remark` 为本地备注名（决议 #22/#37）：仅本机、不入协议；显示与搜索优先命中备注。通讯录资料卡与私聊头部资料弹窗都复用 `peers:set-remark` 写入 peers 表，主进程随后推送 `peers:updated` 刷新会话、通讯录与搜索显示名。
- `groups.creator_ip/creator_id/admin_secret_hash/admin_hint` 为讨论组管理门槛（决议 #27/#30/#113）：密码明文不入库；提示仅用于成员输入密码时展示，不参与鉴权；无密码组优先以创建者 nodeId 接受管理变更，并保留创建 IP 作为旧版本兼容。v9 迁移把旧无密码群的 `updated_by` 回填为 `creator_id`，避免多网卡/虚拟机网络下创建 IP 与实际源 IP 不一致导致合法改名 `group.info` 被误拒。该机制服务于内网协作秩序，不替代加密/签名。
- 群名变更提示（决议 #87）不新增协议字段、不新增迁移：`GroupsService` 在本机改名与远端 `group.info` 应用时，根据旧/新群名写入 `messages.kind='system'`，消息 ID 使用 `group:<groupId>:rename:<rev>` 保证重复 `info` 幂等；发送人显示名由主进程注入解析函数，优先本地备注，其次 registry 昵称。
- PK 消息（决议 #139）不新增 SQLite 表或列：`messages.kind='pk'`，`content` 写入不透结果的安全摘要（如「[PK] 骰子」「[PK] 猜拳」），用于会话预览、搜索、FTS 与通知；`file_ref` 复用为 `PkRef` JSON（`{game,result}`），用于气泡最终结果、导出 HTML/TXT 与失败重试复用同一结果，由 `kind` 区分其 JSON 形状。
- 中文搜索：FTS5 不会切中文词 → **入库时把 `text` 按字拆开以空格连接**写入 fts 表，查询同样按字拆 + `"…"` 短语匹配；文件名/联系人走 `LIKE %…%`（千级数据量足够）。会话内历史搜索固定带 `conv_id` 范围，直接在 `messages` 上按 `kind/content/file_ref/ts` 白名单条件查询：关键词匹配 `content` 与 `file_ref` 展示名，图片/文件/日期筛选只影响本地 SQLite 查询，不产生协议报文或数据库迁移；空关键词允许返回当前会话最近记录，仍受类型、日期与 limit 约束；图片/文件命中返回解析后的 `FileRefView`，渲染层仅用 `transferId` 走既有 `pantry-img://` 安全协议显示缩略图，不暴露本地保存路径。
- 定时清理（启动 + 每小时）：`dedup` 超 24h、`send_queue` 超 7 天或单 peer 超 200 条（裁剪时回推 UI 标失败）；启动时将残留 `sending` 态消息复位为失败（可点重发），杜绝"永远转圈"。
- 迁移：`PRAGMA user_version` 递增 + 顺序执行迁移脚本；导入/迁移目录前自动备份 db 文件。

## 6. 数据目录

```
<dataRoot>/                  # 当前 = app.getPath('userData')/data；整体迁移留 v1.0 打磨
├─ db/chat.db                # 主库（WAL）
├─ files/                    # 接收的文件（默认值，可单独改）
├─ images/                   # 图片消息缓存（收+发）
├─ stickers/                 # 表情包（压缩后的 WebP/GIF）
├─ logs/                     # 按天滚动，留 7 天
└─ config.json               # 设置（原子写）；含 manualPeers / scanRanges / scanRangeSources / ignoredScanRanges / allowDirectFileSend
```

整体数据目录迁移流程（v1.0 打磨项）：校验目标可写 → 关闭 db → 复制（带进度）→ 校验文件数/大小 → 写新路径入旧位置的 `redirect.json` 与全局配置 → 重开 db；失败自动回滚。

扫描范围自动分享（决议 #114）属于设置同步，不入 SQLite：`config.scanRanges` 保留旧字符串数组；`scanRangeSources` 记录 `self/remote`、来源 nodeId/显示名、添加时间与上次自动扫描时间；`ignoredScanRanges` 记录用户主动移除过的 CIDR，远端再次分享时不自动加回。`RangeSync` 只收发 `scan-ranges` 配置候选；主进程收到新 CIDR 后按 30–90 分钟抖动、12 小时去重、在线规模 hash 抽样调度 `Discovery.scanHosts()`，手动扫描仍走即时路径。

主界面全局网段刷新（决议 #115）仍属于显式手动扫描：`peers:scan-all-ranges` 在主进程读取当前 `config.scanRanges`，归一化合法 CIDR 后展开并按 IP 去重，再以 8ms 间隔逐个调用 `Discovery.probe()`；进度通过 `net:scan-progress` 推给主窗口，含 `done/total/rangeCount/status`。该扫描不改配置、不入 SQLite、不新增线上协议；运行中重复调用只返回当前进度，避免并发扫描。

私聊文件直接发送（决议 #174）属于本机配置 + 现有传输状态机增强，不新增 SQLite 表或迁移：`config.allowDirectFileSend` 为接收侧总开关，老配置缺省视为 `true`。发送端先走普通 `file:offer`，文件卡片出现后，若该 transfer 为私聊普通文件、对端在线且 `profile.caps` 含 `fd1`，发送方卡片显示「直接发送」按钮；点击后 `file:direct` 调用服务层 `requestDirect(transferId)`，通过 `file-ctl {op:"direct", transferId}` 请求接收端自动 accept。接收端仅在该 transfer 是入站私聊普通文件、状态仍为 `offering` 且本机开关允许时调用 `accept(transferId)`；否则保持普通 `offering` 文件卡片。群聊文件收到 direct 控制帧必须忽略；群文件仍按在线成员逐个普通 offer，收端手动接收。

默认文件接收目录（决议 #179）由服务层统一生成：`accept(transferId)` 未传 `saveDirOverride` 时，以 `getSaveDir()/sanitizeFileName(displayName)` 作为基础目录，displayName 优先本地备注、其次 peer 昵称；私聊直接发送自动接收与普通手动「接收」都走这条逻辑。`file:accept(transferId, true)` 另存为会先由主进程目录选择器得到 `saveDirOverride`，服务层直接使用用户选择目录，不再额外套联系人子目录。若 transfer 是失败重试且 `files.savedPath` 已存在，优先沿用 `dirname(savedPath)`，避免同一传输重试时改变落点。目录不存在时由拉取写盘流程递归创建；重名仍由根级 dedupe 处理，不覆盖既有文件。群聊文件虽然不支持直接发送，但手动接收同样按发送人显示名进入联系人子目录。

## 7. 渲染进程要点

- **虚拟滚动**：消息列表（倒序无限滚动、按 50 条分页拉取）与通讯录扁平化树（1000 节点）两处必须虚拟化；优先自写轻量实现，复杂度超预期则退 `@vueuse/core useVirtualList`（纯逻辑库，无 DOM 依赖风险）。
- **系统图标与 emoji 兼容渲染**：导航、工具栏、文件卡、状态位统一走 `PantryIcon` 自绘 SVG，图标继承文字色。头像模板走 `AvatarMark` / `AvatarGlyph`，按原 `avatar:number` 下标加载 Twemoji 本地 SVG 动物图标；emoji 面板、聊天输入框镜像层与消息正文对内置 emoji 子集走 `CompatEmoji` 加载 `src/renderer/src/assets/twemoji/*.svg`。发送、复制、存储仍是原 UTF-8 字符。输入框仍以原生 textarea 承担键盘、选区、粘贴与提交，只在草稿包含内置 emoji 时用透明文字 + 镜像层显示 SVG，避免 contenteditable 引入编辑风险。`splitEmojiText` 按 emoji 首 UTF-16 单元建候选表，文本扫描时只检查可能命中的内置 emoji，避免长消息按字符重复遍历完整表（决议 #131）。粘贴分流先处理真实文件路径；若剪贴板有 `text/plain`，不拦截原生文本粘贴，避免富文本 emoji 同时携带的图片副本误走截图发送（决议 #135）。该路径不引入远程图片、字体、CDN 或新依赖，解决 Win7 / UOS 系统 emoji 缺字方框问题（决议 #45/#47/#48）。Twemoji 图形按 CC-BY 4.0 在 README、`THIRD_PARTY_NOTICES.md` 和设置 About 页署名。
- **品牌 logo 源文件**（决议 #107）：用户提供的 SVG 套件是品牌唯一源。`build/icons/pantry-logo-icon.svg` 使用 taskbar/dock 版本并生成 `pantry-logo-icon.png` / `.ico` / `.icns`（`scripts/gen-app-icons.mjs`：rsvg-convert 渲染高清主位图 → png2icons 出 `.ico`[BMP，兼容 Win7] / `.icns`，链式重跑 gen-linux-icons）；`pantry-logo-standard.svg`、`pantry-logo-small.svg`、`pantry-logo-menu.svg`、`pantry-logo-mono.svg`、`pantry-mark.svg`、`pantry-horizontal-logo.svg` 保留为可审阅 SVG 源。渲染层 `PantryBrandLogo` 直接加载 `src/renderer/src/assets/brand/*.svg`，不再手写 path。托盘图标由 `scripts/gen-tray-icon.mjs` 从 `pantry-logo-mono.svg` / `pantry-logo-menu.svg` 渲染 32×32 PNG 后内嵌到 `src/main/windows/tray-icon.ts`；同时导出彩色 RGBA 底图，`tray-badge.ts` 在该底图上叠未读角标，保证 Win/Linux 闪烁帧与 SVG 源一致。**Linux 桌面图标**（决议 #58）：`build/icons/linux/` 多尺寸 png（由 `scripts/gen-linux-icons.mjs` 从品牌 png 缩放生成）装入 deb 的 hicolor；desktop 文件带 `StartupWMClass`；主/设置窗在 Linux 显式设置 `BrowserWindow` icon（extraResources 分发 256px png），任务栏图标不依赖桌面环境关联。
- **托盘未读提示**：`ChatService` / `FilesService` 的 `convs` 事件统一汇总未读数后调用 `updateTrayUnread`（决议 #42）。macOS 使用 `Tray.setTitle` + `dock.setBadge` 显示数字；Windows 使用 `BrowserWindow.setOverlayIcon` 叠加 16×16 数字，并让托盘图标在原图与带数字角标图之间闪烁；Linux 调 `app.setBadgeCount` 作为 best effort，同时以托盘闪烁兜底。动态图标由 `tray-badge.ts` 纯 Node PNG 编码生成，不引入图片库或 native 依赖。
- **图片管线（renderer canvas + 主进程剪贴板读写）**：发送图片 → `createImageBitmap` 解码 → 缩略图（≤280px）即时展示；「添加到表情」→ 静图重采样到 ≤512px → `toBlob('image/webp', 0.8)`；GIF 检测文件头 `GIF8`，≤2MB 原样收藏。聊天图片 / 表情消息右键「复制」复用 `fetchStickerSource(transferId)` 受限读取源文件，渲染层解码后转 `image/png`，经 `clipboard:write-image` IPC 交主进程 `nativeImage` + `clipboard.writeImage` 写系统图片剪贴板并读回校验；输入框粘贴先处理真实文件、文本和浏览器 `ClipboardEvent.items` 图片。主进程 `before-input-event` 的 `clipboard:paste-image` 只负责 Electron 原生图片剪贴板兜底：渲染层收到事件后延迟读取 `clipboard:read-image`，若同一次浏览器 paste 已处理文件 / 文本 / 图片，则取消兜底，避免第三方截图工具同时暴露两路图片时重复发送（决议 #137/#138/#180）。产出 Blob 经 IPC（ArrayBuffer）交主进程落盘。
- **群聊媒体管线**：不新增群组数据面；`FilesService` 为每个在线群成员创建独立 transfer，offer 携带 `groupId/groupRev`，收端写入群会话并按需索要群元数据。群聊图片仅单图 ≤10MB 时携带 `purpose:"image"`；超过 10MB 自动退化为普通文件 offer，收端显示文件卡片并等待手动接收，避免大群同时拉取造成流量尖峰。发送端消息 `file_ref.transferIds[]` 汇总多个 transfer，文件卡片按完成/失败数量展示整体状态。
- **文件卡 UI / 状态管线（决议 #174/#176/#177/#178/#179）**：`ChatPane` 的文件 / 文件夹按钮保持普通发送。`FileCard` 在发送方私聊普通文件卡片 `offering` 状态下显示「直接发送」按钮；按钮 enabled 由消息 offer 已送达、peer online、caps `fd1`、非群聊决定。点击后卡片 direct 标记写入 transfer `files` JSON 并推送 transfer 更新；发送侧 `offering` 将「等待接收 / 发送中」作为文件名同行固定状态片，meta 只保留大小 / 文件数 / 速率，右侧只保留一行动作，避免新增直接发送后卡片变高且状态被截断；发送完成统一显示「发送成功」。普通入站文件 `offering` 接收态右侧为一行动作组：`accept` 主按钮、`accept(..., true)` 文件夹图标另存、`decline` 的 `x` 图标拒绝，避免三按钮纵向堆叠撑高卡片；主按钮默认落到 `文件保存位置/联系人名称/`，文件夹图标另存直接落到用户选择目录。接收侧 accepted 显示「接收中」，direct done 只显示「已保存本地」，不展示完整路径或发送人目录名。群聊文件卡永远不显示「直接发送」。
- **状态流**：pinia store 是 main 数据的**只读投影** + 乐观更新（发消息先插 `sending` 态，`msg:status` 事件校正）；窗口重载（开发期热更）时全量拉取重建。会话打开额外携带渲染层滚动意图（restore / latest / target）：会话列表前台切换按 convId 恢复 scrollTop，首次打开/通知托盘/震动直达/回到最新走 latest，历史搜索跳转走 target 交给高亮消息居中；主窗隐藏时清掉本轮滚动缓存，使恢复后重新点开会话默认看最新（决议 #111）。渲染层 `chatStore` 对已加载会话额外维护内存级 `MessageCache`（`Set<msgId>` + `Map<msgId, MessageView>`），用于追加去重、状态事件 O(1) 定位、历史页去重和删除会话后的缓存清理；文件 / 图片 / 表情发送完成后按返回的 `MessageView.convId` 回填，避免发送期间切换会话造成列表错位（决议 #130）。联系人在线计数、单聊 peer 查找、群在线收件人数、群添加成员候选和群发文件卡片传输统计均避免重复数组遍历或临时数组分配，联系人 / 群成员规模上升时仍保持按既有状态投影单次计算（决议 #131）。该状态只在 renderer 内存中存在，不写库、不经 IPC。
- **PK 渲染状态**：`MessageView.kind` 增加 `pk`，并携带 `pkRef`。`ChatPane` 对他人的 PK 消息始终渲染气泡外侧参与按钮：猜拳为「我也来」，骰子为「掷一下」；自己的 PK 消息不显示按钮。按钮可反复点击，每次都走 `msg:pk` 发送新的独立消息，不建参与状态表、不按回合聚合。按钮 enabled 由当前在线状态决定：单聊对方在线才可点；群聊至少一位其他成员在线才可点，否则灰显并提示「PK 只能和在线的人玩」。动画播放状态只存在组件内存中：新发 / 新收消息播放一次约 1.5s，分页历史直接显示最终结果，`prefers-reduced-motion` 直接跳到结果。骰子用 CSS/SVG 自绘真实点数组合；猜拳使用本地 Twemoji 原色手势资源（缺资源时补 SVG 并同步署名）。工具栏 PK 入口、玩法浮层和参与按钮均复用现有 `PantryIcon` / CSS token，不新增依赖；动效只用 transform / opacity。不引入 GIF、第三方动画库、远程图片或远程字体。
- **输入提示层级**：渲染层所有 `input/textarea::placeholder` 统一读取 `--text-placeholder`（决议 #38），该 token 低于 `--text-3`，用于占位 hint；真实输入、标签、错误仍使用既有文字 token，避免把提示当内容。
- **联系人详情交互**：`PeerList` 向主壳分别发出 `select` 与 `chat` 事件（决议 #40）。单击只更新右侧 `ProfileCard` 投影；双击复用主壳 `chatWith -> chatStore.openPeer`，沿用既有会话打开与探活流程，不新增 IPC 或协议。
- **左侧导航悬停层（决议 #116/#117/#118/#119/#121）**：主壳 `App.vue` 内维护 `activeRailHint` 与延迟 timer，不经 IPC。按钮 tooltip 只用一个 `::after` 圆角标签，取消独立箭头 `::before` 和位移动画；显示态由 `pointermove` 后计时触发，不再使用 CSS `:hover` / `:focus-visible`，避免默认焦点和窗口打开在静止鼠标下方时误弹。启动后若原生焦点落在 rail 按钮则主动 blur，点击 rail 按钮后也释放焦点，避免系统黄色焦点框残留。自己信息卡仅绑定头像 `:hover`，不使用 `focus-within`，避免启动焦点造成误弹。可见文本来自本地 `SettingsView` / `AppInfo` 投影。原生 `title` 改为 `aria-label`，既避免系统 tooltip 抢占，又保留辅助语义。
- **通知与 Release 验证（决议 #108/#120）**：Linux / Windows 桌面通知显式传本地应用图标，`notificationIconPath` 按目标平台选择 `path.posix` / `path.win32`，避免在 Windows runner 上为 Linux 产物生成反斜杠路径。Release workflow 的平台五连验证必须命令失败即阻断后续构建/发布；Windows PowerShell 步骤逐条检查外部命令退出码，macOS/Linux 显式使用 shell 失败即退出策略。
- token 全部走 `styles/tokens.css` CSS 变量（深色主题 v0.4 只换变量表）。
- 性能预算（NFR 对照）：通讯录树重聚合 ≤16ms（1000 节点，主进程聚合好再推）；搜索请求防抖 200ms；`transfer:progress` 节流后 UI 才消费。

## 8. 导出 / 导入

**备份包 `.pantry-bak`**（即 zip）：

```
manifest.json    # {formatVer, exportedBy: nodeId, nick, range, counts}
messages.jsonl   # 一行一条（流式读写，不怕大）
peers.json / groups.json / stickers.json
media/transfers/... # 消息引用的图片/表情媒体；普通文件不打包（仅保留文件名记录）
media/stickers/...  # 自定义表情包媒体
```

- **导入身份映射**（决议 #19）：`is_mine=1` 的消息 `sender_id` → 重写为本机 nodeId；其余保持原值。peer 资料按 `last_seen` 新者胜合并。
- 去重：`INSERT OR IGNORE`（消息主键即协议 msgId）；媒体按备份条目恢复到当前用户数据目录，后续可再做 sha256 级复用。
- 阅读导出：HTML（内联样式+缩略图，单文件夹自包含）/ TXT（纯文本）。
- 当前实现使用自写 store/deflate ZIP 读写器，不引入额外依赖；导出/导入在主进程同步执行，首个 P1 版本以可迁移为先，大库进度条与 importPreview 留 v1.0 打磨。

## 9. 关键技术风险与对策

| 风险 | 对策 |
|---|---|
| Win7 / UOS emoji / 系统图标字形不一致 | 系统图标自绘；头像模板、emoji 面板、输入框编辑态和消息正文内置 emoji 子集使用 Twemoji 本地 SVG 子集（§7），不依赖系统彩色 emoji 字体；**输入框 textarea 加等宽空白字形字体 `PantryEmojiBlank`（决议 #56）**——`scripts/gen-emoji-blank-font.mjs`（devDep opentype.js）生成、ttf 提交仓库，内置 emoji 基础码点 advance=1.3em、FE0F 零宽，仅用于 textarea 与镜像层；三平台输入框字符度量一致，镜像图标满槽不重叠；测试校验 cmap 覆盖全部 `COMPAT_EMOJIS` 码点 |
| Debian 10 / UOS 20 glibc 2.28 vs CI 编译环境 | linux 侧 better-sqlite3 在 **debian:10 容器**内编译（apt 指向 archive 源）；electron-builder 关闭二次 `npmRebuild`，避免预编译包覆盖源码编译结果；CI 对源码重建产物与最终 `app.asar.unpacked` 内 `.node` 做 `GLIBC_2.28` 上限检查；产物在真 Debian 10 / UOS 20 冒烟 |
| linux arm64 native 模块与 Debian 10 / UOS 20 glibc 基线 | 独立 CI job 使用 GitHub 远程 `ubuntu-22.04-arm` runner 跑 `node:18-buster` Debian 10 arm64 容器，在目标架构内 `npm ci`、源码重建 better-sqlite3、五连验证和打包；arm64 deb/AppImage 阶段安装系统 fpm / mksquashfs 并设置 `USE_SYSTEM_FPM=true` / `USE_SYSTEM_MKSQUASHFS=true`，避免 electron-builder 下载 x86 打包工具；Debian 10 Ruby 2.5 下安装 `libffi-dev`，先锁定 `ffi 1.15.5` 再安装 `fpm 1.9.3`，避免 RubyGems 解析到 Ruby 3+ 依赖；产物内 `.node` 同样检查最高 GLIBC 符号不超过 2.28，避免交叉编译或模拟层误用宿主二进制 |
| macOS 26 跑 Chromium 108 | 已知风险项（README FAQ）：输入法、通知权限、屏幕录制授权列入发布冒烟清单 |
| Win7 终端为统一 VM（虚拟显卡弱/驱动旧）；UOS/Debian 多国产 GPU 或旧驱动 | **Win7 与 Linux 默认禁用硬件加速走软渲染**（决议 #55）——VM 虚拟显卡与国产 GPU 驱动是 Electron 花屏/GPU 进程报错的头号惯犯，2D 聊天界面软渲染完全流畅；macOS 默认开启，高级设置留开关 |
| Wayland 无法全局截图 | 启动检测 `XDG_SESSION_TYPE`，Wayland 下截图按钮降级提示"用系统截图后 Ctrl+V" |
| UDP 广播被交换机/AP 隔离 | 协议已有三板斧兜底（手动 IP/扫描/gossip）；FAQ 文档化引导 IT 放行 |
| 超大文件/超大图片打爆内存 | 文件收发全程流式：首次拉取时发送端边读边写 TCP 并同步计算 SHA-256，接收端 pull 流直写磁盘，内存中永不持有整文件；图片解码限制单图 ≤50MP |
| 渲染层或备份 JSON 借本机绝对路径读取任意文件 | 主进程只接受 `filePick` 产生的按窗口隔离一次性路径授权；图片路径发送前复制进应用图片目录。`pantry-img` / `pantry-sticker` / OCR / 表情提取只读应用管理媒体目录下、状态完成且类型匹配的记录；备份导入无归档媒体时不保留外部 `savedPath` / 表情 `path`，备份导出也只打包应用管理目录下的媒体（决议 #132）。 |
| asar 与 native 模块 | `asarUnpack: ['**/better_sqlite3.node']` |
| 节点时钟漂移打乱消息序 / 显示时间不准 | 排序键 `(ts, seq)`，seq 本地单调兜底（乱序只影响跨机微观顺序，可接受）；**显示时间经 `net/peer-clock.ts`（PeerClock）接收侧矫正**（决议 #65）——复用 `Envelope.ts` 估各节点时钟差，对方消息换算到本机钟、上界钳本机当前，零协议改动 |
| 1000 节点报文洪峰/恶意泛洪 | codec 层每源 IP 令牌桶限速 + 总入站队列上限，超限丢弃并计数 |
| 自更新：从内网节点取可执行包来运行（决议 #166/#181） | 信任内网边界（决议 #5）且**用户确认才装**（非静默）+ SHA-256 完整性（复用传输层 `done` 帧）+ 同平台同架构严格匹配 + 包内版本核对 + 大小上限；纯内网零外网（红线 #5 禁的是外网更新检查 / CDN）。应用更新走平台脚本（nsis per-user 静默装免 UAC、deb 经 pkexec 授权），保留旧包 / 失败回滚；替换正在运行的自身由接力进程在主进程退出后完成；mac 暂缓 |

## 10. 构建与 CI

- electron-builder 要点：`electronVersion: 22.3.27`；win=`nsis`(x64，不出 32 位，决议 #20)+`portable`；linux=`deb`+`AppImage`（x64 + arm64，决议 #181；Debian 10 / UOS 20 基线）；mac=`dmg`+`zip`（**arm64 / Apple Silicon，决议 #69**；CI `macos-14` 原生打包，未签名/未公证内网自用；Intel x64 / universal 后续专项）；`asar: true` + `asarUnpack: **/better_sqlite3.node`；appId `com.pantry.app`。
- **productName=`Teahouse`，安装路径全 ASCII（决议 #60）**：Linux 装 `/opt/Teahouse`、Windows 默认 `Teahouse` 目录；显示名经 Linux desktop `Name`、NSIS `shortcutName`、mac `extendInfo` 保持「茶话间」；主进程启动最早处 `app.setName('茶话间')` 固定 userData 与通知名（已有用户数据零迁移）。**Linux 打包必须 `USE_HARD_LINKS=false`**（dist:linux 与 CI 均已内置）：electron-builder 复制硬链接优化会让 deb 出现跨 `/usr`↔`/opt` 硬链接条目，UOS 深度安装器解包报"断开的管道"；窗口图标 extraResources 用独立物理文件 `build/icons/window-icon.png`，CI 解 deb data.tar 校验无硬链接条目、无中文路径。
- 品牌资源：`build/icons/` 保存可审阅 SVG 源和生成后的 `.png` / `.ico` / `.icns` 打包图标；托盘运行态不依赖文件路径，仍使用内嵌 Data URL，保证开发、打包与 asar 场景一致。
- GitHub Actions 矩阵：`.github/workflows/release.yml` 中启用 Windows / Linux x64 / Linux arm64 / macOS arm64 四条发布线（决议 #69/#86/#181/#182/#183/#184/#185/#186）。Windows 用 `windows-2022` 构建 Win7 SP1 x64 兼容的 NSIS 安装包与 portable exe；Linux x64 用 `node:18-buster` / Debian 10 容器强制源码重建 better-sqlite3，electron-builder 关闭二次 `npmRebuild`，并检查最终包内 native 模块最高 GLIBC 符号不超过 `GLIBC_2.28`，输出 deb + AppImage，作为 Debian 10 / UOS 20 x64 产物；Linux arm64 用 GitHub 远程 `ubuntu-22.04-arm` runner 跑 `node:18-buster` Debian 10 arm64 容器，调用 `scripts/ci-linux-arm64.sh` 在目标架构内执行同样的 npm ci / native 重建 / 五连验证 / GLIBC 校验 / deb 归档校验。`dist:linux` / `dist:linux:arm64` 分别显式构建 `deb:x64 AppImage:x64` 与 `deb:arm64 AppImage:arm64`，避免 target 配置误打另一架构；arm64 job 通过系统 fpm / mksquashfs 生成 deb 与 AppImage，Debian 10 Ruby 2.5 下安装 `libffi-dev`，先安装 `ffi 1.15.5` 再安装 `fpm 1.9.3`，输出 `Teahouse-<version>-linux-arm64.deb` 与 `Teahouse-<version>-linux-arm64.AppImage`，容器结束后打印 `release/` 文件列表辅助定位路径问题；`.deb` 维护者元数据固定为 `Teahouse Maintainers <teahouse-maintainers@example.invalid>`；macOS 用 `macos-14` 原生 arm64 runner 构建 dmg + zip。push 到 `main` / 手动触发上传 artifact，推送 `v*` tag 时自动创建/更新 GitHub Release；目标平台真实桌面冒烟仍按 `docs/packaging-test.md` 执行。
- Release workflow 权限按最小化原则配置（决议 #132）：默认 `contents: read`；构建 job 的 checkout 不持久化 GitHub 凭证；只有发布 GitHub Release 的 job 显式授予 `contents: write`。
- 版本号：`package.json` 单一来源；协议 `profile.ver` 随包版本注入（"内网有新版"提示的依据，见 protocol §3）。**每轮迭代（每个增量 commit）按决议 #73 递增版本号**：功能更新 minor +1 且 patch 归 0，bug 修复 / 微调 patch +1；deb/NSIS 按版本号判断升级，同版本号在 UOS 上会被 dpkg 以"已安装同样版本"拒装；artifactName 含 `${version}`，产物名随之区分。
- 内网分发：产物 + SHA-256 校验清单一并产出。

## 11. 测试策略

- **vitest 单测**（开发机 Node 跑，不依赖 Electron）：codec 编解码与坏报文模糊样本、补发队列裁剪规则、按字分词、文件名清洗、导入身份映射/去重——纯函数全覆盖。私聊直接发送覆盖 codec 用例（合法 `op:"direct"`、缺 transferId 拒绝）与 FilesService 用例（发送侧卡片请求 direct、接收侧收到 direct 自动 accept 到联系人目录、关闭开关或群聊 transfer 忽略 direct）；默认接收目录覆盖手动「接收」落到联系人子目录、另存为不额外套子目录。
- **数据库自测**（`npm run test:db`）：esbuild 打包自测脚本后用 `ELECTRON_RUN_AS_NODE=1 electron` 执行——在 **Electron 内置 Node（ABI 110）** 上验证迁移/repo/FTS，与生产运行时完全一致。vitest 跑在开发机新版 Node 上加载不了 Electron ABI 的原生模块，故 DB 层测试必须走这条通道。
- **协议联调**：两个主进程实例本地回环（127.0.0.1 + 不同端口）跑发现/消息/补发/文件全流程脚本，模拟丢包（随机丢 10% UDP）。
- **三平台冒烟清单**（人工，发布前必过）：Win7 x64 VM（与生产环境一致）、Debian 10、macOS 26 各过一遍 README 红线场景 + 收发文件 + 截图 + 通知。
- E2E（Playwright `_electron`）：主流程烟测，配对版本脚手架期验证。

## 12. 里程碑与模块映射

| 版本 | 交付 | 涉及模块 |
|---|---|---|
| v0.1 | 脚手架、发现/在线/探活、单聊文本、补发、托盘通知、三栏壳 | net 全套（除 transfer）、store、chat、主窗 |
| v0.2 | 文件/文件夹传输、图片消息、emoji、历史+全局搜索 | transfer、fts、file-card、emoji-panel |
| v0.3 | 讨论组、截图、表情包、跨网段（扫描+gossip）、三级树 | groups、capture、stickers、discovery 扩展、contacts |
| v0.4 | 撤回、断点续传、导出/导入、深色主题 | messenger、transfer、porter、tokens |
| v0.5 | P1 交付补齐：转发、群内 @、长文本 TCP、截图标注、核心设置、备份包媒体迁移 | services、settings、porter、renderer |
| v0.27 | 局域网 P2P 自更新（分三步）：①发现与提示（caps `upd1` / 运行形态自检 / `ver` 投影 / 同平台版本比对 / 「内网有新版」提示）②拉包（`update` 可靠请求 / 按请求架构匹配已有本地包并隐藏回传 / nsis 自留包·deb `dpkg-deb` 自重打包 / 拉临时目录 + SHA-256 + 版本核对）③应用更新（nsis 静默装·deb pkexec / 替换重启 / 保留包接力成源）；mac 暂缓 | services/updater、transfer 复用、discovery（caps/ver）、util/self-package·apply-update、提示 UI |
| v0.28 | 私聊文件直接发送：发送端文件卡片「直接发送」入口、caps `fd1`、`file-ctl {op:"direct"}`、接收端自动 accept；默认文件接收统一到 `文件保存位置/联系人名称/`，另存为除外；群聊文件不支持直接发送 | shared/protocol、net/codec、services/files、settings、renderer FileCard |
| v1.0 | 三平台安装包打磨、冒烟全过、文档定稿 | CI/builder |

## 13. 变更记录

- 2026-06-10 v0.1 初稿：选型总表（TS/electron-vite/Vue3/better-sqlite3/canvas 图片管线/builder24）、进程窗口模型、目录与分层、IPC 契约、库表与中文 FTS 方案、数据目录与迁移、备份包格式与身份映射、风险对策表、CI 与测试、里程碑。
- 2026-06-10 v0.2 决议 #20（不支持 32 位）：Windows 仅 x64 产物，构建/CI 矩阵相应缩减；原 ia32 内存风险项改写为通用大文件/大图内存防护。
- 2026-06-10 v0.3 环境事实补充：内网 Win7 终端为统一 64 位 VM → Win7 默认禁用硬件加速（软渲染）；新增架构总览图 assets/architecture.mmd。
- 2026-06-10 v0.4 决议 #21 预留：本地 AI 开放接口作为未来与 `ipc/` 并列的第二前台，复用 services 层；立"业务逻辑禁入 ipc/ 层"的纪律，当前版本不实现接口本体。
- 2026-06-10 v0.5 查漏轮（决议 #22）：peers 表加 `remark`（本地备注）；日志脱敏入安全基线；twemoji CC-BY 署名；启动复位残留 sending 态。
- 2026-06-11 v0.6 存储层落地实测：better-sqlite3 锁定 9.6.0（Electron 22 ABI 编译/运行通过）；`.npmrc` runtime=electron 构建策略；peers 表补 `udp_port` 列；新增 `test:db`（ELECTRON_RUN_AS_NODE 在真实 ABI 上自测）方法论入 §11。
- 2026-06-11 v0.7 文本消息撤回落地：IPC 增加 `msg:recall`；本地消息 kind 增加 `system` 用于撤回提示；原消息置 `status='recalled'` 并清理 FTS 索引。
- 2026-06-11 v0.8 首个可交付预览版打包链条：精确锁 `electron-builder@24.13.3`，新增 `dist:win` / `dist:linux` / `dist:mac`，配置 `electronVersion: 22.3.27` 与 better-sqlite3 asarUnpack；Windows/Debian 真实打包测试放到目标平台执行。
- 2026-06-11 v0.9 P1 本地交付候选：`services/porter.ts` 落地迁移备份包（消息/联系人/群/传输/表情/媒体）、`shared/ipc.ts` 补转发/会话操作/导出范围/端口设置契约；`TransferServer` 支持 TCP 长文本控制帧；数据库自测覆盖 porter 媒体恢复。
- 2026-06-11 v0.10 图标与群管理权限：图标方案改为项目内自绘 SVG；groups 表迁移 v7 增加 `creator_ip/admin_secret_hash`，服务层按创建 IP 或管理密码摘要限制改名/增删成员，退组保持免管理权限。
- 2026-06-12 v0.11 头像模板与设置图标修正：头像编号保持 number，前端按“20 个亲和动物 emoji 图标 + 背景色下标”组合解释；设置入口 SVG 重画为明确齿轮。
- 2026-06-12 v0.12 讨论组创建搜索与密码提示：groups 表迁移 v8 增加 `admin_hint`，群元数据/备份包携带密码提示；建群 UI 改为搜索选人后再设置组名与二次密码确认。
- 2026-06-12 v0.13 群聊媒体落地：文件 offer 支持群上下文，群聊图片/文件按在线成员逐个点对点传输；发送端一条消息汇总多条 transfer，收端入群会话。
- 2026-06-12 v0.14 群聊图片阈值修订：群聊图片内联上限收紧为 10MB；超限图片按普通文件卡片展示，接收端手动接收后才开始 TCP 拉取。
- 2026-06-12 v0.15 会话内历史搜索：IPC 增加 `msg:search`，由 `SearchService` 在当前会话范围内按关键词、图片、文件、日期范围查询 `messages`，结果复用既有 `msg:context` 跳转高亮。
- 2026-06-12 v0.16 会话内历史搜索 UI 精修：`ConversationMessageHit` 对图片/文件结果携带 `fileRef`，图片缩略图复用 `pantry-img://transferId`，弹窗改为设置页尺度的大面板。
- 2026-06-12 v0.17 会话内历史搜索默认展示：`msg:search` 允许空关键词返回当前会话最近记录，日期筛选由渲染层日历范围组件产生起止时间戳。
- 2026-06-12 v0.18 私聊资料弹窗：私聊头部昵称区域打开资料弹窗，备注修改复用 `peers:set-remark`，不新增线上协议。
- 2026-06-12 v0.19 输入框 hint 颜色修正：新增 `--text-placeholder`，渲染层统一 placeholder 颜色，不涉及 IPC、存储或协议。
- 2026-06-12 v0.20 品牌 logo 三件套：渲染层空状态与构建图标统一使用本地自绘茶杯气泡标识，托盘图标仍以内嵌 Data URL 适配 asar 场景。
- 2026-06-12 v0.21 联系人资料页重设计：`PeerList` 双击事件复用打开单聊流程，`ProfileCard` 改为内容区完整资料页。
- 2026-06-12 v0.22 托盘未读提示：`convs` 未读总数统一驱动 macOS 菜单栏数字 / Dock 角标、Windows taskbar overlay 数字与 Windows/Linux 托盘闪烁兜底。
- 2026-06-12 v0.23 菜单栏 logo 尺寸：托盘基础单色标识在 32px 画布内缩至约 82% 内容区，未读闪烁图标复用同一缩放比例。
- 2026-06-12 v0.24 GitHub Actions 发布链路：新增 Windows 7 x64 与 Debian 10 / UOS 20 x64 自动构建、SHA-256 清单、tag Release 发布；Windows 安装版与便携版 artifactName 拆分，避免同名覆盖；打包图标显式接入 `.ico` / `.png` / `.icns`，Linux CI 强制源码重建 native 模块以锁住 glibc 2.28，并补齐 `.deb` Maintainer 元数据。
- 2026-06-12 v0.25 Win7 / UOS 真实平台兼容：头像与内置 emoji 子集改为本地 SVG 渲染；`Messenger` 在短文本 UDP 退避无 ACK 后复用 TCP 控制帧兜底一次，再决定入离线队列。
- 2026-06-12 v0.26 头像美术资源修正：头像与内置 emoji 兼容显示改用 Twemoji 本地 SVG 子集，运行时零外网请求，并补 CC-BY 4.0 署名文件与 About 页展示。
- 2026-06-12 v0.27 输入框 emoji 兼容补齐：聊天输入框在草稿包含内置 emoji 时启用 Twemoji 本地 SVG 镜像层，底层仍保留原生 textarea 编辑行为。
- 2026-06-12 v0.28 沉浸式窗口与镜像对齐：主窗 / 设置窗 frameless（决议 #49，新增 `win:minimize` / `win:toggle-maximize` / `win:is-maximized` IPC 与 `win:maximized-changed` 事件，渲染层 `WindowControls` 组件）；输入框 emoji 镜像层改为隐藏 DOM 探针按实际字体逐字符测宽对齐（`utils/emoji-metrics`；canvas measureText 对 emoji 的度量与 DOM 排版不一致不可用；探针挂 `<html>` 下避开 body zoom 字体缩放）；设置页头像编辑器重排（决议 #50，纯渲染层改动）。
- 2026-06-12 v0.29 沉浸式跨平台修正（决议 #51/#52）：mac 主窗 `trafficLightPosition` 移至 x=68；Linux 弃用 CSS 拖拽区，新增 `win:begin-drag` / `win:end-drag` IPC（主进程光标跟随移窗），渲染层拖拽带抽为 `WindowDragStrip` 组件按平台分流。
- 2026-06-12 v0.30 UOS20 glibc 2.28 打包修正：electron-builder 关闭二次 native rebuild，Linux `dist` 前强制源码重建 better-sqlite3，并在 CI 校验源码重建产物与最终包内 `.node` 的最高 GLIBC 符号不超过 2.28。
- 2026-06-12 v0.31 决议 #55 与拖拽区修正：Linux 与 Win7 同策略默认禁硬件加速（§9 风险表更新）；删除聊天头部 `-webkit-app-region: no-drag` 残留——no-drag 矩形会从 drag region 中挖洞，导致 Win7/mac 聊天区顶部 32px 无法拖窗。
- 2026-06-12 v0.32 第三十二轮（决议 #56–#59）：输入框 emoji 等宽空白字形字体 `PantryEmojiBlank`（§9 风险表更新，gen-emoji-blank-font 脚本 + cmap 覆盖测试）；`SettingsView` 增 `shortcutStatus` 注册结果回传，快捷键默认组合常量收敛 `shared/ipc.ts`；Linux 多尺寸桌面图标 / StartupWMClass / 窗口显式 icon 与 Win·Linux 彩色托盘（§7 资产说明更新）；新增 `win:close` IPC——渲染层 DOM `window.close()` 走 CloseImmediately 绕过 close 事件（§2 红字禁令），是 Win7/UOS 关闭未进托盘的根因。
- 2026-06-13 v0.33 决议 #60（§10 更新）：productName 改 ASCII `Teahouse`（安装路径无中文，显示名与 userData 经 desktop Name / shortcutName / extendInfo / app.setName 保持「茶话间」）；Linux 打包强制 `USE_HARD_LINKS=false` + 窗口图标独立文件，根治 deb 跨树硬链接致 UOS 安装失败；CI 增 deb 归档校验（无硬链接、无中文路径）。
- 2026-06-13 v0.34 决议 #61：全局自绘 `::-webkit-scrollbar`（tokens.css）替换 Win7 软渲染下抽搐的系统 overlay 滚动条；输入框 textarea 与镜像层同步顶部留白修首行遮挡。纯渲染层改动。
- 2026-06-13 v0.35 决议 #64：品牌 logo 重设计（饱满扁平茶杯气泡），新增 `scripts/gen-app-icons.mjs`（rsvg-convert + png2icons devDep）统一生成 png/ico/icns，链式重跑 gen-linux-icons；PantryBrandLogo 同造型。
- 2026-06-13 v0.36 决议 #65：新增 `net/peer-clock.ts`（PeerClock 时钟偏移矫正）；discovery 实时报文采样偏移、chat/groups 入库对方消息时矫正显示时间到本机钟；零协议改动，排序仍 seq。
- 2026-06-13 v0.37 决议 #69：CI 新增 macOS arm64 job（macos-14 原生打包 dmg/zip），GitHub Release 改三平台齐发（Win7 / Debian·UOS / macOS arm64）；package.json mac target 显式 arm64。
- 2026-06-15 v0.38 决议 #87/#88：群改名系统提示复用 `messages.kind='system'`，按 `group:<groupId>:rename:<rev>` 幂等写入；单聊头部 IP 完整展示为渲染层样式约束，不涉及 IPC/协议/存储迁移。
- 2026-06-15 v0.39 大文件传输 0B 延迟修复：`TransferServer` 首次拉取改为同一读流边发送边计算 SHA-256，断点续传时数据流与整文件哈希流并行，避免接收方点接受后需等待发送端预读完整大文件才出现进度；协议帧格式不变。
- 2026-06-15 v0.40 决议 #93：图片查看器增强为纯渲染层状态机（缩放、适应窗口、原始大小、旋转、拖拽平移、滚轮与键盘控制），图片源仍走 `pantry-img://transferId`，另存为仍走既有 `saveImageAs` IPC；不新增协议、存储或主进程业务逻辑。
- 2026-06-15 v0.41 决议 #94：新增 `windows/image-viewer-window.ts` 与 `#/image-viewer` 渲染入口，聊天/历史搜索通过 `img:open-viewer` 打开独立普通窗口；主窗不再挂图片覆盖层，`img:save-as` 保存对话框按调用方 webContents 绑定图片窗口。
- 2026-06-15 v0.42 决议 #95：新增 `img:fit-viewer-window` IPC，图片窗口渲染层在解码后上报 natural size，主进程按调用窗口所在 display 的 workArea 70% 计算初始 zoom 与 content size；图片窗口标题只取 transfer name，底部半透明工具条在渲染层覆盖绘制。
- 2026-06-15 v0.43 决议 #96：图片查看器不再用 `transform: scale()` 表达缩放，改为渲染层显式计算 `<img>` CSS width/height（natural size × zoom），`transform` 仅用于 translate/rotate；图片窗口 BrowserWindow 最小内容尺寸降到 1×1，由实际图片缩放结果决定内容区大小，避免大图/极端比例图因布局盒子或最小尺寸产生空白。
- 2026-06-15 v0.44 决议 #97：图片查看器 OCR 采用 Tesseract.js 浏览器 worker，本地复制 `worker/core/lang` 静态资源到 renderer public 目录并显式传入 `workerPath/corePath/langPath/workerBlobURL:false`，禁止 CDN fallback；新增只读 `img:ocr-source` IPC，主进程按已登记 transferId 返回受限图片字节，不暴露文件路径。渲染层在 `ImageViewer` 内维护 OCR 内存状态，小图自动识别，大图手动识别，识别框按 natural image 坐标随现有 zoom/offset 叠加；本轮不写数据库、不加协议字段、不做“大爆炸”UI。
- 2026-06-15 v0.45 决议 #98：OCR 结果归一化时优先使用 Tesseract `word.symbols[].bbox` 生成字符级 token，并给 token 记录 `wordIndex`；复制时按 lineIndex/tokenIndex 排序，同一 wordIndex 内不插空格，跨英文/数字 wordIndex 才补空格，中文连续拼接。此调整只改渲染层选择/复制算法和 CSS cursor，不触碰 IPC、主进程读取口或 OCR 资源加载。
- 2026-06-15 v0.46 决议 #99：图片查看器双击从 fit 切到 100% 时，渲染层用当前 `.image-plane` 屏幕矩形把鼠标点换算为图片原始坐标，再按目标 zoom 反推出 offset，使该坐标保持在鼠标下；键盘/工具栏原始大小仍居中。OCR 缓存键改为 `transferId:naturalWidthxnaturalHeight`，`ImageViewer` 在请求 `img:ocr-source` 前先查 `ocr.ts` 的内存结果缓存，命中即恢复 tokens/状态；缩放、平移、旋转均不触发 OCR。无协议、IPC、存储或主进程改动。
- 2026-06-15 v0.47 决议 #100：图片查看器布局从 grid item 居中改为 `.image-plane { position:absolute }` + style `left/top: calc(50% + offset)` + `transform: translate(-50%, -50%) rotate(...)`，使 oversize 图片不受 grid 溢出对齐影响。双击锚点几何抽到 `renderer/utils/image-viewer-geometry.ts`，单测覆盖「fit→100% 后同一图片坐标仍在鼠标下」和图片外点忽略。OCR layer 保持 `pointer-events:none`，只有 `.ocr-token` 与复制按钮为 `pointer-events:auto`；token pointer capture 继续支持拖选，空白区域事件落回 stage 平移。
- 2026-06-15 v0.48 决议 #101：OCR 拖选从矩形相交算法改为 token range 算法：pointerdown 记录起始 tokenIndex，pointermove 将图片坐标映射到最近 tokenIndex，选中两者之间的连续 token；复制按钮位置由已选 token bbox union 计算。删除可见 `ocr-selection` DOM/CSS，未选 token 背景/描边归零，选中 token 只显示半透明底色。`ocr.test.ts` 补覆盖拖选范围选择与最近 token 命中。
- 2026-06-15 v0.49 决议 #102：新增主进程会话级 `ImageOcrResultCache` 与 `img:ocr-result-get` / `img:ocr-result-set` IPC。渲染层识别成功后将归一化 result 写入主进程内存缓存；图片窗口 `onImageLoad` 先按 `transferId:naturalSize` 查询缓存，命中即 `applyOcrResult` 并跳过自动 OCR / 图片字节读取。缓存只在本次 app 进程内有效，不写 SQLite、不建索引；主进程对 result 做字段/数量上限校验并限制 LRU 条数，避免 IPC 传入异常大对象。
- 2026-06-15 v0.50 决议 #103：OCR 选择算法改为 caret boundary：`findOcrCaretBoundary(tokens, point)` 先取最近行，再用字符 bbox 中心线求插入边界（`tokenIndex` 前或 `tokenIndex + 1` 后）；`getOcrBoundaryRangeIds` 使用半开区间 `[minBoundary, maxBoundary)` 生成选中 token。组件记录 `ocrSelectionStartBoundary`，pointermove 按当前 boundary 更新。保留旧 token range 工具仅作兼容/测试辅助，新增单测覆盖字间起点不误选前一字符。
- 2026-06-15 v0.51 决议 #105：图片 OCR 交互回退为文本结果窗。`ImageViewer` 不再渲染 `.ocr-layer` / `.ocr-token` / 局部复制按钮，也不再注册 OCR pointer handlers；识别完成后只保存 `ocrText`，用户点击 OCR 按钮或缓存命中后打开 modeless `.ocr-panel`，面板内 textarea 负责原生选择/复制。`ocr.ts` 保留 OCR 归一化与 `getOcrResultText(result)`，删除拖选命中/范围/bounds 辅助。`img:ocr-source` 与主进程会话级缓存 IPC 沿用 #97/#102，不新增协议、不落库、不联网。
- 2026-06-15 v0.51 决议 #104：品牌素材链路刷新为线性茶杯气泡 + 双叶 + 三点消息；三件套 SVG、`PantryBrandLogo`、`scripts/gen-tray-icon.mjs` 与 `tray-badge.ts` 共用同一轮廓语义，重生成 png/ico/icns、Linux hicolor 与窗口图标。构建链路、内嵌 Data URL 与纯内网约束不变。
- 2026-06-15 v0.52 决议 #106：品牌轮廓订正为下缘半圆茶杯气泡，替换偏方 rounded-rect 杯身；三件套 SVG、渲染组件、托盘/未读 SDF 生成器和全套 PNG/ICO/ICNS 重新同步。
- 2026-06-15 v0.53 决议 #107：接入用户提供 SVG 套件，渲染层组件直接加载 SVG，`gen-tray-icon.mjs` 改为 rsvg 光栅化 SVG 并导出 RGBA 底图给未读角标，移除手写杯身 SDF 作为品牌源。
- 2026-06-15 v0.54 决议 #108：新增 `main/notifications.ts`，通知摘要统一对 emoji 做 `[表情]` 文本降级，媒体消息使用稳定占位；Linux / Windows `Notification` 显式带真实应用图标路径，修 UOS 通知中心默认图标问题。共享 emoji 码表上移到 `shared/compat-emoji.ts`，渲染层继续复用同一份 Twemoji 映射。
- 2026-06-15 v0.55 决议 #109：`ChatService` 新增私聊窗口震动用例，协议 `msg(kind:"nudge")` 可靠发送但不离线补发、不写库；`shared/ipc.ts` 增 `msg:nudge` / `msg:nudge-received`，主进程收到服务层 nudge 事件后短抖主窗，最大化/全屏时降级为系统闪烁/弹跳。
- 2026-06-15 v0.56 决议 #110：震动收发两端改由 `ChatService` 写入本地 `system` 提示消息，系统消息不写 FTS；收端 `msg:nudge-received` 事件驱动 renderer 调用 `openConv(single:<peerId>)`，确保唤起后定位到发起人单聊。
- 2026-06-15 v0.57 决议 #111：渲染层会话打开加入 scroll intent 与 per-conv scrollTop 缓存，`ChatPane` 按 restore/latest/target 区分恢复位置、贴到最新和历史搜索定位；当前会话追加消息仅在已近底部或自己发送时自动贴底。无协议、IPC、SQLite 或主进程改动。
- 2026-06-15 v0.58 决议 #112/#113：免打扰单聊收到震动时 `ChatService` 只写系统提示，不发 `nudge` 事件；主进程非免打扰震动唤起改为 Windows 短暂 always-on-top 置前后再抖，修复被其他窗口遮挡时不弹到最上层。群元数据增加 `creator_id`/`creatorId`，SQLite 追加 v9 迁移并回填旧无密码群，远端 `group.info` 校验在创建 IP 之外接受创建者 nodeId。
- 2026-06-16 v0.59 决议 #114：新增 `net/range-sync.ts` 承载 `scan-ranges` 低频 CIDR 记录同步；`config.json` 扩展 `scanRangeSources/ignoredScanRanges`，主进程将远端记录入配置并排受控后台扫描，设置页通过 `SettingsView.scanRangeItems` 展示来源。
- 2026-06-16 v0.60 决议 #115：新增 `peers:scan-all-ranges` / `net:scan-progress` IPC，主进程对已保存扫描网段做去重手动探测，主界面左侧导航栏显示刷新进度；不新增线上协议或存储迁移。
- 2026-06-16 v0.61 决议 #116：左侧导航 tooltip 与自己信息卡由 `App.vue` 纯渲染层实现；使用现有 `SettingsView` / `AppInfo` 数据，不新增 IPC、协议、SQLite 或配置迁移。
- 2026-06-16 v0.62 决议 #117：自己头像信息卡移除焦点态触发，仅鼠标悬停显示；卡片结构调整为更松的标题区和分组资料区，不新增 IPC、协议、SQLite 或配置迁移。
- 2026-06-16 v0.63 决议 #118：左侧导航 tooltip 删除箭头伪元素与位移动画，保留单体标签短透明度显隐；纯 CSS 样式调整。
- 2026-06-16 v0.64 决议 #119：左侧导航 tooltip 改为 `pointermove` 后计时触发，移除 CSS hover/focus 直接显示；纯渲染层状态调整，不新增 IPC、协议、SQLite 或配置迁移。
- 2026-06-16 v0.65 决议 #120：通知图标路径按目标平台使用 POSIX/Windows 分隔符；Release workflow 五连验证改为失败即阻断发布，尤其修复 Windows PowerShell 外部命令失败后继续执行的问题。
- 2026-06-16 v0.66 决议 #121：启动和点击后释放左侧 rail 按钮焦点，并取消 rail 按钮原生 appearance/focus outline，修复系统黄色焦点框残留；不新增 IPC、协议、SQLite 或配置迁移。
- 2026-06-16 v0.67 决议 #124：英文品牌名 Pantry → Teahouse。`package.json` build 段 `productName`、各平台 `artifactName`、mac `CFBundleName/DisplayName`、deb maintainer、Linux `StartupWMClass` 与 UI 字标 / 主窗标题全部改 Teahouse；`app.setName('茶话间')`（决议 #60）保持不变，userData 与通知名仍按中文派生，零迁移。内部标识 `window.pantry`、`pantry-*` 协议 / 文件名、`.pantry-bak`、appId `com.pantry.app`、npm 包名 `pantry`、仓库 URL `skyjt/pantry` 一律保留。不改线上协议、存储、IPC。
- 2026-06-16 v0.68 决议 #125：「移除会话」改为删除聊天内容。`MsgRepo` 新增 `deleteByConv(convId)`——先删 `messages_fts` 中该会话所有 `msg_id` 的全文索引，再删 `messages` 行；`ChatService.removeConversation` 改为先 `deleteByConv` 再 `convRepo.remove`。10 秒撤回窗口与倒计时纯在渲染层 `chatStore.pendingRemoval` 实现，超时才调既有 `removeConversation` IPC 落库，撤回则完全不调用后端。db-selftest 增 `deleteByConv` 往返断言（消息与 FTS 一并清空）。无 schema 迁移、无协议 / IPC 签名变化。
- 2026-06-17 v0.69 决议 #130：`chatStore` 为已加载会话维护内存级消息缓存索引，追加去重与 `msg:status` 定位不再反复线性扫描；向上加载历史时过滤重复页；发送文件 / 图片 / 表情的本地回填以返回的 `MessageView.convId` 为准，不再依赖发送完成时的 `activeConv`。纯渲染层优化，不新增 IPC、协议、SQLite 或配置迁移。
- 2026-06-17 v0.70 决议 #131：全仓库扫描高频渲染路径后，`splitEmojiText` 增加 emoji 首单元候选表，peer / 群在线计数改为 Map getter 或单次循环，群添加候选用 Set 判断成员，群发文件卡片传输状态聚合为一次统计对象。纯代码优化，不新增 IPC、协议、SQLite 或配置迁移。
- 2026-06-17 v0.71 决议 #133：`chatStore.openConv/openPeer` 在 `scroll:'latest'` 时强制 `pageMessages(…, 50)` 重载最新页，震动 / 通知 / 托盘直达不再复用历史搜索上下文窗口或不完整缓存；`ChatPane` 给消息区内容容器挂 `ResizeObserver`，按 `stickBottom`（贴底意图，由滚动与打开模式维护）在图片 / 文件卡片等异步撑高后继续贴底，用户向上翻历史即停止。纯渲染层，不改 IPC、协议、SQLite。
- 2026-06-17 v0.72 决议 #134：`ChatPane` 新增 `farFromBottom`（`onScroll` 时按"距底 > 2× clientHeight"计算），与 `viewingHistory` 一起驱动消息区右下角悬浮"回到最新"圆按钮（`<Transition>` 淡入上移）；点击按是否历史页分流 `backToLatest`（重载最新页）/ `scrollToBottom`（滚到底）。按钮相对 `.body-wrap` 定位，不受输入框拖拽高度影响。纯渲染层。
- 2026-06-17 v0.73 决议 #135：`ChatPane.onPaste` 在真实文件路径后增加 `text/plain` 优先判断，让富文本 emoji 原生粘贴，不被 `image/png` 副本当截图发送；无文本图片剪贴板仍走 `sendImageBytes`。`jump-latest:hover` 明确白底与 `opacity: 1`，避免 hover 半透明。纯渲染层。
- 2026-06-17 v0.74 决议 #136：`ImageBubble` 的图片 / 表情右键菜单补「复制」，通过既有 `fetchStickerSource` 拿受限媒体字节，渲染层 canvas 转 PNG 后用 `ClipboardItem({'image/png': blob})` 写系统剪贴板；输入框粘贴继续走无文本图片发送链路。不新增 IPC 或主进程文件读取权限。
- 2026-06-17 v0.75 决议 #137：`ImageBubble` 的复制仍在渲染层转 PNG，但实际写入改走 `clipboard:write-image` 窄 IPC，由主进程 `nativeImage` + `clipboard.writeImage` 写系统图片剪贴板并 `readImage()` 读回确认，修复 `ClipboardItem` 在 Electron 环境里写入后无法粘贴的问题。
- 2026-06-17 v0.76 决议 #138：主进程 `before-input-event` 捕获 Command/Ctrl+V 后向主窗推 `clipboard:paste-image`；`ChatPane` 确认输入框聚焦，并在真实文件、文本和浏览器图片项都未命中时，调用 `clipboard:read-image` 从主进程读取 Electron 原生图片剪贴板 PNG 字节，再复用 `sendImageBytes` 发送；主进程有文本时返回 null，避免抢普通文字粘贴。
- 2026-06-17 v0.77 决议 #139：设计 PK 分歧解决技术方案。新增 `msg:pk` IPC 与 `msg(kind:"pk")` 载荷；主进程服务层用 `crypto.randomInt` 生成骰子 / 猜拳结果，单聊走 `ChatService` 在线即时发送，群聊走 `GroupsService` 向当前在线成员逐个可靠投递，不离线补发。SQLite 不新增表列，`messages.kind='pk'`、`content` 存不透结果的安全摘要、`file_ref` 存 `{game,result}`；渲染层用本地 CSS/SVG/Twemoji 动画与气泡外参与按钮，不发送真实 GIF、不引依赖。
- 2026-06-17 v0.78 决议 #140：PK UI 高可用打磨。只改渲染层：`PantryIcon` 简化 PK 入口并补玩法线性图标；`ChatPane` 浮层补 hover / active / focus / disabled；`PkBubble` 收紧视觉层级、参与按钮与 reduced-motion 行为。协议、IPC、SQLite、随机和投递语义不变。
- 2026-06-20 v0.79 决议 #158：图片 OCR 引擎由 Tesseract.js 换为 PaddleOCR PP-OCRv6_tiny + onnxruntime-web（决议 #97 Tesseract 方案退役）。`onnxruntime-web@1.20.1`（devDependency、纯 JS/wasm 非 native、`env.wasm.numThreads=1` + `proxy=false` 单线程主线程跑、`wasmPaths='ocr/'` 同源加载、动态 import 切按需 chunk，首屏不载 wasm）；`paddleocr.js`（MIT）vendoring 到 `renderer/src/utils/paddleocr/` 做 det(DB) / rec(CTC) 前后处理，自带 resize / threshold / dilate / contours，不依赖 OpenCV。模型入库 `build/ocr/`（PP-OCRv6_tiny det 1.7MB + rec 4.3MB + 字典 ≈6MB，git 跟踪供 CI），`prepare-ocr-assets.mjs` 复制模型 + `ort-wasm-simd-threaded.{wasm,mjs}` 到 `public/ocr/`，并清理旧 `core/lang/worker.min.js`；vite 插件 `pantry-drop-bundled-ort-wasm` 删除 onnxruntime bundle 版 `new URL` 重复 emit 的 ~11MB 冗余 wasm。`ocr.ts` 仅替换内部引擎与图像预处理（canvas `getImageData` 取 RGBA 喂 PaddleOcrService），对外 `recognizeImageText` / `OcrResult` 与 `img:ocr-*` IPC、`ImageViewer` 零改动（仍只用整段文字）；移除 `tesseract.js` / `@tesseract.js-data/*` 依赖。`public/ocr` 体积 58MB → 18MB，识别速度与中文准确率显著提升。纯本地不联网、安全基线（CSP `wasm-unsafe-eval`、`worker-src 'self'`）不变。
- 2026-06-26 v0.80 决议 #166：设计局域网 P2P 自更新（分三步，本轮交付第一步·发现与提示）。新增 `services/updater.ts`（运行形态自检 / 同平台 semver 比对择源 / 请求拉包 / SHA-256 + 版本核对 / 触发安装重启）与 `util/self-package`（Linux deb 运行态 `dpkg-deb` 自重打包、Windows 定位安装时自留的 nsis 安装器）、`util/apply-update`（替换自身 + 接力重启：nsis per-user 静默装、deb pkexec 授权装）；复用 `net/transfer`（拉包 + SHA-256）与 discovery 已携带的 `caps/ver/platform`；`profile.ver` 投影到 `PeerView` 供 UI 比对提示。第一步仅做发现与提示（caps 能力位 `upd1` / 形态自检 / `ver` 投影 / 版本比对择源 / 主界面「内网有新版」提示），不含拉包与安装。安全见 §9 风险表新增行；纯内网零外网、不违反红线 #5，mac 暂缓。详见 §12 v0.27 里程碑、protocol §3/§5/§8.1、requirements F-SYS-5 / 决议 #166。
- 2026-06-27 v0.81 决议 #169：自更新拉包入口接入文件传输通道：`file-ctl offer` 的 `purpose:"update"` 进入 shared 类型与 codec 白名单，要求单文件、非群聊、正大小；`FilesService` 收到后不建聊天消息 / 不 bump 会话 / 不加未读 / 不进普通传输记录，登记隐藏 transfer 并自动 accept 到 `userData/data/updates` 临时目录。该步只解决“更新包如何安全进入本机临时落点”，包格式 / 版本核对与安装重启仍留后续。
- 2026-06-27 v0.82 决议 #170：自更新拉包请求闭环推进：`update{op:"req"}` 纳入 Messenger 可靠控制报文集合（UDP ACK / TCP 控制帧），新增 `update:request` IPC，主界面弹层与设置-关于检测区发现新版后可发起索包；`services/updater.ts` 补请求方复核与本地安装包查找，主进程仅在本地已有匹配本机版本的 nsis/deb 包时声明 `upd1` 并响应请求；`FilesService.offerUpdatePackage` 以隐藏 `purpose:"update"` transfer 发包，不建聊天消息也不进普通传输列表。nsis 自留包、deb 自重打包、包内版本核对、安装重启与失败重试 UI 仍留后续。
- 2026-06-28 v0.84 决议 #174：私聊文件直接发送实现。新增 caps `fd1` 与 `file-ctl {op:"direct"}`；新增 `file:direct` IPC，由发送方已有文件卡片触发，只允许单聊在线且对端支持时使用。接收侧以 `config.allowDirectFileSend` 控制是否自动 accept，缺省 true；自动保存目录为 `getSaveDir()/sanitizeFileName(发送人显示名)`，显示名优先本地备注、其次昵称。群聊 direct 控制帧在服务层忽略，群文件仍手动接收。版本 0.27.8 → 0.28.0。
- 2026-06-28 v0.85 决议 #175：修复拖拽 / 粘贴文件路径没有选择器授权导致发送失败。新增 `file:grant-paths` IPC，`ChatPane` 在 drop / paste 读取 Electron `File.path` 后先向主进程登记一次性授权，再调用既有文件或图片发送 IPC；`file:offer`、`group-file:offer` 与 `img:offer-path` 继续要求消耗授权。版本 0.28.0 → 0.28.1。
- 2026-06-28 v0.86 决议 #176：文件卡片直接发送 UI 收紧。`FileCard` 将发送等待态并入 meta 行，双动作时右侧改为「直接发送」主按钮 + `x` 取消图标同排；接收方直接发送完成态从「已保存到 发送人 文件夹」改为「已保存本地」。纯渲染层 UI / 文案微调，不改传输协议、IPC、保存目录或服务层状态机。版本 0.28.1 → 0.28.2。
- 2026-06-28 v0.87 决议 #177：继续收紧文件卡片短状态文案。`FileCard` 将「等待接收 / 发送中」移到文件名同行固定状态片，meta 回到大小等短信息；发送方 `done` 状态统一显示「发送成功」。纯渲染层 UI / 文案微调，不改传输协议、IPC、保存目录或服务层状态机。版本 0.28.2 → 0.28.3。
- 2026-06-28 v0.88 决议 #178：普通入站文件接收态 UI 收紧。`FileCard` 的 `showRecvActions` 从纵向三按钮改为一行动作组：主按钮接收、文件夹图标另存、`x` 图标拒绝；仅改渲染层模板和 CSS，不改 accept / decline IPC 调用。版本 0.28.3 → 0.28.4。
- 2026-06-28 v0.89 决议 #179：默认文件接收目录统一。`FilesService.accept()` 未传另存目录时使用 `getSaveDir()/联系人名称`，手动接收与直接发送自动接收共享该逻辑；`saveDirOverride` 另存为直接使用用户选择目录；失败重试优先沿用已记录 `savedPath` 的目录。版本 0.28.4 → 0.28.5。
- 2026-06-28 v0.90 决议 #180：修复第三方截图工具粘贴重复发送。移除 `ChatPane.onKeydown` 的立即图片剪贴板兜底，改由主进程 `clipboard:paste-image` 事件延迟触发；浏览器 paste 事件处理过文件 / 文本 / 图片时记录并取消该次兜底。版本 0.28.5 → 0.28.6。
- 2026-06-28 v0.91 决议 #181：Debian 10 / UOS 20 arm64 进入发布矩阵。`package.json` Linux deb/AppImage target 增加 arm64，新增 `dist:linux:arm64`；Release workflow 新增 Debian 10 arm64 容器 job，执行五连验证、源码重建 better-sqlite3、GLIBC_2.28 校验、deb 无硬链接/无中文路径校验，并上传 arm64 deb/AppImage 与 SHA-256 清单。自更新安装包查找增加架构匹配，`update req` 携带可选 `arch`，避免 x64/arm64 deb 混用。版本 0.28.6 → 0.29.0。
- 2026-06-28 v0.92 决议 #182：arm64 发布 job 的容器内长脚本独立为 `scripts/ci-linux-arm64.sh`，workflow 改为调用脚本并打印 `release/` 文件列表，修复 v0.29.0 首次发布时上传阶段找不到 arm64 产物的问题。版本 0.29.0 → 0.29.1。
- 2026-06-28 v0.93 决议 #183：Linux arm64 发布 job 取消 QEMU，改用 GitHub 远程 `ubuntu-22.04-arm` runner + `node:18-buster` Debian 10 arm64 容器直接执行验证与打包。版本 0.29.1 → 0.29.2。
- 2026-06-28 v0.94 决议 #184：修复远程 arm runner 上 deb/AppImage 打包拉取 x86 工具与误触发 x64 target。Linux dist 脚本改为显式 `deb/AppImage` 架构目标，arm64 CI 安装系统 fpm / mksquashfs 并设置 `USE_SYSTEM_FPM=true` / `USE_SYSTEM_MKSQUASHFS=true`。版本 0.29.2 → 0.29.3。
- 2026-06-28 v0.95 决议 #185：首次修复 Debian 10 arm64 容器内 Ruby 2.5 安装 fpm 时解析到不兼容新版 ffi 的问题。arm64 CI 先安装 `ffi 1.17.4`，再安装 `fpm 1.9.3`；后续发布日志确认该 ffi 版本仍要求 Ruby 3+，由 #186 继续修正。版本 0.29.3 → 0.29.4。
- 2026-06-28 v0.96 决议 #186：修复 `ffi 1.17.4` 仍不兼容 Debian 10 Ruby 2.5 的问题。arm64 CI 补 `libffi-dev`，改为安装 `ffi 1.15.5` 后再安装 `fpm 1.9.3`。版本 0.29.4 → 0.29.5。
