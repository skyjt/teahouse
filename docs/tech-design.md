# 茶话间（Teahouse）技术设计文档

> [简体中文](tech-design.md) · [English](en/tech-design.md)

| |                                                                                                                                                                                                              |
|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 状态 | v1.68；群元数据跨版本补齐修复（决议 #292）；v0.54.2                                                                                                                                                    |
| 日期 | 2026-09-05                                                                                                                                                                                                   |
| 关系 | 上游：[requirements.md](requirements.md)（功能）、[protocol.md](protocol.md)（协议）、[ui-design.md](ui-design.md)（界面）；硬约束：根 README「开发红线」（Electron 22.3.27 / Chrome 108 / Node 16.17 焊死） |

## 1. 选型决策总表

| 项 | 决策 | 理由（一句话） |
|---|---|---|
| 语言 | **TypeScript**（main / preload / renderer / shared 全量） | 协议报文、IPC 契约、库表全靠类型撑住多人/长期维护 |
| 构建 | **electron-vite**（Vite 5） | 一份配置管三端产物；renderer 目标 `chrome108`、main/preload 目标 `node16`，红线在构建层强制 |
| 渲染框架 | **Vue 3 + Pinia** | 组件模型贴合三栏布局；生态对中文社区友好；Chrome 108 完全兼容 |
| 样式 | **原生 CSS + CSS 变量为主，Naive UI 2.43.2 混合接入**（决议 #215/#216）；Vue SFC scoped，不引 Tailwind | 标准表单、搜索与主要按钮复用成熟交互，核心 IM 视觉继续自绘并由语义 token 统一约束 |
| 图标与品牌 | **项目内自绘线性 SVG + 茶杯气泡 logo** | UI 图标线性 1.6px 风格与 UI 文档一致；品牌 logo 三件套复用同一轮廓；不依赖 emoji/system 字形，也不引入额外图标依赖 |
| 数据库 | **better-sqlite3 锁定 9.6.0**（同步 API + WAL + FTS5） | 主进程单线程同步访问最简单可靠；已对 Electron 22 ABI=110 实测编译+运行通过。`.npmrc` 以 `runtime=electron` 让 native 构建始终面向 Electron 而非开发机 Node（开发机 Node 太新会编不过老版本源码） |
| 图片处理 | **渲染进程 canvas**（缩略图、表情包压缩 WebP） | Chromium 108 原生支持 `toBlob('image/webp')`；**不引 sharp** 等 native 库，避开老 glibc 等编译雷区 |
| 日志 | 自写轻量 logger（分级、按天分文件、保留 7 天、可打包导出） | 几十行的事，不引依赖 |
| 配置 | 自写 `config.json` 原子写（临时文件 + rename） | 同上；electron-store 新版本对 Node16 不友好 |
| 打包 | **electron-builder 24.x** | 兼容 Electron 22；NSIS+portable（Windows x64/ia32）/ deb+AppImage / dmg+zip 一站式 |
| 单测 | **vitest**（跑在开发机 Node，测纯逻辑） | 协议编解码、补发队列、路径清洗、身份映射都是纯函数，最值得测 |
| E2E | Playwright `_electron`（**实测验证**与 Electron 22 的配对版本；不通则退 WebdriverIO） | 三平台冒烟仍以手测清单为主 |
| 开发机要求 | Node ≥ 18（仅工具链；产物运行时是 Electron 内置 Node 16.17，与开发机无关） | Vite 5 要求 |

依赖纪律（呼应 README 红线）：所有依赖**精确锁版本**；新增依赖前先查 `engines` 与是否含 native 模块；native 模块只允许 better-sqlite3 一个。

Naive UI 接入约束（决议 #215）：

- 精确锁 `naive-ui@2.43.2`；2.44.x 的 `engines.node >=20` 与 Node 16 / CI Node 18 基线冲突，禁止升级到该线。
- 仅由 renderer 动态根组件引用。设置页组件进入 `SettingsApp.vue` 动态闭包，主窗口搜索与主要按钮进入 `App.vue` 动态闭包；公共 `main.ts` 不静态 import Naive UI，保持 200 KiB 公共启动门禁。
- `GroupCreator` 与 `ProfileCard` 复用 `App.vue` 已加载的 Provider、Input 与 Button 组件能力；组件内部不新建 Provider。密集成员勾选和已选标签继续使用原生轻量节点，避免扩大高频列表组件实例数（决议 #233）。
- 主题集中由 `renderer/src/ui/naive-theme.ts` 提供，颜色、字体、圆角与高度映射 `tokens.css`；组件内禁止散落另一套品牌色。
- 保持 named imports 与 tree-shaking；不使用 vfonts、xicons、CDN 或远程素材。依赖只参与本地构建，运行时不发起外网请求。

视觉实现约束（决议 #216，#219 修订）：

- 结构材质只使用 CSS 半透明背景、内描边和有色阴影；`backdrop-filter` 只允许用于真正压住内容的浮层（菜单 / popover / 模态遮罩 / toast），并排结构面板一律不加（决议 #219）。主进程沿用 Win7 / Linux 禁硬件加速条件计算 `softwareRendering`，通过 `AppInfo` 下发给各窗口；renderer 在根节点写入性能画像后，浮层改用实色表面、关闭 blur、缩短阴影，图片查看器停用小图自动 OCR，手动识别入口保持（决议 #231）。`prefers-reduced-transparency` 为 Chrome 118+ 特性，108 基线上不生效，相关降级仅作浮层的前向增强，不作为可访问性承诺。
- 可点击控件在 `:active` 阶段提供 0.97-0.98 缩放反馈；状态过渡只使用 `transform` / `opacity` / color，`prefers-reduced-motion` 下移除位移和缩放。
- token 增加 `material-*`、`surface-hover`、`surface-selected` 与 shadow 语义，浅色 / 深色同时定义；组件不得直接复制另一套灰阶。
- 主窗口、设置窗口仍是独立动态根，Provider 随各自根加载。不得把 Naive UI 放进 renderer 公共启动闭包。
- 主窗口 Provider 使用 Naive UI `abstract` 模式，避免额外 DOM 根节点打断 `.shell` 的百分比高度包含块。若后续取消 `abstract`，新增根节点必须显式保持完整高度链。任何根级 Provider / Portal 改动都要在真实 Electron 窗口验证默认尺寸、最小尺寸和最大化 / 还原。
- 设置页二选一偏好（决议 #223）统一使用 `SettingsApp.vue` 自绘双段滑块，头像样式、主题与发送键共享相同 DOM / CSS 契约；选中块只用 `transform` 位移，太阳 / 月亮复用本地 `PantryIcon`，不引入 xicons。Naive UI RadioGroup / RadioButton 不再进入设置动态闭包，其余标准表单控件继续使用 Naive UI。
- 发送键滑块（决议 #224）根据已加载的 `AppInfo.platform` 选择修饰键图标：`darwin` 使用 `key-command`，其他平台使用 `key-control`，并与 `key-enter` 组合。平台信息仅影响展示与 `aria-label`，设置值继续使用 `enter | ctrlEnter`，ChatPane 的 `ctrlKey || metaKey` 判定不变。
- 分发许可（决议 #225/#229）：0.37.0 起项目自身代码与二进制采用 `GPL-3.0-only`，根目录 `LICENSE` 为唯一许可正文；electron-builder 只在全局 `build.extraResources` 声明一次该文件，配置继承后随 Windows、Linux、macOS 应用资源目录分发。平台专属 `extraResources` 不重复声明同一目标路径，避免 macOS 合并配置时复制冲突。0.36.8 及更早版本的 MIT 授权继续有效，第三方代码与图形资源继续遵循 `THIRD_PARTY_NOTICES.md` 中各自的许可证。
- 品牌位图管线（决议 #226/#231）：`build/icons/pantry-logo-icon-master.png` 是彩色品牌唯一母版，固定 1024×1024 RGBA；`gen-app-icons.mjs` 不再渲染彩色 SVG，直接校验母版尺寸 / alpha 后生成 `pantry-logo-icon.png`、ICO、ICNS，并链式生成 Linux hicolor、独立窗口图标与 renderer 同源 256px PNG。Windows / Linux 托盘从母版生成 32px RGBA，macOS 菜单栏继续从 `pantry-logo-mono.svg` 生成 Template Image。旧彩色 SVG 只保留为历史资料，不进入彩色运行时链路。
- 私聊头部交互（决议 #84/#227）：`ChatPane` 的 `.title-button` 保留完整点击热区与 `focus-visible` 轮廓，用于打开联系人资料浮层；pointer hover / 弹窗激活只修改内部 `.title` 的 `color`，不得给宽按钮增加背景、阴影或 transform 按压反馈。昵称颜色以 150ms 过渡，`prefers-reduced-motion` 下关闭。
- 消息与文件表面（决议 #228/#231）：`MessageRow` 文字气泡不再叠加 `--highlight-edge`，peer 只保留轻外阴影，mine 无阴影；`FileCard.card` 与文字 `.bubble` 均使用四角 14px。文件类型资源固定为 `renderer/assets/file-types/file-type-atlas.png`（512×512 RGBA、4×4 等分单元格），`FileTypeIcon` 只维护扩展名 → 类型 → atlas 坐标映射，并用 CSS background-position 缩放到请求尺寸。单元格 128px 足以覆盖当前 36px 最大显示位的高 DPI 展示，解码内存由 4 MiB 降至 1 MiB。资源随 renderer 本地打包，不经网络、不新增运行时依赖；PNG 头、类型覆盖和源码约束测试锁定该契约。
- 滚动媒体加载（决议 #232/#234）：聊天流 `ImageBubble`、聊天记录搜索结果缩略图与表情包网格保留 `<img loading="lazy" decoding="async">`；聊天图片与搜索图片额外通过共享 `IntersectionObserver` 在视口外沿触发预览解析。静态大图先查 `pantry-thumb://<transferId>` 派生缓存，未命中时受限读取原图字节，并用 `createImageBitmap(blob, { resizeWidth, resizeHeight })` 直接得到最长边 320px 的 bitmap，再编码 WebP 写入缓存；GIF、APNG、动画 WebP 及最长边 ≤320px 的图继续走 `pantry-img`。独立图片查看器、截图桌面位图、品牌首屏图与兼容 emoji 保持原加载策略。
- 图片元数据与缓存边界（决议 #234）：`shared/image-metadata.ts` 以文件头白名单解析 PNG/JPEG/GIF/WebP/BMP 的真实格式、宽高和动画标记，不执行完整像素解码；主进程读取最多 2MiB 头部并按路径 size/mtime 缓存解析结果。内联条件固定为单边 ≤8192px、总像素 ≤3200 万；发送侧不合格内容降级为普通文件，所有 `pantry-img` / OCR / 复制 / 收藏入口复用校验。派生缩略图存入 `userData/data/image-thumbnails/`，文件名由 transferId 的 SHA-256 派生，写入前复核静态 WebP、最长边 ≤320px、字节 ≤1MiB；总量上限 128MiB，读取最多每小时触碰一次 mtime，写入后按 mtime 从旧到新清理。缓存可删除重建、不进 SQLite、不进备份；`pantry-thumb` 每次仍先校验 transfer 与原图授权，避免构造 ID 越权读取。
- 图片选择授权（决议 #235）：`file:pick` 继续只服务普通文件 / 文件夹；`img:pick` 固定使用 `openFile + multiSelections` 和 PNG/JPG/JPEG/GIF/WebP/BMP 对话框过滤器。主进程收到对话框结果后再次通过 `IMAGE_FILE_EXTENSIONS` 白名单过滤，再写入 `PathGrantStore`；renderer 的发送图片按钮只调用 `pickImages -> img:offer-path`，不接入普通文件发送分支。实际文件内容继续由决议 #234 的暂存后元数据门禁复核。
- 文件主动取消终态（决议 #236）：`FilesService.cancel()` 只在本机存在 outgoing 上下文时把对应消息状态写为 `canceled`，接收侧取消不改消息状态；`finish()` 与 `applyMsgStatus()` 均保护本地主动取消，迟到的 offer ACK 失败、群发聚合结果和数据面异步失败无法覆盖。`MessageView.status` / `MsgRow.status` 扩展本地 `canceled` 联合类型，沿用 SQLite 文本列且无需迁移；线上消息与文件控制协议保持不变。renderer 结合 transfer 方向和消息终态区分“发送取消”与“已取消”。
- 建群成员列表（决议 #237）：`GroupCreator` 通过纯 renderer CSS 把姓名与组织路径收敛到同一 flex 行；组织路径由本地 `PeerView.company/dept/team` 组合，空字段跳过，长文本只在 `.meta` 区域省略并保留 `title`。不新增计算缓存、组件库控件、IPC 或数据字段。
- 建群提交稳定性（决议 #269）：`GroupCreator` 不把 Vue `ref` 内的响应式成员数组直接交给 preload；调用 `createGroup` 前复制为普通 `string[]`，满足 Electron 22 IPC 结构化克隆边界。提交状态以 `try/catch/finally` 收口，失败只投影行内错误，不记录组名、密码提示或成员内容；遮罩关闭记录 pointerdown 是否起于遮罩自身，并与最终 `click.self` 共同判定，提交期间所有关闭入口禁用。协议、preload API 与主进程 handler 不扩展。
- 群成员批量邀请（决议 #242）：从 `GroupCreator` 抽取纯 renderer 的共享成员选择组件，统一多字段过滤、紧凑联系人行、跨搜索选择、已选标签与上限门禁；`GroupInviteDialog` 过滤当前群成员并把剩余名额作为可选上限，一次调用既有 `group:update invite`。弹窗通过 Teleport 挂到 `body`，沿用全局遮罩、焦点回收和 Esc 契约；协议、IPC、store 数据形状与数据库均不扩展。
- 自定义头像（决议 #243/#246/#247/#248/#249）：renderer 共享 `AvatarCropDialog` 与纯函数裁剪几何，使用 Chrome 108 Canvas 将本地静态图片生成 192×192、≤32KiB WebP；裁剪拖动使用窗口级 `mousedown/mousemove/mouseup`，并在窗口失焦和卸载时统一结束。裁剪状态直接采用主进程已校验的 `source.width/height`，禁止从非响应式 DOM `naturalWidth/naturalHeight` 推导，避免解码前的 `0×0` 被 computed 缓存成无效裁剪矩形。输出阶段从原始字节创建 `ImageBitmap`，以位图作为 Canvas 绘制源；编码前读取 192×192 像素 Alpha，全部透明时拒绝保存，成功或失败都释放位图。主进程 `AvatarStore` 重新校验格式、尺寸、字节数和 SHA-256，原子写入 `userData/data/avatars`；已通过校验的哈希进入内存缓存，`has/resolvePath` 命中免重复读盘校验，prune 删除文件时同步失效，且 `.tmp` 只清理修改时间超过 1 分钟的陈旧残留、不与原子写入竞态（决议 #248）。资料保存拒绝声明受管缓存中不存在的新头像哈希，避免全网节点空请求循环。元数据只携带哈希，`AvatarService` 通过可靠 `avatar` 报文按需取图、校验、去重与重试；来源无法提供数据时经 `Messenger.sendBestEffort`（一次性 UDP 单发、不重试不等 ACK、不改在线状态）回 `miss`，请求方对群头像立即改试下一个未尝试的在线成员源、对用户头像结束本轮等待（决议 #249）；应用 ready 前把 `pantry-avatar` 登记为标准安全 scheme，`shared/avatar-url` 统一生成 `pantry-avatar://asset/<sha256>` 并严格解析固定短主机名与单段哈希路径，协议处理器只按合法哈希映射受管目录。用户头像以数字头像回退，群头像以现有群组图标回退；无第三方图片处理依赖、无外网请求。
- 设置侧栏与个人信息卡（决议 #238）：`SettingsApp.vue` 侧栏只渲染分组导航，账号摘要 DOM 与专用样式删除，右侧账号资料编辑区保持。`App.vue` 继续以纯 CSS `:hover` 驱动个人信息卡：出现延迟为 120ms；`.avatar-wrap::after` 提供头像至卡片的透明命中桥；显示态卡片恢复 `pointer-events:auto`，因此指针停留在绝对定位的子卡片时祖先 `:hover` 持续成立。隐藏态仍为 `visibility:hidden` 与 `pointer-events:none`。不增加 Vue 响应状态、timer、IPC 或数据读取。
- 设置分组图标（决议 #239）：新增 `SettingsNavIcon.vue` 作为设置动态入口专属叶组件，按既有 `Section` id 映射 7 组 24×24 viewBox 的线性 SVG path，继承 `PantryIcon` 的 `currentColor`、1.6px stroke 与圆角端点契约。专属组件避免设置路径进入多窗口共享 `PantryIcon` chunk；导航按钮改为 flex 横排，图标 18px、间距 9px，hover / active 颜色由按钮祖先继承。无单独图片请求、位图解码、组件实例状态、IPC 或依赖变化。
- 端口编辑保护（决议 #240）：`SettingsApp.vue` 维护 `pendingPortEdit` 与 `unlockedPort` 两个纯 renderer 状态。原生 number input 以 `readonly` 作为默认门禁；focus 时立即 blur 并打开固定定位确认层，确认后在 `nextTick` 中只解除当前字段只读并调用原生 `focus()` / `select()`。输入框 blur 复用既有 `autoSavePorts()` 的 1–65535 校验与 `saveAppSettings`，完成后重新锁定。取消、遮罩和 Esc 只清理待确认状态，不改表单值。确认层沿用本地 `PantryIcon warning` 与已加载的 Naive `NButton`，危险操作使用 `type="error"`，不新增组件库模块、IPC、配置字段或定时器。
- Teleport 浮层、焦点回收、Esc、无标题窗口拖拽带与 Chrome 108 兼容性必须逐批验证；未迁移的自绘组件行为保持不变。
- 转发弹窗层级（决议 #230）：`ForwardDialog` 通过 Vue `Teleport` 挂到 `body`，脱离 `ChatPane.chat` 的 `isolation` / `overflow` 局部层叠上下文；全窗 mask 固定使用全局 overlay 层级，弹窗进入时获得焦点并监听 `Esc`，卸载时移除监听。遮罩不使用 blur，动画只改变 opacity / transform，`prefers-reduced-motion` 下关闭。

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

**设置窗模态层级（决议 #222）**：Windows / Linux 的 `settings-window.ts` 在有可用父窗时设置 `modal:true` 与 `hasShadow:true`；创建后通过 `ui:settings-window-state` 向父窗发送 `true`，关闭时发送 `false`。主窗口 `App.vue` 订阅状态并显示固定定位 scrim，层级高于窗口控制、主内容与普通浮层，使用单一 rgba 背景和短 opacity 过渡，`pointer-events` 拦截所有主窗操作；不使用 `backdrop-filter`、透明 BrowserWindow 或逐帧效果。设置根 `.settings` 用顶层伪元素 inset box-shadow 提供 1px 平台无关边界，弥补 Win7 无 DWM / UOS 弱阴影。macOS 不发送状态事件、不设 modal，继续使用原生阴影与父子窗口关系。窗口重复打开仍维持 true；父窗或 webContents 已销毁时安全跳过事件发送。
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
│  │  ├─ transfer.ts       # TCP server/client、pull 流、SHA-256、限并发、断点位
│  │  └─ compat/           # 内网通 / IPMSG 兼容适配器；独立 UDP/TCP/codec/capabilities，不进入主协议 UdpChannel
│  ├─ store/
│  │  ├─ db.ts             # 打开/迁移（用户版本号 PRAGMA user_version 递增迁移）
│  │  ├─ repo/*.ts         # peers / conversations / messages / groups / transfers / stickers / queue / dedup / share-grants
│  │  └─ fts.ts            # 中文按字预切 + FTS5 查询
│  ├─ services/
│  │  ├─ chat.ts           # 发消息编排：写库→网络→状态回推（核心用例层）
│  │  ├─ contacts.ts       # 通讯录树聚合、探活编排
│  │  ├─ capture.ts        # desktopCapturer 抓屏 → 截图窗 → 裁剪落剪贴板
│  │  ├─ porter.ts         # 导出（HTML/TXT/备份包）与导入（身份映射+去重）
│  │  ├─ settings.ts       # config.json、数据目录迁移、自启（linux 写 autostart desktop 文件）
│  │  ├─ updater.ts        # 局域网自更新编排（决议 #166/#170）：同平台版本比对择源、索包请求复核、本地包查找、后续 SHA-256+版本核对、触发安装重启
│  │  ├─ share.ts          # 共享文件柜编排（决议 #271–#277）：权限判定（默认档 + 按人例外）、目录列举与分页快照、路径校验与 realpath 越界复核、下载 offer 生成、上传落点计算与系统提示
│  │  └─ nwt-compat.ts     # 内网通兼容节点发现、普通文本收发、ACK、附件 offer 与能力投影
│  ├─ ipc/                 # handle 注册（只做参数校验+转发 services）、事件推送
│  └─ util/                # logger / paths / sanitize（文件名清洗）/ atomic-write / upload-measure（文件柜上传体量异步测算）/ self-package（deb 自重打包·nsis 定位自留包）/ apply-update（替换重启）
├─ preload/index.ts        # contextBridge 暴露 window.pantry（按 shared/ipc.ts 类型）
└─ renderer/
   ├─ main.ts              # 公共轻量 bootstrap：解析 hash 后异步加载根组件
   ├─ renderer-entry.ts    # main / settings / capture / image-viewer 动态入口映射
   ├─ App.vue              # 主窗口三栏壳
   ├─ SettingsApp.vue      # 设置窗口根组件
   ├─ CaptureApp.vue       # 截图窗口根组件
   ├─ ImageViewerApp.vue   # 图片查看窗口根组件
   ├─ views/               # ChatView / ContactsView / SettingsView 等业务视图
   ├─ components/          # bubble/* file-card avatar tree search-panel emoji-panel virtual-list
   ├─ stores/              # pinia：peers / convs / messages / transfers / ui / settings / cabinet（文件柜页，决议 #284）
   ├─ ipc.ts               # window.pantry 的薄封装 + 事件订阅分发到 store
   ├─ utils/               # 渲染层纯函数、OCR 适配与 16 项 LRU 结果缓存
   └─ styles/tokens.css    # ui-design §9 的 CSS 变量
```

分层铁律：renderer 永不直接碰网络/磁盘/DB——一切经 IPC；main 的 `services/` 是用例编排层，`net/`、`store/` 互不感知，由 service 串联。

渲染入口性能边界（决议 #210）：四类窗口继续共用单个 `index.html` 和 hash 路由，公共 bootstrap 只静态加载 Vue、Pinia、入口解析与基础 token；各根组件通过动态 import 形成独立 chunk，生产构建使用 esbuild 压缩。Vite manifest 进入构建产物，`scripts/check-renderer-bundles.mjs` 在每次 `npm run build` 后确认四个动态入口均可达且文件互异，并把入口及其静态依赖闭包限制在 200 KiB。OCR 结果缓存使用 16 项 LRU；PaddleOCR 服务初始化 Promise 失败后清空，后续识别可以重新初始化。

截图初始化时序（决议 #218/#221）：截图窗 preload 在页面脚本和动态根组件之前订阅 `capture:init`，以窗口生命周期内存缓存最近一次 PNG `ArrayBuffer`；`CaptureApp` 挂载后通过 `window.pantry.onCaptureInit` 订阅时同步回放，覆盖主进程 `did-finish-load` 已发送、renderer 动态 import 尚未完成的竞态。缓存只存在截图窗口进程内，不落盘、不写日志、不跨窗口共享；PNG 字节通过本地 Blob URL 解码，避免 data URL 的 base64 体积与字符串复制开销。BrowserWindow 加载底色固定为黑色，防止截图根挂载前显示应用全局茶青背景。

截图几何与渲染性能（决议 #221）：`capture-geometry.ts` 以 `display.bounds`、`display.workArea` 与 `desktopCapturer` 返回的实际 `thumbnail.getSize()` 计算窗口边界和物理像素裁剪矩形。Windows 使用工作区边界，兼容底部、顶部、左侧或右侧任务栏及 125% 等 DPI；其他平台保持整屏边界。主进程先裁剪 `NativeImage` 再注入截图窗，截图窗收到 `capture:ready` 前保持隐藏，renderer 完成图片解码与首帧布局后才显示 / 聚焦；`backgroundThrottling=false` 只用于保证隐藏截图窗及时完成该准备阶段。`CaptureApp` 只渲染一份 `<img>` 桌面层，选区高亮通过四块纯色遮罩形成，`mousemove` 以 `requestAnimationFrame` 合并；最终裁剪使用 `naturalWidth / viewportWidth` 与 `naturalHeight / viewportHeight` 两个独立比例，标注坐标同步按 X/Y 映射。该链路不引入透明窗口、实时 backdrop blur 或远程资源，继续适配 Win7 禁硬件加速基线。

截图文字输入（决议 #265）：Electron 22 的 JavaScript dialog manager 不承载 `prompt` 输入，`CaptureApp` 禁止再调用 `window.prompt()`。文字工具在 renderer 内维护单个 `{x,y,value}` 待提交状态，使用截图层 DOM `<input>` 接收系统输入法，`nextTick` 后自动聚焦；编辑器位置由纯函数按视口 8px 边距夹紧，标注锚点仍使用选区相对坐标。输入期间停止事件冒泡，Enter 仅在 `composition` 已结束且 `keyCode !== 229` 时提交，Esc 清除待提交状态；工具切换、发送和复制同步收口非空文字。Canvas 输出设置 `textBaseline='top'` 与 700 字重，对齐 DOM 预览。实现不新增窗口、IPC、依赖或平台分支。

截图工具条图标（决议 #266）：`CaptureApp` 直接复用 renderer 的 `PantryIcon.vue`，新增 `capture-select`、`capture-rect`、`capture-arrow`、`capture-mosaic` 四个线性路径，发送、文字、复制、取消复用既有图形；SVG 通过 `currentColor` 继承按钮状态，保持 Win7 / Chrome 108 可用。按钮正文只包含图标，中文语义由提示和 `aria-label` 承载，工具选中状态使用 `aria-pressed`；CSS 统一 30px 正方形命中区和 hover / active / focus-visible 状态。实现不引入图标依赖、远程资源、IPC 或平台分支。

截图按钮提示（决议 #267）：按钮通过 `data-tooltip` 提供中文提示文案，`::after` 绘制气泡、`::before` 绘制方向箭头，悬停与 `focus-visible` 只切换 opacity / transform / visibility，不触发布局回流。`toolbarTooltipBelow` 根据既有工具条定位结果判断 `top < 48`，通过 `.tooltip-below` 翻转提示方向；移除原生 `title` 以防双层提示，保留 `aria-label` / `aria-pressed`。实现仅使用 Chrome 108 支持的属性选择、伪元素和 transition，不新增 DOM 浮层、依赖、IPC 或平台分支。

远期预留（决议 #21）：将来的本地 AI 开放接口（`local-api/`，HTTP/WS 或 MCP 服务器）将作为与 `ipc/` **并列的第二个"前台"**，复用同一 `services/` 层——界面能做的（查消息、发消息、订阅事件），接口天然也能做，不需要改动业务层。当前版本不实现，但任何人不得把业务逻辑写进 `ipc/` 层（会堵死这个口子）。

## 4. IPC 契约（摘要）

调用（`ipcRenderer.invoke`，全部走 `shared/ipc.ts` 类型）：

| 通道 | 说明 |
|---|---|
| `peers:list` / `peers:probe` / `peers:addManual` / `peers:scan` / `peers:scan-all-ranges` / `peers:set-remark` | 通讯录、探活（F-DISC-8）、手动 IP、单网段扫描、全部已保存网段扫描、本地备注；同步来的网段来源随 `SettingsView.scanRangeItems` 展示 |
| `conv:list` / `conv:pin` / `conv:mute` / `conv:markRead` / `conv:remove` | 会话列表操作 |
| `msg:page(convId, beforeTs, n)` / `msg:send` / `msg:resend` / `msg:recall` / `msg:nudge` / `msg:pk` / `msg:search` | 消息分页（倒序游标）、发送、重发、撤回（文本 / PK / 图片 / 未完成文件统一入口）、私聊窗口震动、PK 分歧解决、当前会话历史搜索 |
| `file:grant-paths` / `file:offer` / `file:direct` / `group-file:offer` / `file:accept` / `file:cancel` / `file:reveal` | 文件传输四件套；`file:grant-paths` 只为拖拽 / 粘贴产生的本地路径登记一次性授权，`file:offer` / `group-file:offer` 仍必须消耗授权；`file:direct` 由发送方文件卡片触发，在已有私聊普通文件 transfer 上发送 `file-ctl {op:"direct"}`；群聊发送为多条点对点 transfer 的发送侧编排且不支持直接发送 |
| `share:my-set-root` / `share:my-set-mode` / `share:my-reveal` / `share:grant-list` / `share:grant-set` | 我的文件柜（决议 #271/#277）：`set-root` 打开目录选择器并落 `config.fileCabinet.root`（拦截主目录根 / 系统盘根 / 应用数据目录及与其相互包含的路径，再复核目录存在可读；传 `clear=true` 表示停止共享），返回 `{ok,canceled,view}` 或 `{ok:false,reason}`；`set-mode` 切换默认档 `off\|read\|write`；`reveal` 在系统文件管理器打开共享根；`grant-list` / `grant-set` 读写按联系人例外（`share_grants`，传 `null` 即恢复跟随默认）。**当前配置不单设读取通道**，随 `settings:get` 的 `SettingsView.fileCabinet` 下发 |
| `share:browse(peerId, path, offset, snapshotId?)` / `share:download(peerId, paths[], saveDirOverride?)` / `share:upload(peerId, localPaths[])` | 对方文件柜（决议 #273/#275）：`browse` 发 `share{op:list}` 并等待 `list-ok` / `deny`，`SHARE_REQ_TIMEOUT` 超时报错，返回 `{perm, entries, offset, total, truncated, snapshotId}`；`download` 发 `share{op:get}` 后由服务层登记一次性授权、自动 accept 随后到达的 `purpose:"share-get"` offer；`upload` 复用 `file:grant-paths` 的路径授权后直接发 `purpose:"share-put"` offer。三者进度与结果全部复用既有 `transfer:*` 事件，不新增传输事件 |
| `ui:open-cabinet` / `share:recent-uploads` | 文件柜（决议 #283/#284）：`ui:open-cabinet` **显示主窗并切到文件柜页签**（可带 `peerId` 直接定位到某位同事，供设置窗「打开文件柜」与私聊面板「在文件柜里打开」使用；主进程经 `cabinet:focus-peer` 事件通知主窗渲染层，不再开独立窗口）；`share:recent-uploads(limit)` 读既有 `transfers` 里 `direction='in' AND status='done' AND purpose='share-put'` 的记录，按次汇总为 `{nodeId,name,avatar,avatarHash,fileCount,totalSize,ts,transferId}`，供「最近有人放进来」渲染，点击复用既有 `file:reveal` 打开落盘目录。**不新增表、不新增列** |
| `img:send-bytes` / `group-img:send-bytes` | 粘贴 / 截图产生的图片 bytes 发送；表格粘贴增强可额外传入受限 `tableText/tableTextTruncated`，服务层仅在对端支持 `tbl1` 时把它写入图片 offer |
| `group:create` / `group:update` | 讨论组 |
| `search:query(q, scope)` | 全局搜索（联系人/组/记录/文件 四分类一次返回） |
| `sticker:addFromMessage` / `sticker:list` / `sticker:remove` / `sticker:reorder` | 表情包 |
| `data:export` / `data:import` | 导出导入；导出可带会话与时间范围 |
| `settings:get` / `settings:save-profile` / `settings:save-app` / `settings:pick-dir` | 设置读取、资料保存、应用设置、文件保存目录选择 |
| `nwt:*`（后续实现时在 `shared/ipc.ts` 固化） | 内网通兼容模式：启停、独立网段扫描、兼容节点列表、普通文本发送、兼容能力投影、实验附件 offer；详见 [nwt-compat-design.md](nwt-compat-design.md) |
| `shot:start` | 触发截图流程 |

事件（main → renderer，`webContents.send`）：`peers:updated`、`msg:new`、`msg:status`（发送中/已送达/排队/失败）、`msg:nudge-received`、`transfer:progress`（节流 ≤4 次/s）、`transfer:done|failed`、`group:updated`、`avatar:ready`、`net:state`（在线/端口冲突/网卡变化）、`net:scan-progress`（主界面全局网段刷新进度，节流推送）、`badge:update`。我的文件柜的根目录 / 默认档 / 例外条数变化**不另设事件**：`SettingsView.fileCabinet` 随既有 `settings:updated` 广播给所有窗口，例外明细由设置页按需 `share:grant-list` 拉取；目录内容一律按需 `share:browse`，从不主动推送。

## 5. 数据库设计（SQLite，WAL）

```sql
peers(node_id TEXT PK, nick, remark, company, dept, team, avatar INT, avatar_hash TEXT, host, platform,
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
      creator_ip TEXT, creator_id TEXT, owner_id TEXT, admin_ids TEXT, avatar_hash TEXT,
      admin_secret_hash TEXT, admin_hint TEXT)
transfers(transfer_id TEXT PK, msg_id, peer_id, direction, files TEXT,
      status, bytes_done INT, total INT, ts INT, expires_at INT)
outgoing_file_manifests(msg_id TEXT PK, files TEXT, expires_at INT)
send_queue(msg_id TEXT PK, peer_id, envelope TEXT, created INT, attempts INT)
dedup(msg_id TEXT PK, recv_ts INT)
stickers(id TEXT PK, path, w INT, h INT, animated INT, sort INT, added INT)
share_grants(node_id TEXT PK, mode TEXT, updated_ts INT)   -- v14：共享文件柜按联系人例外，mode: 'off'|'read'|'write'
```

- 索引：`messages(conv_id, ts, seq)`、`messages(seq)`、`messages(conv_id, seq)`、`peers(last_seen)`、`send_queue(peer_id)`、`transfers(status)`、`transfers(expires_at, status)`。v10 追加两个 `seq` 索引（决议 #200 / OPT-5），用于全局 `MAX(seq)` 取号、会话内按 `seq` 分页 / 上下文窗口和会话预览，避免历史量增大后退化为全表或全会话扫描。v13 为普通文件 transfer 增加 `expires_at`，并用 `outgoing_file_manifests` 按消息保存一份源文件清单，避免群发时为每个成员重复持久化大目录 manifest。
- `remark` 为本地备注名（决议 #22/#37）：仅本机、不入协议；显示与搜索优先命中备注。通讯录资料卡与私聊头部资料弹窗都复用 `peers:set-remark` 写入 peers 表，主进程随后推送 `peers:updated` 刷新会话、通讯录与搜索显示名。
- `groups.creator_ip/creator_id/admin_secret_hash/admin_hint` 保留既有创建者与管理密码兼容语义；v11 新增 `owner_id/admin_ids`（决议 #241），分别保存当前群主与管理员 nodeId JSON。读取旧行时以仍在群内的 `creator_id`、`updated_by`、首位成员依次推导群主，管理员为空；保存前过滤非成员、重复管理员和群主。密码明文仍不入库。
- 群变更系统提示由 `GroupsService` 比较更新前后元数据生成，覆盖改名、邀请、踢人、自行退群、任免管理员、群主自动转让、群简介与群公告修改；消息 ID 使用 `group:<groupId>:event:<rev>`，重复 `info` 不重复入库。首次收到 rev>1 且自己在成员中的群元数据时生成“某人邀请你加入群聊”。发送人显示名优先本地备注，其次 registry 昵称。
- PK 消息（决议 #139）不新增 SQLite 表或列：`messages.kind='pk'`，`content` 写入不透结果的安全摘要（如「[PK] 骰子」「[PK] 猜拳」），用于会话预览、搜索、FTS 与通知；`file_ref` 复用为 `PkRef` JSON（`{game,result}`），用于气泡最终结果、导出 HTML/TXT 与失败重试复用同一结果，由 `kind` 区分其 JSON 形状。
- 媒体撤回（决议 #188）不新增 SQLite 表或列：图片 / 文件仍分别写 `messages.kind='image'|'file'`，`file_ref` 保留 transfer 引用；变化是发送端先生成 `msgId` 并写入 `file-ctl offer.msgId`，接收端用同一 `msgId` 入库。`messages.status='recalled'` 和既有 FTS 清理逻辑继续表达撤回；文件是否可撤回由关联 `transfers.status` 与 `file_ref.transferIds[]` 计算，不把“已接收完成”另存成新列。
- 表格图片消息（决议 #190）同样不新增 SQLite 表或列：仍写 `messages.kind='image'`，`content='[图片]'`，在 `file_ref` JSON 中可选保存 `tableText`（原始 TSV，最多 4096B UTF-8）与 `tableTextTruncated`（发送端截断时为 true）。这些字段不写 FTS、不参与会话预览；导出 HTML/TXT 时可在图片后附“表格文本”。旧记录没有该字段时按普通图片处理。
- 普通文件领取期限（决议 #263）由 `transfers.expires_at` 持久化，私聊和群聊同为发送时刻 +24 小时；图片、表情和更新传输写 0。出站源文件的 `{fileId,absPath,size}` 清单只写本机 `outgoing_file_manifests`，不进入聊天消息、协议日志或迁移备份；同一群消息的多条点对点 transfer 共用 `msg_id` 对应的一份 manifest。入站 transfer 的受检相对路径计划保存在既有 `files` JSON 里，使期限内重启仍可恢复断点上下文。启动时恢复未过期记录、清理孤立 manifest；逾期或旧记录缺少恢复上下文时安全收口。领取期限只允许到期前开始/恢复，已经建立的当前 TCP 拉取可完成；该尝试失败或重启中断时再按截止时间决定 `failed` 或 `expired`。
- 共享文件柜（决议 #271–#277）的**按联系人例外**存 v14 新表 `share_grants`，主键为对端 nodeId，`mode` 取 `off|read|write`，只保存与默认档不同的例外行（改回"跟随默认"即删行）。选它而不是塞进 `config.json`：例外与 `peers` 同域，设置页要按显示名 / 在线状态渲染表格，直接 `LEFT JOIN peers` 即可；config 每次全量原子写，不适合承载条数不定的记录。**共享根路径与默认档不进 SQLite**，见 §6 的 `config.fileCabinet`。文件柜的上传下载**复用 `transfers` 表**，只在既有 `files` JSON 里带上 `purpose:'share-get'|'share-put'` 供传输记录区分来源，**不新增列**；这类 transfer 的 `msg_id` 为空、`expires_at` 写 0（不套决议 #263 的领取期限）。"有人上传到我的文件柜"的提示复用 `messages(kind='system')` 写入该联系人的单聊会话，不进 FTS、不新增表。目录列表快照只在 `ShareService` 内存里按 `SHARE_SNAPSHOT_TTL` 存活，**不落库**。
- 内网通兼容联系人（决议 #194/#195）不得直接混入主协议 `peers` 语义。首版可仅在内存维护 `CompatPeer`；若需要跨重启保留最近发现节点，新增独立 `compat_peers` 表，键为 `compat_id = ipmsg:<host>:<port>:<user>:<hostName>`，只保存昵称、主机名、IP、端口、编码、兼容能力、在线时间与来源，不参与主协议 `node_id`、profileRev、caps、gossip 或补发队列。实验附件 offer 使用独立 `compat_file_offers`，不得复用茶话间 `transfers` 的自动接收、直接发送、媒体撤回和自更新语义。
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
└─ config.json               # 设置（原子写）；含 manualPeers / scanRanges / scanRangeSources / ignoredScanRanges / allowDirectFileSend / fileCabinet / nwtCompat
```

整体数据目录迁移流程（v1.0 打磨项）：校验目标可写 → 关闭 db → 复制（带进度）→ 校验文件数/大小 → 写新路径入旧位置的 `redirect.json` 与全局配置 → 重开 db；失败自动回滚。

扫描范围自动分享（决议 #114）属于设置同步，不入 SQLite：`config.scanRanges` 保留旧字符串数组；`scanRangeSources` 记录 `self/remote`、来源 nodeId/显示名、添加时间与上次自动扫描时间；`ignoredScanRanges` 记录用户主动移除过的 CIDR，远端再次分享时不自动加回。`RangeSync` 只收发 `scan-ranges` 配置候选；主进程收到新 CIDR 后按 30–90 分钟抖动、12 小时去重、在线规模 hash 抽样调度 `Discovery.scanHosts()`，手动扫描仍走即时路径。

主界面全局网段刷新（决议 #115 / #197）仍属于显式手动扫描：`peers:scan-all-ranges` 在主进程读取当前 `config.scanRanges`，归一化合法 CIDR 后展开并按 IP 去重，再以 8ms 间隔逐个调用 `Discovery.probe()`；进度通过 `net:scan-progress` 推给主窗口，含 `done/total/rangeCount/status`。该扫描不改配置、不入 SQLite、不新增线上协议；运行中重复调用只返回当前进度，避免并发扫描。**二次确认（决议 #197）纯在主窗口渲染层（`App.vue`）完成**：点击刷新按钮 → 弹出确认对话框并展示当前 `SettingsView.scanRangeItems`（或回退 `scanRanges`）列表摘要 → 用户点「开始扫描」后才调用既有 `window.pantry.scanAllRanges()`；取消 / 遮罩 / Esc 不发 IPC。不新增 IPC 通道、不改主进程扫描状态机；设置页单网段 `peers:scan` 仍直调、无确认。

共享文件柜配置（决议 #271/#276/#277）存放在 `config.fileCabinet`，缺省视为 `{ root: '', mode: 'off' }`——**默认不共享，升级上来的老配置不会凭空开放任何目录**。`root` 是用户自选的本机绝对路径，只在本机使用、绝不进入协议或日志；写入前由 `settings.ts` 校验：目录存在且可读、不是用户主目录根 / 系统盘根 / 应用 `dataRoot` 及其子目录，命中即拒绝并回具体原因。`mode` 取 `off|read|write`，是**默认档**，按联系人的例外在 SQLite（见 §5 `share_grants`）。共享根不纳入数据目录迁移、不进导出备份包（它是用户自己的普通目录，不属于应用数据）。文件柜下载的默认落点为 `getSaveDir()/文件柜-<对方显示名>/`，与决议 #179 的联系人子目录同级但前缀区分，便于和聊天里收到的文件分开；上传的落点由接收方计算为 `root/<上传者显示名>/`，两处显示名都走 `sanitizeFileName`（本地备注优先、其次昵称）。

内网通兼容配置（决议 #194/#195）独立存放在 `config.nwtCompat`，默认关闭：`enabled`、`port`（默认 2425）、`ranges`、`manualPeers`、`scanOnStartup`、`experimentalFile`。兼容扫描只读取这些独立 IP 段，不自动复用茶话间 `scanRanges`，也不参与 `scan-ranges` 同步；服务启动时若 `2425/UDP` 被占用，兼容模式进入不可用状态并在设置页提示，不影响主协议 17878/17879 端口与普通聊天。`experimentalFile` 默认关闭，只有完成内网通 TCP `GETFILEDATA` 闭环后才允许暴露给 UI。

媒体撤回（决议 #188）属于 ChatService 与 FilesService 的编排增强，不把规则塞进 IPC 或 `net/` / `store/`：发送图片、普通文件、群文件时，`FilesService` 在创建本地消息前先取得发送端 `msgId`，随后把该 ID 写入每条 `file-ctl offer.msgId`；接收侧收到带 `msgId` 的 offer 后用同一 ID 写 `messages`，并将 `transfer.msg_id` 指向该消息。`ChatService.recall()` 继续是唯一用户撤回入口，先按窗口、发送者、会话和消息类型判断；命中媒体时经 `mediaRecall` 适配器调用 `FilesService.canRecallMessage(msgId)`，由文件服务同时确认对端 `mrec1` 能力、文件 transfer 未完成，以及群文件所有相关 transfer 均未 `done`。真正发出 recall 后，本地先置 `recalled` 并插系统提示；远端收到 recall 后由 `ChatService.applyRecall()` 识别媒体消息，图片直接隐藏，文件则调用 `FilesService.applyRecallMessage(msgId)` 取消未完成 TCP 拉取、清理 `.part`，若 transfer 已 `done` 则忽略迟到撤回并保留已保存文件。群文件复用 `file_ref.transferIds[]` 聚合判断：任一 transfer `done` 即不可撤回；全部未完成才允许整条消息撤回。`msg(kind:"recall")` 早于 offer 到达时继续使用现有 pending recall 机制，offer 之后再按媒体规则应用。旧端没有 `mrec1` 或没有 `offer.msgId` 时仍按旧文件 / 图片流程入库，新端 UI 不展示媒体撤回入口。

私聊文件直接发送（决议 #174）属于本机配置 + 现有传输状态机增强，不新增 SQLite 表或迁移：`config.allowDirectFileSend` 为接收侧总开关，老配置缺省视为 `true`。发送端先走普通 `file:offer`，文件卡片出现后，若该 transfer 为私聊普通文件、对端在线且 `profile.caps` 含 `fd1`，发送方卡片显示「直接发送」按钮；点击后 `file:direct` 调用服务层 `requestDirect(transferId)`，通过 `file-ctl {op:"direct", transferId}` 请求接收端自动 accept。接收端仅在该 transfer 是入站私聊普通文件、状态仍为 `offering` 且本机开关允许时调用 `accept(transferId)`；否则保持普通 `offering` 文件卡片。群聊文件收到 direct 控制帧必须忽略；群文件仍按在线成员逐个普通 offer，收端手动接收。

默认文件接收目录（决议 #179）由服务层统一生成：`accept(transferId)` 未传 `saveDirOverride` 时，以 `getSaveDir()/sanitizeFileName(displayName)` 作为基础目录，displayName 优先本地备注、其次 peer 昵称；私聊直接发送自动接收与普通手动「接收」都走这条逻辑。`file:accept(transferId, true)` 另存为会先由主进程目录选择器得到 `saveDirOverride`，服务层直接使用用户选择目录，不再额外套联系人子目录。若 transfer 是失败重试且 `files.savedPath` 已存在，优先沿用 `dirname(savedPath)`，避免同一传输重试时改变落点。目录不存在时由拉取写盘流程递归创建；重名仍由根级 dedupe 处理，不覆盖既有文件。群聊文件虽然不支持直接发送，但手动接收同样按发送人显示名进入联系人子目录。

## 7. 渲染进程要点

- **虚拟滚动**：消息列表（倒序无限滚动、按 50 条分页拉取）与通讯录扁平化树（1000 节点）两处必须虚拟化；优先自写轻量实现，复杂度超预期则退 `@vueuse/core useVirtualList`（纯逻辑库，无 DOM 依赖风险）。
- **系统图标与 emoji 兼容渲染**：导航、工具栏、文件卡、状态位统一走 `PantryIcon` 自绘 SVG，图标继承文字色。头像模板走 `AvatarMark` / `AvatarGlyph`，按原 `avatar:number` 下标加载 Twemoji 本地 SVG 动物图标；emoji 面板、聊天输入框镜像层与消息正文对内置 emoji 子集走 `CompatEmoji` 加载 `src/renderer/src/assets/twemoji/*.svg`。发送、复制、存储仍是原 UTF-8 字符。输入框仍以原生 textarea 承担键盘、选区、粘贴与提交，只在草稿包含内置 emoji 时用透明文字 + 镜像层显示 SVG，避免 contenteditable 引入编辑风险。`splitEmojiText` 按 emoji 首 UTF-16 单元建候选表，文本扫描时只检查可能命中的内置 emoji，避免长消息按字符重复遍历完整表（决议 #131）。粘贴分流先处理真实文件路径；若剪贴板有 `text/plain`，不拦截原生文本粘贴，避免富文本 emoji 同时携带的图片副本误走截图发送（决议 #135）。该路径不引入远程图片、字体、CDN 或新依赖，解决 Win7 / UOS 系统 emoji 缺字方框问题（决议 #45/#47/#48）。Twemoji 图形按 CC-BY 4.0 在 README、`THIRD_PARTY_NOTICES.md` 和设置 About 页署名。
- **品牌 logo 源文件**（决议 #107）：用户提供的 SVG 套件是品牌唯一源。`build/icons/pantry-logo-icon.svg` 使用 taskbar/dock 版本并生成 `pantry-logo-icon.png` / `.ico` / `.icns`（`scripts/gen-app-icons.mjs`：rsvg-convert 渲染高清主位图 → png2icons 出 `.ico`[BMP，兼容 Win7] / `.icns`，链式重跑 gen-linux-icons）；`pantry-logo-standard.svg`、`pantry-logo-small.svg`、`pantry-logo-menu.svg`、`pantry-logo-mono.svg`、`pantry-mark.svg`、`pantry-horizontal-logo.svg` 保留为可审阅 SVG 源。渲染层 `PantryBrandLogo` 直接加载 `src/renderer/src/assets/brand/*.svg`，不再手写 path。托盘图标由 `scripts/gen-tray-icon.mjs` 从 `pantry-logo-mono.svg` / `pantry-logo-menu.svg` 渲染 32×32 PNG 后内嵌到 `src/main/windows/tray-icon.ts`；同时导出彩色 RGBA 底图，`tray-badge.ts` 在该底图上叠未读角标，保证 Win/Linux 闪烁帧与 SVG 源一致。**Linux 桌面图标**（决议 #58）：`build/icons/linux/` 多尺寸 png（由 `scripts/gen-linux-icons.mjs` 从品牌 png 缩放生成）装入 deb 的 hicolor；desktop 文件带 `StartupWMClass`；主/设置窗在 Linux 显式设置 `BrowserWindow` icon（extraResources 分发 256px png），任务栏图标不依赖桌面环境关联。
- **托盘未读提示**：`ChatService` / `FilesService` 的 `convs` 事件统一汇总未读数后调用 `updateTrayUnread`（决议 #42/#214）。macOS 使用 `Tray.setTitle` + `dock.setBadge` 显示数字；Windows 使用 `BrowserWindow.setOverlayIcon` 叠加 16×16 数字，并让托盘图标在原图与带数字角标图之间闪烁；Linux 调 `app.setBadgeCount` 作为 best effort，同时在常规茶青图标与高对比红色注意图标之间闪烁。Linux 每次切帧重新创建 `NativeImage`，避免 Electron 22 / DDE 复用同一图像对象时可能不重绘；同一托盘的未读数更新只替换注意帧，不重启 800ms 周期，避免高频 `convs` 把闪烁长期压在第一帧。托盘销毁或 `setImage` 失败时停表，未读清零恢复常规图标。动态图标仍由 `tray-badge.ts` 纯 Node PNG 编码生成，不引入图片库或 native 依赖。
- **图片管线（renderer canvas + 主进程剪贴板读写）**：发送图片 → `createImageBitmap` 解码 → 缩略图（≤280px）即时展示；聊天图片收藏或表情面板本地多选导入 → 静图重采样到 ≤512px → `toBlob('image/webp', 0.8)`，GIF 检测文件头 `GIF8`、≤2MB 原样收藏。导入选择器签发表情专用、按窗口隔离的一次性路径授权；每个路径读取时消费授权并再次执行扩展名、真实图片、像素和 25MB 源文件门禁，不复用普通发送授权。聊天图片 / 表情消息右键「复制」复用 `fetchStickerSource(transferId)` 受限读取源文件，渲染层解码后转 `image/png`，经 `clipboard:write-image` IPC 交主进程 `nativeImage` + `clipboard.writeImage` 写系统图片剪贴板并读回校验；输入框粘贴先处理真实文件、文本和浏览器 `ClipboardEvent.items` 图片。表格粘贴识别插在“真实文件路径”之后、“普通 text/plain 原生粘贴”之前，判定口径见决议 #270：`text/html` 侧要求整段片段有且仅有一张 `<table>` 且表外无实质文字（按 `body.textContent` 与 `table.textContent` 去空白后的长度比较），`text/plain` 侧要求 ≥2 行、每行按 `\t` 切出的列数一致、列数 ≥2 且首列非全空；`DOMParser` 不可用时退回纯文本口径。命中后**不发送**，只提取原始 TSV `tableText` 并把原文插入草稿，同时在粘贴事件内同步取走剪贴板现成图片项（`DataTransfer` 出了事件即失效），等用户点提示条的「发送为图片」才发：优先用捕获的图片项，缺失时用本地 DOM/canvas 渲染 sanitized table，不引入依赖、不联网，渲染失败则保留草稿文本、只收起提示条，避免丢内容。主进程 `before-input-event` 的 `clipboard:paste-image` 只负责 Electron 原生图片剪贴板兜底：渲染层收到事件后延迟读取 `clipboard:read-image`，若同一次浏览器 paste 已处理文件 / 文本 / 图片 / 表格，则取消兜底，避免第三方截图工具同时暴露两路图片时重复发送（决议 #137/#138/#180/#190）。产出 Blob 经 IPC（ArrayBuffer）交主进程落盘。
- **表格粘贴提示条（决议 #270）**：`utils/table-paste.ts` 存放纯函数与常量（`TABLE_PASTE_HINT_MS`、提示文案、`tablePasteHintIntact` 判断草稿是否仍是插入后的原样、`draftWithoutTablePaste` 摘掉刚插入的那段），`ChatPane` 只持有 `tablePasteHint` 响应式状态与捕获的图片 bytes（含 `ArrayBuffer`，不进 store、不经 IPC）。提示条随 `watch(draft)` 在草稿被改动时收起，会话切换 watcher 与 `onUnmounted` 一并清理定时器；草稿超 `TEXT_TCP_LIMIT` 时不挂自动消失定时器。
- **表格图片消息视图**：`ImageBubble` 读取 `MessageView.fileRef.tableText` 后在图片内容上沿显示小型分段滑块；组件内仅保存本地 `viewMode:'image'|'text'`，不写 store、不经 IPC。图片视图沿用 `pantry-img://transferId` 与看图器；文字视图用等宽只读块展示 TSV，支持选择复制，内容高度上限内滚动；若 `fileRef.tableTextTruncated` 为 true，在 TSV 块上方显示轻提示但不写入可复制文本。转发图片消息时，若本地源消息带 `tableText` 且目标支持 `tbl1`，新 offer 继续附带该字段与截断标记；否则按普通图片转发。
- **群聊媒体管线**：不新增群组数据面；`FilesService` 为每个在线群成员创建独立 transfer，offer 携带 `groupId/groupRev`，收端写入群会话并按需索要群元数据。群聊图片仅单图 ≤10MB 时携带 `purpose:"image"`；收藏表情携带既有 `purpose:"sticker"` 并自动接收；超过 10MB 的图片自动退化为普通文件 offer，收端显示文件卡片并等待手动接收，避免大群同时拉取造成流量尖峰。发送端消息 `file_ref.transferIds[]` 汇总多个 transfer，文件卡片按完成/失败数量展示整体状态。
- **普通文件期限管线（决议 #263）**：`FilesService` 创建普通私聊/群聊 offer 时生成统一 `expiresAt` 并写入所有分包、transfer 与共享 manifest；接收端用 `expiresAt-envelope.ts` 换算本地剩余窗口，缺字段按本地 24 小时上限。服务层维护单个最近截止定时器，到期批量把尚未开始的 `offering/failed/canceled` 置为 `expired` 并释放供流/断点上下文；`TransferServer` 记录 transfer 是否已有活跃 TCP 连接，保证到期前启动的当前连接可自然完成，断开后若已过期则释放授权。发送端处理迟到 `accept/pull` 时再次校验期限，避免只依赖 UI 定时器。应用启动从 v13 manifest 恢复未到期授权，普通文件源路径仍指向用户原文件，不复制大文件、不恢复发送前整文件预读。
- **文件卡 UI / 状态管线（决议 #174/#176/#177/#178/#179/#188）**：`ChatPane` 的文件 / 文件夹按钮保持普通发送。`FileCard` 在发送方私聊普通文件卡片 `offering` 状态下显示「直接发送」按钮；按钮 enabled 由消息 offer 已送达、peer online、caps `fd1`、非群聊决定。点击后卡片 direct 标记写入 transfer `files` JSON 并推送 transfer 更新；发送侧 `offering` 将「等待接收 / 发送中」作为文件名同行固定状态片，meta 只保留大小 / 文件数 / 速率，右侧只保留一行动作，避免新增直接发送后卡片变高且状态被截断；发送完成统一显示「发送成功」。普通入站文件 `offering` 接收态右侧为一行动作组：`accept` 主按钮、`accept(..., true)` 文件夹图标另存、`decline` 的 `x` 图标拒绝，避免三按钮纵向堆叠撑高卡片；主按钮默认落到 `文件保存位置/联系人名称/`，文件夹图标另存直接落到用户选择目录。接收侧 accepted 显示「接收中」，direct done 只显示「已保存本地」，不展示完整路径或发送人目录名。群聊文件卡永远不显示「直接发送」。媒体撤回入口由 `ChatPane` 结合 `MessageView.fileRef`、`transfersStore` 和 peer caps 投影到右键菜单：图片显示剩余倒计时；文件仅在相关 transfer 未 `done` 时可用，完成后置灰为「已接收」，群文件任一 transfer `done` 则置灰为「部分已接收」。
- **状态流**：pinia store 是 main 数据的**只读投影** + 乐观更新（发消息先插 `sending` 态，`msg:status` 事件校正）；窗口重载（开发期热更）时全量拉取重建。会话打开额外携带渲染层滚动意图（latest / target，`restore` 仅保留为内部显式选项）：会话列表、联系人、通知、托盘、震动直达与回到最新都走 latest，强制重载最新 50 条并贴到底部，不复用历史搜索上下文窗口或旧 scrollTop；历史搜索跳转走 target 交给高亮消息居中。当前会话新增消息仅在用户本来贴近底部或自己发送时跟随到底，避免阅读历史时被打断（决议 #111/#133/#192）。渲染层 `chatStore` 对已加载会话额外维护内存级 `MessageCache`（`Set<msgId>` + `Map<msgId, MessageView>`），用于追加去重、状态事件 O(1) 定位、历史页去重和删除会话后的缓存清理；文件 / 图片 / 表情发送完成后按返回的 `MessageView.convId` 回填，避免发送期间切换会话造成列表错位（决议 #130）。联系人在线计数、单聊 peer 查找、群在线收件人数、群添加成员候选和群发文件卡片传输统计均避免重复数组遍历或临时数组分配，联系人 / 群成员规模上升时仍保持按既有状态投影单次计算（决议 #131）。该状态只在 renderer 内存中存在，不写库、不经 IPC。
- **PK 渲染状态**：`MessageView.kind` 增加 `pk`，并携带 `pkRef`。`ChatPane` 对他人的 PK 消息始终渲染气泡外侧参与按钮：猜拳为「我也来」，骰子为「掷一下」；自己的 PK 消息不显示按钮。按钮可反复点击，每次都走 `msg:pk` 发送新的独立消息，不建参与状态表、不按回合聚合。按钮 enabled 由当前在线状态决定：单聊对方在线才可点；群聊至少一位其他成员在线才可点，否则灰显并提示「PK 只能和在线的人玩」。动画播放状态只存在组件内存中：新发 / 新收消息播放一次约 1.5s，分页历史直接显示最终结果，`prefers-reduced-motion` 直接跳到结果。骰子用 CSS/SVG 自绘真实点数组合；猜拳使用本地 Twemoji 原色手势资源（缺资源时补 SVG 并同步署名）。工具栏 PK 入口、玩法浮层和参与按钮均复用现有 `PantryIcon` / CSS token，不新增依赖；动效只用 transform / opacity。不引入 GIF、第三方动画库、远程图片或远程字体。
- **输入提示层级**：渲染层所有 `input/textarea::placeholder` 统一读取 `--text-placeholder`（决议 #38），该 token 低于 `--text-3`，用于占位 hint；真实输入、标签、错误仍使用既有文字 token，避免把提示当内容。
- **联系人详情交互**：`PeerList` 向主壳分别发出 `select` 与 `chat` 事件（决议 #40/#233）。单击只更新右侧 `ProfileCard` 投影；双击复用主壳 `chatWith -> chatStore.openPeer`，沿用既有会话打开与探活流程，不新增 IPC 或协议。资料页本地备注使用主题化 Input，保存备注与发消息使用常规 Button，字段长度、回车保存、状态提示和业务调用保持。
- **左侧导航悬停层（决议 #116/#117/#118/#119/#121/#238）**：主壳 `App.vue` 内维护 `activeRailHint` 与延迟 timer，不经 IPC。按钮 tooltip 只用一个 `::after` 圆角标签，取消独立箭头 `::before` 和位移动画；显示态由 `pointermove` 后计时触发，不再使用 CSS `:hover` / `:focus-visible`，避免默认焦点和窗口打开在静止鼠标下方时误弹。启动后若原生焦点落在 rail 按钮则主动 blur，点击 rail 按钮后也释放焦点，避免系统黄色焦点框残留。自己信息卡仅使用鼠标 `:hover`，头像、透明桥接区与作为绝对定位子元素的卡片共同维持祖先悬停态，不使用 `focus-within`；120ms 出现等待用于过滤快速掠过。可见文本来自本地 `SettingsView` / `AppInfo` 投影。原生 `title` 改为 `aria-label`，既避免系统 tooltip 抢占，又保留辅助语义。
- **通知与 Release 验证（决议 #108/#120）**：Linux / Windows 桌面通知显式传本地应用图标，`notificationIconPath` 按目标平台选择 `path.posix` / `path.win32`，避免在 Windows runner 上为 Linux 产物生成反斜杠路径。Release workflow 的平台五连验证必须命令失败即阻断后续构建/发布；Windows PowerShell 步骤逐条检查外部命令退出码，macOS/Linux 显式使用 shell 失败即退出策略。
- token 全部走 `styles/tokens.css` CSS 变量（深色主题 v0.4 只换变量表）。
- 性能预算（NFR 对照）：通讯录树重聚合 ≤16ms（1000 节点，主进程聚合好再推）；搜索请求防抖 200ms；`transfer:progress` 节流后 UI 才消费。

## 8. 导出 / 导入

**备份包 `.pantry-bak`**（即 zip）：

```
manifest.json    # {formatVer, exportedBy: nodeId, nick, avatarHash?, range, counts}
messages.jsonl   # 一行一条（流式读写，不怕大）
peers.json / groups.json / stickers.json
media/transfers/... # 消息引用的图片/表情媒体；普通文件不打包（仅保留文件名记录）
media/stickers/...  # 自定义表情包媒体
media/avatars/...   # 本机、联系人或群引用的受管 192×192 WebP 头像
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
| linux arm64 native 模块与 Debian 10 / UOS 20 glibc 基线 | 独立 CI job 使用 GitHub 远程 `ubuntu-22.04-arm` runner 跑 `node:18-buster` Debian 10 arm64 容器，在目标架构内 `npm ci`、源码重建 better-sqlite3、五连验证和打包；arm64 deb 阶段安装系统 fpm 并设置 `USE_SYSTEM_FPM=true`，避免 electron-builder 下载 x86 fpm；Debian 10 Ruby 2.5 下安装 `libffi-dev`，先锁定 `ffi 1.15.5` 再安装 `fpm 1.9.3`，避免 RubyGems 解析到 Ruby 3+ 依赖；AppImage 阶段不强制系统 mksquashfs，因为 Debian 10 老版不支持 `-offset`；产物内 `.node` 同样检查最高 GLIBC 符号不超过 2.28，避免交叉编译或模拟层误用宿主二进制 |
| macOS 26 跑 Chromium 108 | 已知风险项（README FAQ）：输入法、通知权限、屏幕录制授权列入发布冒烟清单 |
| Win7 终端为统一 VM（虚拟显卡弱/驱动旧）；UOS/Debian 多国产 GPU 或旧驱动 | **Win7 与 Linux 默认禁用硬件加速走软渲染**（决议 #55）——VM 虚拟显卡与国产 GPU 驱动是 Electron 花屏/GPU 进程报错的头号惯犯，2D 聊天界面软渲染完全流畅；macOS 默认开启，高级设置留开关 |
| Win7 搜狗输入法候选窗固定在应用左上角 | Chromium 108 在 Win7 恒走 IMM32。#253 的 TSF 开关、#255 的主进程 `show()` 自愈、#256 的 textarea blur/focus、#257 的 `webContents.focus()` 与 #258 的 composition 几何脉冲均经源码复核或 Win7 搜狗真机实测撤销。交叉测试确认同一 WebContents 的全局搜索、独立设置输入和同机 Chrome 正常，故障范围已收敛到聊天自定义多行编辑器。#259 的静态正常流基础 textarea 已在 Win7 搜狗真机验证候选窗定位正常；#261 只恢复 `PantryEmojiBlank` 后候选窗立即再次失位，单变量确认空白 WebFont 参与真实编辑排版是触发项，Win7 永久禁用该字体。#262 将 Win7 聊天输入改为微软雅黑系统字体 contenteditable，表情使用 `contenteditable=false` 的 `1.3em` 本地 Twemoji 原子节点直接参与 DOM 排版，原生 caret 落在节点前后；文本值与 DOM Selection 以 UTF-16 偏移双向映射，composition 期间不重建 DOM。其他平台继续使用 textarea + 空白字体镜像。#257 的 renderer CSS zoom 清理与主进程 `webContents.setZoomFactor()` 保留；Win7 真机需验证候选窗定位、连续 emoji、emoji 后继续中文组词、多行滚动和粘贴 |
| Wayland/国产桌面截图差异 | 启动时由 `XDG_SESSION_TYPE`（缺失时回退 `WAYLAND_DISPLAY`）识别 Wayland，并为 Electron 22 合并启用 `WebRTCPipeWireCapturer`；截图按钮仍实际调用 `desktopCapturer`，不再按会话类型提前返回。抓屏前等待主窗口 `hide` 信号和合成器退场并复核不可见；空源、空图、异常统一恢复窗口并通过应用内提示或系统通知给出系统截图 + `Ctrl+V` 退路 |
| UDP 广播被交换机/AP 隔离 | 协议已有三板斧兜底（手动 IP/扫描/gossip）；FAQ 文档化引导 IT 放行 |
| 内网通兼容模式与主协议混线、`2425/UDP` 被占、GBK 编解码差异、文件 / 图片能力误判 | 兼容模式放在 `net/compat/` 独立 socket、独立 codec、独立配置与联系人投影；默认关闭，用户显式填写 IP 段后才扫描；端口冲突只关闭兼容模式并给设置页状态；GBK 解码使用精确锁纯 JS 依赖，无法识别的字段保留原始安全摘要；文件 / 图片只按 IPMSG 附件实验处理，未完成 TCP 拉取闭环前 UI 不展示普通发送入口；PK、窗口震动、群聊、媒体撤回等主协议能力由 `ConversationCapabilities` 隐藏 |
| 超大文件/超大图片打爆内存 | 文件收发全程流式：首次拉取时发送端边读边写 TCP 并同步计算 SHA-256，接收端 pull 流直写磁盘，内存中永不持有整文件；图片解码限制单图 ≤50MP |
| 畸形 TCP 帧、慢连接或并发拉取耗尽主进程资源 | `frame.ts` 对每种 TCP 帧执行精确字段白名单，解析器首次失败后终止；`TransferServer` 将异常隔离到当前 socket，并用 3 条活跃供流任务、256 条连接、15 秒握手超时、60 秒活跃空闲超时构成资源预算；排队只接纳已经通过 transfer/file 授权的拉取 |
| 未经请求的更新 offer 或超大伪装安装包写入临时目录 | updater 在发请求前登记绑定 nodeId/version/platform/arch 的 120 秒一次性授权；FilesService 在任何隐藏 transfer 入库前校验来源、单文件、路径、精确安装包名与 512 MiB 上限，成功后消费授权；本地找包与入站匹配共用同一命名函数 |
| 异步会话导航旧结果覆盖当前会话 | renderer chat store 为每次显式导航分配递增代次，所有跨 IPC await 的提交前同时校验代次与目标会话；历史搜索跳转、返回最新与普通开会话共用该规则 |
| 渲染层或备份 JSON 借本机绝对路径读取任意文件 | 主进程只接受 `filePick` 产生的按窗口隔离一次性路径授权；图片路径发送前复制进应用图片目录。`pantry-img` / `pantry-sticker` / OCR / 表情提取只读应用管理媒体目录下、状态完成且类型匹配的记录；备份导入无归档媒体时不保留外部 `savedPath` / 表情 `path`，备份导出也只打包应用管理目录下的媒体（决议 #132）。 |
| asar 与 native 模块 | `asarUnpack: ['**/better_sqlite3.node']` |
| 节点时钟漂移打乱消息序 / 显示时间不准 | 排序键 `(ts, seq)`，seq 本地单调兜底（乱序只影响跨机微观顺序，可接受）；**显示时间经 `net/peer-clock.ts`（PeerClock）接收侧矫正**（决议 #65）——复用 `Envelope.ts` 估各节点时钟差，对方消息换算到本机钟、上界钳本机当前，零协议改动 |
| 1000 节点报文洪峰/恶意泛洪 | codec 层每源 IP 令牌桶限速 + 总入站队列上限，超限丢弃并计数 |
| 自更新：从内网节点取可执行包来运行（决议 #166/#181） | 信任内网边界（决议 #5）且**用户确认才装**（非静默）+ SHA-256 完整性（复用传输层 `done` 帧）+ 同平台同架构严格匹配 + 包内版本核对 + 大小上限；纯内网零外网（红线 #5 禁的是外网更新检查 / CDN）。应用更新走平台脚本（nsis per-user 静默装免 UAC、deb 经 pkexec 授权），保留旧包 / 失败回滚；替换正在运行的自身由接力进程在主进程退出后完成；mac 暂缓 |

## 10. 构建与 CI

- electron-builder 要点：`electronVersion: 22.3.27`；win=`nsis`+`portable`（x64 + ia32，决议 #213）；linux=`deb`+`AppImage`（x64 + arm64，决议 #181；Debian 10 / UOS 20 基线）；mac=`dmg`+`zip`（**arm64 / Apple Silicon，决议 #69**；CI `macos-14` 原生打包，未签名/未公证内网自用；Intel x64 / universal 后续专项）；`asar: true` + `asarUnpack: **/better_sqlite3.node`；appId `com.pantry.app`。
- **productName=`Teahouse`，安装路径全 ASCII（决议 #60）**：Linux 装 `/opt/Teahouse`、Windows 默认 `Teahouse` 目录；显示名经 Linux desktop `Name`、NSIS `shortcutName`、mac `extendInfo` 保持「茶话间」；主进程启动最早处 `app.setName('茶话间')` 固定 userData 与通知名（已有用户数据零迁移）。**Linux 打包必须 `USE_HARD_LINKS=false`**（dist:linux 与 CI 均已内置）：electron-builder 复制硬链接优化会让 deb 出现跨 `/usr`↔`/opt` 硬链接条目，UOS 深度安装器解包报"断开的管道"；窗口图标 extraResources 用独立物理文件 `build/icons/window-icon.png`，CI 解 deb data.tar 校验无硬链接条目、无中文路径。
- 品牌资源：`build/icons/` 保存可审阅 SVG 源和生成后的 `.png` / `.ico` / `.icns` 打包图标；托盘运行态不依赖文件路径，仍使用内嵌 Data URL，保证开发、打包与 asar 场景一致。
- GitHub Actions 矩阵：`.github/workflows/release.yml` 中启用 Windows x64 / Windows ia32 / Linux x64 / Linux arm64 / macOS arm64 五条发布线（决议 #69/#86/#181/#182/#183/#184/#185/#186/#187/#213）。两个 Windows job 均使用 `windows-2022`；ia32 job 在五连验证后显式把 better-sqlite3 重建为 x86，并以 PE machine 校验源码目录和最终包内 native 模块，再输出 Win7 SP1+ 32 位 NSIS 与 portable。Linux x64 用 `node:18-buster` / Debian 10 容器强制源码重建 better-sqlite3，electron-builder 关闭二次 `npmRebuild`，并检查最终包内 native 模块最高 GLIBC 符号不超过 `GLIBC_2.28`，输出 deb + AppImage，作为 Debian 10 / UOS 20 x64 产物；Linux arm64 用 GitHub 远程 `ubuntu-22.04-arm` runner 跑 `node:18-buster` Debian 10 arm64 容器执行同样的 npm ci / native 重建 / 五连验证 / GLIBC 校验 / deb 归档校验；macOS 用 `macos-14` 原生 arm64 runner 构建 dmg + zip。push 到 `main` / 手动触发上传 artifact，推送 `v*` tag 时自动创建/更新含 15 个资产的 GitHub Release；目标平台真实桌面冒烟仍按 `docs/packaging-test.md` 执行。
- Release workflow 权限按最小化原则配置（决议 #132）：默认 `contents: read`；构建 job 的 checkout 不持久化 GitHub 凭证；只有发布 GitHub Release 的 job 显式授予 `contents: write`。
- 版本号：`package.json` 单一来源；协议 `profile.ver` 随包版本注入（"内网有新版"提示的依据，见 protocol §3）。**每轮迭代（每个增量 commit）按决议 #73 递增版本号**：功能更新 minor +1 且 patch 归 0，bug 修复 / 微调 patch +1；deb/NSIS 按版本号判断升级，同版本号在 UOS 上会被 dpkg 以"已安装同样版本"拒装；artifactName 含 `${version}`，产物名随之区分。
- 内网分发：产物 + SHA-256 校验清单一并产出。

## 11. 测试策略

- **vitest 单测**（开发机 Node 跑，不依赖 Electron）：codec 编解码与坏报文模糊样本、补发队列裁剪规则、按字分词、文件名清洗、导入身份映射/去重——纯函数全覆盖。私聊直接发送覆盖 codec 用例（合法 `op:"direct"`、缺 transferId 拒绝）与 FilesService 用例（发送侧卡片请求 direct、接收侧收到 direct 自动 accept 到联系人目录、关闭开关或群聊 transfer 忽略 direct）；默认接收目录覆盖手动「接收」落到联系人子目录、另存为不额外套子目录。媒体撤回需补 codec 用例（`offer.msgId` 白名单 / 非法长度拒绝）、ChatService 用例（图片可撤回、文件 `done` 后不可撤回、群文件部分完成后不可撤回、旧端无 `mrec1` 不展示入口）和 FilesService 用例（撤回进行中传输会 cancel 并清理 `.part`）。
- **表格粘贴测试（决议 #270）**：`clipboard` 工具单测补收紧口径——issue #19 的列数不一致文本、Tab 缩进代码、单列 TSV、多张表或表外带正文的 HTML 片段一律不判为表格，Excel 式矩形 TSV 与纯表格 HTML 仍判为表格；`table-paste` 单测覆盖提示文案、草稿改动判定与摘除插入段；`ui/table-paste-hint.test.ts` 以源码断言锁住「粘贴不再直接发送」「提示条接线」等关键接线。
- **表格图片消息测试（决议 #190）**：`clipboard` 工具单测覆盖 HTML table / TSV 识别、普通富文本 emoji 不误判、无图片项时 HTML 渲染失败降级为文本插入、`tableText` 截断与 `tableTextTruncated` 标记；`codec` 单测覆盖 `offer.tableText/tableTextTruncated` 合法往返、非图片 offer 携带拒绝、超长拒绝或截断边界；`FilesService` 用例覆盖发送侧 `fileRef.tableText/tableTextTruncated` 入库、对支持 `tbl1` 的单聊 / 群成员发送字段、不支持成员退化普通图片、接收端 offer 入库保留；`ForwardService` 覆盖转发表格图片时继续传递 `tableText`；`ImageBubble` 组件测试覆盖图片 / 文字滑块切换、文字视图可选择复制与截断提示。
- **数据库自测**（`npm run test:db`）：esbuild 打包自测脚本后用 `ELECTRON_RUN_AS_NODE=1 electron` 执行——在 **Electron 内置 Node（ABI 110）** 上验证迁移/repo/FTS，与生产运行时完全一致。vitest 跑在开发机新版 Node 上加载不了 Electron ABI 的原生模块，故 DB 层测试必须走这条通道。
- **协议联调**：两个主进程实例本地回环（127.0.0.1 + 不同端口）跑发现/消息/补发/文件全流程脚本，模拟丢包（随机丢 10% UDP）。
- **三平台冒烟清单**（人工，发布前必过）：Win7 x64 VM（与生产环境一致）、Debian 10、macOS 26 各过一遍 README 红线场景 + 收发文件 + 截图 + 通知。
- E2E（Playwright `_electron`）：主流程烟测，配对版本脚手架期验证。

## 12. 里程碑与模块映射

| 版本          | 交付                                                                                                                                                                                                                                                                                                                                                                                                          | 涉及模块 |
|---------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---|
| v0.1          | 脚手架、发现/在线/探活、单聊文本、补发、托盘通知、三栏壳                                                                                                                                                                                                                                                                                                                                                      | net 全套（除 transfer）、store、chat、主窗 |
| v0.2          | 文件/文件夹传输、图片消息、emoji、历史+全局搜索                                                                                                                                                                                                                                                                                                                                                               | transfer、fts、file-card、emoji-panel |
| v0.3          | 讨论组、截图、表情包、跨网段（扫描+gossip）、三级树                                                                                                                                                                                                                                                                                                                                                           | groups、capture、stickers、discovery 扩展、contacts |
| v0.4          | 撤回、断点续传、导出/导入、深色主题                                                                                                                                                                                                                                                                                                                                                                           | messenger、transfer、porter、tokens |
| v0.5          | P1 交付补齐：转发、群内 @、长文本 TCP、截图标注、核心设置、备份包媒体迁移                                                                                                                                                                                                                                                                                                                                     | services、settings、porter、renderer |
| v0.27         | 局域网 P2P 自更新（分三步）：①发现与提示（caps `upd1` / 运行形态自检 / `ver` 投影 / 同平台版本比对 / 「内网有新版」提示）②拉包（`update` 可靠请求 / 按请求架构匹配已有本地包并隐藏回传 / nsis 自留包·deb `dpkg-deb` 自重打包 / 拉临时目录 + SHA-256 + 版本核对）③应用更新（nsis 静默装·deb pkexec / 替换重启 / 保留包接力成源）；mac 暂缓                                                                     | services/updater、transfer 复用、discovery（caps/ver）、util/self-package·apply-update、提示 UI |
| v0.28         | 私聊文件直接发送：发送端文件卡片「直接发送」入口、caps `fd1`、`file-ctl {op:"direct"}`、接收端自动 accept；默认文件接收统一到 `文件保存位置/联系人名称/`，另存为除外；群聊文件不支持直接发送                                                                                                                                                                                                                  | shared/protocol、net/codec、services/files、settings、renderer FileCard |
| v0.30         | 媒体撤回：`file-ctl offer.msgId`、caps `mrec1`、图片撤回、未完成文件撤回、群文件全员未完成才可撤回；已接收完成文件不可撤回                                                                                                                                                                                                                                                                                    | shared/protocol、net/codec、services/chat、services/files、renderer ImageBubble/FileCard |
| v0.32.x       | 全局刷新二次确认、群成员上限 200 等（已发布 v0.32.3）                                                                                                                                                                                                                                                                                                                                                         | App.vue、protocol GROUP_MAX_MEMBERS |
| v0.47         | 共享文件柜（分三步）：①我的文件柜（`config.fileCabinet` + SQLite v14 `share_grants` + 设置页共享目录 / 默认档 / 按人例外 + 共享根禁选校验）②浏览与下载（caps `shr1`、`share` 报文与 codec 白名单、分页快照、`realpath` 越界复核、私聊头部按钮 + 右侧覆盖面板、`purpose:"share-get"` 自动 accept）③上传（`purpose:"share-put"`、写权限复核、落 `root/上传者名/`、私聊系统提示）                                | shared/protocol、shared/ipc、net/codec（仅加白名单，transfer 不动）、store/migrations + share-grants-repo、services/share、settings、renderer FileCabinetPanel / stores/share / SettingsView |
| v0.50 → v0.51 | 文件柜一等入口（决议 #283，形态改为主窗第三个页签见 #284）：导航栏 cabinet 按钮切页签 + `stores/cabinet.ts` + `CabinetList`（列表栏：我的柜子摘要 + `shr1` 同事列表）+ `CabinetPane`（内容区：浏览器 / 我的柜子管理页，列表与网格双视图、文件管理器式多选与键盘）+ 设置页「我的文件柜」整组迁出 + `FileCabinetPanel` 同步重画；**协议、库表、services/share 零改动**                                          | main/index（2 个 IPC）、shared/ipc、preload、renderer App.vue / stores/cabinet / CabinetList / CabinetPane / PantryIcon / SettingsApp / FileCabinetPanel |
| v0.52         | 表情包本地多选导入、四列网格稳定滚动、群聊表情在线成员投递；协议与库表不变                                                                                                                                                                                                                                                                                                                                    | shared/ipc、main/index、preload、renderer EmojiPanel / stores/stickers / stores/chat、FilesService 既有群媒体路径 |
| v0.53         | 群聊引用回复（决议 #288）：`group-text` 新增可选 `replyTo` 源消息 ID；codec 入站校验只允许受限字符串，拒绝非法参数；接收侧按 ID 查群会话内源消息生成 `ReplyMeta`，本地 `messages.reply_to` 存源 ID 字符串；目标不存在时接收正常、跳转提示由渲染层处理。协议升 v0.51，SQLite升 v15                                                                                                                             | shared/protocol、shared/ipc、net/codec、main/index、main/services/groups、main/store/msg-repo、preload、renderer ChatPane / stores/chat / MessageRow |
| v0.53.1       | ARM64 Wayland 内置截图在 Electron 22 原生枚举前安全降级到系统截图粘贴；x64 Wayland、ARM64 X11 与其他平台保持原路径（决议 #289）                                                                                                                                                                                                                                                                               | main/index、capture-wiring test |
| v0.54.0       | 群简介与群公告（决议 #290）：`GroupMeta` 新增可兼容缺省的 `description`（≤ 200 字符）与 `announce`（≤ 1024 字符）；`GroupPatch` 新增 `set-description` / `set-announce`，群主、管理员或正确密码持有者可执行；codec 入站校验存在字段，service 规范化时保留旧端缺省字段的本地值，并隔离未授权或夹带的远端变更；SQLite v16 迁移追加两列，备份导入导出同步覆盖；renderer `GroupPanel` 通过同一文本弹窗复用管理密码路径并支持清空。协议 v0.51、SQLite v16，版本 **0.53.1 → 0.54.0** | shared/protocol、shared/ipc、net/codec、main/index、main/services/groups、main/services/porter、main/store/group-repo、renderer GroupPanel / GroupTextDialog / PantryIcon |
| 待办 · 暂缓   | 内网通兼容模式（#194–#196 设计；**#199 不排期**）                                                                                                                                                                                                                                                                                                                                                             | 见 nwt-compat-design.md；勿提前写 net/compat |
| 待办 · 暂缓   | 内网通实验附件互通（依赖上项 + TCP GETFILEDATA 闭环）                                                                                                                                                                                                                                                                                                                                                         | 同上 |
| v1.0          | 三平台安装包打磨、冒烟全过、文档定稿                                                                                                                                                                                                                                                                                                                                                                          | CI/builder |

## 13. 变更记录

- 2026-07-21 v1.58 决议 #265：截图文字工具移除 Electron 22 不支持的 `window.prompt()`，改用 renderer 内原地 DOM 输入框；纯函数负责视口夹紧与 composition 提交判定，Canvas 统一左上基线。协议 v0.49、SQLite v13、IPC 与依赖不变，版本 **0.45.1 → 0.45.2**。
- 2026-07-21 v1.59 决议 #266：截图工具条功能按钮统一接入本地 `PantryIcon` 线性 SVG，补四个截图专用图标并复用既有发送、文字、复制、取消图形；按钮保留 `title` / `aria-label` / `aria-pressed`。协议 v0.49、SQLite v13、IPC 与依赖不变，版本 **0.45.2 → 0.45.3**。
- 2026-07-21 v1.60 决议 #267：截图工具条八个按钮使用 CSS 伪元素提供自定义中文提示，支持悬停延迟、键盘聚焦和视口顶部自动翻向；移除原生 `title`，保留无障碍状态。协议 v0.49、SQLite v13、IPC 与依赖不变，版本 **0.45.3 → 0.45.4**。

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
- 2026-07-02 v0.44a 决议 #191：在保留 #96 显式图片宽高与小图 100% 显示的前提下，撤回“窗口可小到 1×1”的极端交互结果。`windows/image-viewer-sizing.ts` 统一计算图片窗口 fit 尺寸：缩放比例仍按屏幕工作区 70% 与原图尺寸决定，但最终内容区宽高不得低于 560×360；`image-viewer-window.ts` 同步设置 BrowserWindow 最小外框尺寸，避免用户手动缩到工具条挤压。无协议、IPC 签名、存储或传输改动。
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
- 2026-06-28 v0.97 决议 #187：修复 Debian 10 系统 `mksquashfs` 不支持 AppImage `-offset` 参数的问题。arm64 CI 撤掉 `USE_SYSTEM_MKSQUASHFS=true`，只保留系统 fpm。版本 0.29.5 → 0.29.6。
- 2026-06-30 v0.98 决议 #188：媒体撤回技术方案实现。新增 caps `mrec1` 与 `file-ctl offer.msgId`；图片 / 文件 / 群文件收发两端共享同一 `messages.id`，撤回仍走 `msg:recall` / `msg(kind:"recall")`。ChatService 负责撤回窗口、发送者和会话判断，FilesService 负责媒体能力、文件 transfer 是否已完成、取消传输和清理 `.part`；不新增 SQLite 表列。版本 0.29.6 → 0.30.0。
- 2026-06-30 v0.99 决议 #189：修复发送图片贴底与截图后回前台。`chatStore.pushOwn()` 在当前会话成功追加自己发送的消息后触发 `requestConversationScroll('latest')` 并退出历史态；主进程抽出 `showWindowForeground()`，截图窗口关闭 / 发送截图时用短暂 `alwaysOnTop` 把主窗带回前台后释放。版本 0.30.0 → 0.30.1。
- 2026-07-02 v1.00 决议 #190：表格粘贴图片消息技术方案实现。新增 caps `tbl1` 与 `file-ctl offer.tableText/tableTextTruncated`，不新增消息类型或 SQLite 迁移；renderer 在粘贴分流中识别 HTML table / TSV，默认生成表格图片，额外提取原始 TSV 作为受限元数据，超出 4096B UTF-8 时安全截断并标记；FilesService 按收件人能力附带或丢弃字段，接收端写入 `file_ref`；ImageBubble 以本地状态显示图片 / 文字滑块。旧端仍只显示普通图片，纯内网与日志脱敏约束不变。版本 0.30.1 → 0.31.0。
- 2026-07-02 v1.01 决议 #191：图片查看器小图窗口最小尺寸修复。新增纯函数 `fitImageViewerContent()` 统一初始 fit 计算，内容区最小 560×360，BrowserWindow 最小外框同步抬高；小图仍按原始尺寸居中，底部工具条获得稳定空间。版本 0.31.0 → 0.31.1。
- 2026-07-02 v1.02 决议 #192：会话打开默认定位最新消息修复。`chatStore.openConv()` 默认滚动意图改为 `latest`，显式进入会话时即使已有缓存也重载最新 50 条；`target` 继续服务历史搜索跳转，当前会话读历史时的新消息不强拉到底。纯渲染层状态策略调整，无协议、IPC、SQLite 变化。版本 0.31.1 → 0.31.2。
- 2026-07-08 v1.03 决议 #194：内网通兼容模式技术设计立项。新增 `net/compat/`、`services/nwt-compat.ts`、`config.nwtCompat` 与独立兼容联系人/会话投影约束；兼容层绑定 `2425/UDP`、实现 IPMSG 子集发现与普通文本收发，主协议、主端口、gossip、补发队列和文件传输语义保持不变。详见 [nwt-compat-design.md](nwt-compat-design.md)。
- 2026-07-08 v1.04 决议 #195：扩展内网通兼容技术设计。`net/compat/` 增加附件 parser、实验 TCP 文件通道和 `nwt-capabilities` 能力门控；`services/nwt-compat.ts` 负责兼容能力投影，IPC 预留 `nwt:file-offer` / `nwt:accept-file-offer` 等实验接口；UI 通过 `ConversationCapabilities` 隐藏 PK、震动、图片、文件、文件夹、直接发送和媒体撤回。标准 IPMSG 文件 / 剪贴板图片已列入实验阶段，内网通私有 `901x` 通道和远程协助继续排除。
- 2026-07-09 v1.05 决议 #197：全局网段刷新二次确认落渲染层。`App.vue` 在调用 `scanAllRanges` 前插入居中确认态；列表数据复用已加载的 `SettingsView.scanRangeItems` / `scanRanges`，不新增 IPC、协议、SQLite 或主进程扫描逻辑。版本 0.31.3 → 0.32.0。
- 2026-07-09 v1.06 决议 #199：内网通兼容从里程碑「下一步」挪到**暂缓待办**；§12 表与 handoff 同步，代码仍为零实现。
- 2026-07-09 v1.07 决议 #200 / OPT-5：SQLite 追加 v10 迁移，新增 `idx_messages_seq` 与 `idx_messages_conv_seq`，让消息插入取号、会话内按 seq 分页 / 上下文窗口和会话预览走索引。版本 0.32.7 → 0.32.8。
- 2026-07-09 v1.08 决议 #202：同步文档漂移修正记录。当前 OCR 架构以 PaddleOCR PP-OCRv6 tiny + onnxruntime-web 本地 wasm 为准；迁移当前版本以 `src/main/store/migrations.ts` 和 `PRAGMA user_version` 为准，旧 OCR 引擎描述仅保留在历史决议记录中。
- 2026-07-10 v1.09 决议 #208：传输层增加严格帧校验、失败隔离、读流 / 连接 / 超时预算；自更新增加一次性请求授权、精确包名与 512 MiB 上限；渲染层会话导航增加代次；CI 增加 package / lock / tag / artifact 版本一致性检查。版本 0.32.24 → **0.32.25**。
- 2026-07-10 v1.10 决议 #210：渲染层四个根组件改为单 HTML 下的动态入口；OCR 结果缓存增加 16 项 LRU 边界，服务初始化失败后允许重试；构建启用 manifest，并增加四入口可达性、文件独立性与 200 KiB 公共启动闭包门禁。版本 0.33.0 → **0.33.1**。
- 2026-07-13 v1.11 决议 #213：Windows 发布矩阵新增 ia32。独立 job 在五连验证后重建 x86 better-sqlite3，以 PE machine 校验源码与包内 native 模块，输出 NSIS / portable / SHA-256 三项资产；自更新架构白名单加入 ia32。版本沿用 **0.34.0**，与 #212 合并发布。
- 2026-07-13 v1.12 决议 #214：Linux 托盘未读闪烁改为高对比注意帧与常规图标交替；每次切帧新建 `NativeImage`，同一托盘的未读更新不重置周期，并补托盘销毁 / 写图失败的停表保护。版本 0.34.0 → **0.34.1**。
- 2026-07-13 v1.13 决议 #215：renderer 引入精确锁 `naive-ui@2.43.2`，首批只在设置动态入口复用标准表单与常规操作组件；新增集中主题覆盖，保持核心 IM 组件自绘、纯内网、Chrome 108、四入口拆包与 200 KiB 公共启动门禁。版本 0.34.1 → **0.35.0**。
- 2026-07-13 v1.14 决议 #216：Naive UI 第二批进入 `App.vue` 动态闭包，承载主窗口搜索与主要按钮；CSS token 扩展结构材质、交互表面和有色阴影，主界面及设置页按 Apple Design 原则统一层级、按压反馈和可访问性降级。版本 0.35.0 → **0.36.0**。
- 2026-07-13 v1.15 决议 #217：修复 `NConfigProvider` 根节点打断主窗口百分比高度链的回归。Provider 改用 `abstract` 模式，新增源码测试锁定无布局根节点契约，并将真实 Electron 默认尺寸、最小尺寸与最大化 / 还原列入 UI 回归验收。版本 0.36.0 → **0.36.1**。
- 2026-07-13 v1.16 决议 #218：preload 增加 `capture:init` 窗口内存回放，覆盖截图动态根晚订阅竞态；截图窗加载底色固定为黑色；设置 toast 改为窗口整体居中。补初始化先后顺序、退订与 BrowserWindow 选项测试。版本 0.36.1 → **0.36.2**。
- 2026-07-13 v1.17 决议 #219：`backdrop-filter` 收敛到浮层。移除主窗口 rail / list、聊天 head / input-area、设置 sidebar / panel 上对纯色背景无效的 blur，保留半透明背景与阴影层级；落档 `prefers-reduced-transparency` 在 Chrome 108 上不生效的事实。版本 0.36.2 → **0.36.3**。
- 2026-07-13 v1.18 决议 #221：Windows 截图几何改用 `display.workArea`，按桌面源实际像素裁掉任务栏；截图窗等待 renderer 解码和首帧就绪后显示，框选渲染改为单桌面图、四块遮罩和 RAF 合帧，最终裁剪按 X/Y 自然尺寸比例换算。版本 0.36.4 → **0.36.5**。
- 2026-07-13 v1.19 决议 #222：Windows / Linux 设置窗改为 modal 子窗，主窗通过 `ui:settings-window-state` 显示静态 scrim 并拦截交互；设置窗顶层伪元素提供 1px 平台无关边界。macOS 保持原生阴影与父子窗口行为。版本 0.36.5 → **0.36.6**。
- 2026-07-13 v1.20 决议 #223：设置页头像样式、主题和发送键共享自绘双段滑块，选中块只做 transform 位移；主题太阳 / 月亮复用本地 `PantryIcon`，移除设置动态闭包内不再使用的 Naive UI RadioGroup / RadioButton。版本 0.36.6 → **0.36.7**。
- 2026-07-13 v1.21 决议 #224：发送键滑块读取 `AppInfo.platform`，macOS 组合 Command + 回车图标，Windows / Linux 组合 Control + 回车图标；只改展示与无障碍名称，设置值和输入判定不变。版本 0.36.7 → **0.36.8**。
- 2026-07-14 v1.22 决议 #225：项目主许可调整为 `GPL-3.0-only`，根 `LICENSE` 使用 GNU 官方 GPLv3 全文，构建通过 `extraResources` 随安装包携带许可文本；历史 MIT 授权与第三方许可证保持有效。版本 0.36.8 → **0.37.0**。
- 2026-07-14 v1.23 决议 #226：彩色品牌源切换为生图方案 A 的 1024px RGBA 母版，平台图标、窗口图标、Windows / Linux 托盘和 renderer 品牌图统一从该母版派生；macOS 菜单栏保留单色模板 SVG。版本 0.37.0 → **0.38.0**。
- 2026-07-14 v1.24 决议 #227：修复私聊头部资料入口 hover 回归；移除宽按钮背景与 transform 反馈，保留昵称颜色过渡、完整点击热区和键盘焦点轮廓。版本 0.38.0 → **0.38.1**。
- 2026-07-14 v1.25 决议 #228：文字气泡移除顶部内高光，文件卡与文字气泡统一四角 14px；文件类型图标从内联 SVG 切换为本地透明 4×4 PNG atlas，保持原扩展名映射 API。版本 0.38.1 → **0.39.0**。
- 2026-07-14 v1.26 决议 #229：macOS 专属 `extraResources` 移除与全局配置重复的 `LICENSE`，避免 electron-builder 合并后向同一路径复制两次；全局配置继续覆盖三端许可分发。版本 0.39.0 → **0.39.1**。
- 2026-07-14 v1.27 决议 #230：`ForwardDialog` 使用 Teleport 脱离聊天区局部层叠上下文，补全局 overlay 层级、焦点、Esc 与 reduced-motion 契约，并新增源码回归测试。版本 0.39.1 → **0.39.2**。
- 2026-07-14 v1.28 决议 #231：Win7 / Linux 的软渲染条件通过 `AppInfo` 下发 renderer，关闭浮层磨砂并停用小图自动 OCR；图片大文件 I/O 改为异步；四窗口增加完整静态 JS / CSS 闭包预算，renderer 品牌图与文件 atlas 分别收敛到 256px / 512px。版本 0.39.2 → **0.39.3**。
- 2026-07-14 v1.29 决议 #232：保留主窗口 Naive UI 混合接入；聊天图片 / 表情消息、记录搜索缩略图与表情包网格启用原生惰性加载和异步解码。版本 0.39.3 → **0.39.4**。
- 2026-07-14 v1.30 决议 #233：`GroupCreator` 与 `ProfileCard` 复用主窗口已加载的 Naive UI Input / Button 与集中主题；密集成员勾选和专用结构保持原生轻量节点。版本 0.39.4 → **0.39.5**。
- 2026-07-14 v1.31 决议 #234：新增文件头图片元数据白名单、8192px / 3200 万像素内联门禁，以及 320px WebP、128MB LRU 的受限派生缩略图缓存；聊天流近视口加载缩略图，独立看图读取校验后的原图。版本 0.39.5 → **0.39.6**。
- 2026-07-14 v1.32 决议 #235：新增 `img:pick` 专用图片选择 IPC，对话框与主进程授权层双重限制支持扩展名；发送图片按钮取消普通文件发送分支。版本 0.39.6 → **0.39.7**。
- 2026-07-14 v1.33 决议 #236：文件发送方主动取消时同步写入 `canceled` 消息终态，并在传输、消息状态两层拦截迟到失败覆盖；renderer 区分“发送取消”与“已取消”。版本 0.39.7 → **0.39.8**。
- 2026-07-14 v1.34 决议 #237：`GroupCreator` 联系人项改为姓名与组织路径同一 flex 行，组织字段本地组合并在剩余空间内省略；传输与数据层无变化。版本 0.39.8 → **0.39.9**。
- 2026-07-14 v1.35 决议 #238：`SettingsApp` 侧栏删除账号摘要；`App` 个人信息卡使用 120ms CSS 延迟、透明命中桥和显示态 pointer events 组成连续悬停范围。无新增响应状态、timer、IPC 或数据字段。版本 0.39.9 → **0.39.10**。
- 2026-07-14 v1.36 决议 #239：新增设置动态入口专属 `SettingsNavIcon`，提供 7 组 24×24 线性 SVG 路径；导航改为 18px 图标与文字同一 flex 行，颜色继承现有 hover / 选中状态，公共 `PantryIcon` chunk 不增长。版本 0.39.10 → **0.39.11**。
- 2026-07-14 v1.37 决议 #240：端口输入框默认 readonly；renderer 确认层以 `pendingPortEdit` / `unlockedPort` 管理单字段解锁，取消不改值，确认后聚焦全选，失焦复用原校验保存并重新锁定。版本 0.39.11 → **0.39.12**。
- 2026-07-14 v1.38 决议 #241：groups v11 增加 `owner_id/admin_ids`；协议元数据、备份和 IPC 视图同步角色字段，服务层按单操作权限矩阵校验本地与远端变更，群主退出执行确定性转让，renderer 展示角色与兼容提示。版本 0.39.12 → **0.40.0**。
- 2026-07-14 v1.39 决议 #242：抽取建群/邀请共用的成员搜索多选组件，新增 Teleport 全局邀请弹窗；批量确认复用既有 `invite memberIds[]`，无协议、IPC、数据库或依赖变化。版本 0.40.0 → **0.41.0**。
- 2026-07-14 v1.40 决议 #243：新增内容寻址 `AvatarStore/AvatarService`、`av1` 可靠按需取图、`pantry-avatar://` 受限读取通道与 renderer 共用裁剪弹窗；SQLite v12 为联系人和群增加头像哈希，备份携带引用头像，群头像变更沿用改名权限和 LWW 校验。版本 0.41.0 → **0.42.0**。
- 2026-07-14 v1.41 决议 #244：`SettingsApp` 依据 `avatarHash` 条件展示图片操作区；空值时由“图片头像”分段项直接触发选图，非空时只显示更换与恢复操作。纯 renderer 模板调整，无协议、IPC、存储或网络变化。版本 0.42.0 → **0.42.1**。
- 2026-07-14 v1.42 决议 #245：`SettingsApp` 增加独立编辑模式状态，按动物 / 首字 / 自定义条件渲染网格、色板或上传按钮；头像纯函数保留 `-1` 旧值，并用 `200..209` 表达昵称首字的显式背景色。沿用现有整数存储、IPC 与资料同步，无 SQLite 迁移。版本 0.42.1 → **0.43.0**。
- 2026-07-14 v1.43 决议 #246：裁剪弹窗改用窗口级 Pointer Events 与统一拖动收尾；`pantry-avatar` 提前登记为标准安全 scheme，并新增共享受管头像 URL 生成 / 解析函数，以固定 `asset` 主机和哈希路径统一三平台资源读取。线上报文、SQLite v12 与 IPC 不变。版本 0.43.0 → **0.43.1**。
- 2026-07-15 v1.44 决议 #247：裁剪弹窗改用窗口级鼠标事件；WebP 输出从原始字节创建 `ImageBitmap` 后绘制，并在编码前拒绝全透明像素结果、确保位图释放。线上报文、SQLite v12、IPC 与头像缓存结构不变。版本 0.43.1 → **0.43.2**。
- 2026-07-15 v1.45 决议 #248：头像链路健壮性加固——`settings:save-profile` 拒绝受管缓存中不存在的新头像哈希（防全网空请求循环）；`AvatarStore.prune` 只清理修改时间超过 1 分钟的 `.tmp`，消除与原子写入的竞态；`AvatarStore` 增加已验证哈希内存缓存（prune / 覆写同步失效），`has/resolvePath` 不再每次读盘验证；`GroupPanel` 恢复默认群头像失败补错误提示。无协议、SQLite、IPC 结构变化。版本 0.43.2 → **0.43.3**。
- 2026-07-15 v1.46 决议 #249：协议 v0.48 `avatar` 新增尽力而为 `miss` 提示（`Messenger.sendBestEffort` 一次性 UDP 单发），`AvatarService` 请求登记扩展为「当前源 + 已试源集合」，群头像收到当前源 miss 后立即故障转移到下一个未试在线成员；裁剪最大缩放改为 `min(源图短边/192, ∞)` 动态上限、×1.12 等比步进，WebP 输出经 `createImageBitmap` 裁剪 + resizeQuality high 一步降采样，整数裁剪矩形夹回图内。SQLite、IPC 结构不变。版本 0.43.3 → **0.44.0**。
- 2026-07-15 v1.47 决议 #253：Win7（NT 6.1）启动早期关闭 Chromium TSF 输入法支持并回退 IMM32，修复部分旧输入法 / 第三方输入法候选窗固定左上角；其他平台保持默认输入法路径。版本 0.44.3 → **0.44.4**。（已被 #254 撤销）
- 2026-07-16 v1.48 决议 #254：核实 Win7 恒走 IMM32，撤销 #253 的无效 TSF 开关；Win7 判定收敛到 `util/windows-version.ts`，输入法候选窗问题转真机对照定位。版本 0.44.4 → **0.44.5**。
- 2026-07-16 v1.49 决议 #255：Win7 输入法焦点自愈——主窗口/设置窗口 focus 后延迟重走原生 show 流程，把 Win32 键盘焦点钉回顶层窗口，修复 IMM32 候选窗粘性退回屏幕左上角；仅 Win7 安装。版本 0.44.5 → **0.44.6**。
- 2026-07-16 v1.50 决议 #256：撤销 #255 的 `show()` 自愈；Win7 主聊天 `textarea` 在输入焦点建立/窗口重新激活后刷新 Chromium 文本输入客户端，强制 IMM32 重取 caret bounds，保留选区与滚动并避开 composition。`AppInfo` 增加本机 `windows7` 标记，协议与 SQLite 不变。版本 0.44.6 → **0.44.7**。（Win7 搜狗真机实测无效，已被 #257 撤销）
- 2026-07-16 v1.51 决议 #257：Win7 搜狗实测否定 #256，删除 textarea blur/focus 与 `AppInfo.windows7`；主窗口激活和 textarea 获焦时用 `webContents.focus()` 满足 Chromium IMM32 的 Win32 焦点句柄门槛，字体缩放从 renderer `body.style.zoom` 迁到主进程 `webContents.setZoomFactor()` 统一坐标换算。协议与 SQLite 不变，IPC 增加本机焦点同步调用，版本 0.44.7 → **0.44.8**。
- 2026-07-16 v1.52 决议 #258：v0.44.8 Win7 搜狗真机照片确认候选窗锚在应用客户区 `(0,0)`，撤销 `webContents.focus()` 与对应 IPC；textarea 改为正常流布局，仅 Win7 在组合输入期间用 0–1px 几何脉冲触发 Chromium 重排并重新发布 caret bounds。保留原生 WebContents 页面缩放。协议与 SQLite 不变，`AppInfo.windows7` 只作 renderer 门控，版本 0.44.8 → **0.44.9**。
- 2026-07-16 v1.53 决议 #259：交叉测试把 Win7 搜狗故障收敛到聊天自定义 textarea；删除 #258 几何脉冲，仅 Win7 切到无 `PantryEmojiBlank`、无 Twemoji 镜像、无透明覆盖和无 composition 自定义处理的基础 textarea，其他平台保持完整编辑器。协议、SQLite、IPC 与原生页面缩放不变，版本 **0.44.9-beta.1 → 0.44.9-beta.2**。
- 2026-07-16 v1.54 决议 #260：Win7 搜狗真机确认基础 textarea 候选窗定位正常；保留安全输入层并恢复输入区一体化材质，彩色 emoji 改为绝对定位、无命中、无布局参与的 Twemoji 展示覆盖层。协议、SQLite、IPC 与依赖不变，版本 **0.44.9-beta.2 → 0.44.9-beta.3**。
- 2026-07-16 v1.55 决议 #261：Win7 安全 textarea 与 Twemoji 覆盖层恢复相同的 `PantryEmojiBlank` 字体栈，以 `1.3em` 固定 advance 对齐输入图形、消息正文尺寸和连续表情 caret；安全布局与输入法事件路径不变。协议、SQLite、IPC 与依赖不变，版本 **0.44.9-beta.3 → 0.44.9-beta.4**。
- 2026-07-16 v1.56 决议 #262：Win7 真机确认真实 textarea 使用空白 WebFont 会触发搜狗候选窗失位，撤销 #261 的 Win7 路径；Win7 改用系统字体 contenteditable 和 `1.3em` Twemoji 原子节点，以 DOM 原生布局统一表情尺寸与 caret。协议、SQLite、IPC 与依赖不变，版本 **0.44.9-beta.4 → 0.44.9-beta.5**。
- 2026-07-21 v1.57 决议 #263：普通私聊/群聊文件统一 24 小时领取期限；协议 v0.49 增加 `offer.expiresAt`，SQLite v13 增加 transfer 截止时间与共享出站 manifest，`FilesService` 跨重启恢复并投影双向过期文案。版本 **0.44.9-beta.5 → 0.45.0**。
- 2026-07-22 v1.58 决议 #269：`GroupCreator` 调用 IPC 前把响应式成员选择复制为普通数组，并以异常收尾恢复提交状态和显示行内错误；遮罩关闭要求按下与点击均起落在遮罩自身，提交期间锁定关闭入口。协议、SQLite、IPC 契约、依赖与网络均不变，版本 **0.45.5 → 0.45.6**。
- 2026-07-25 v1.59 决议 #270：`readClipboardTableText` 收紧为「唯一 `<table>` 且表外无实质文字」或「列数一致、≥2 列、首列非全空的多行 TSV」；`ChatPane` 粘贴命中后改为插入草稿 + 提示条，剪贴板图片项在事件内同步捕获，新增 `utils/table-paste.ts` 纯函数与 `table` 图标。协议、SQLite、IPC 契约、依赖与网络均不变，版本 **0.45.6 → 0.46.0**。
- 2026-07-25 v1.60 决议 #271–#277（共享文件柜设计轮，**只落档、代码零改动**）：新增 `services/share.ts`（权限判定 / 目录列举与分页快照 / 路径校验与 `realpath` 越界复核 / 下载 offer / 上传落点 / 系统提示）与 `store/share-grants-repo.ts`；`net/` 只在 `codec.ts` 增加 `share` 报文白名单，`transfer.ts` 与端口配置不动。IPC 新增 `share:my-*` / `share:grant-*` / `share:browse|download|upload` 与 `share:config-updated` 事件，传输进度复用既有 `transfer:*`。SQLite 升 **v14** 增 `share_grants(node_id PK, mode, updated_ts)`，`config.json` 增 `fileCabinet {root, mode}`（缺省 `off`，共享根禁选主目录根 / 系统盘根 / dataRoot），文件柜传输复用 `transfers` 只在 `files` JSON 带 `purpose`。里程碑新增 v0.47 三步交付。
- 2026-07-25 v1.61 决议 #271/#276/#277 第 ① 步实现：新增 `store/share-grants-repo.ts` 与 SQLite 迁移 v14 `share_grants`；`services/share.ts` 落地纯函数 `evaluateShareRoot`（相对路径 / 盘符根 / 主目录根 / 与 dataRoot 相互包含全部拒绝，大小写不敏感平台不可靠改大小写绕过）与 `ShareService`（`modeFor` = 例外优先、回落默认档，未设共享根一律 `off`；库未就绪时例外退化为内存态）。`ConfigFile.fileCabinet` 与 `SettingsView.fileCabinet` 打通，IPC 新增 5 个 `share:*` 通道，**不新增事件**（配置随既有 `settings:updated` 广播）。`net/` 与 `transfer.ts` 零改动。新增 `services/share.test.ts` 13 例，`db-selftest` 补 v13→v14 迁移与例外表往返断言。版本 **0.46.0 → 0.47.0**。
- 2026-07-25 v1.62 决议 #273/#275/#276 第 ② 步实现：`services/share.ts` 补齐 `sanitizeSharePath` / `resolveWithinRoot` / `listShareDirectory` / `fitSharePage` 与 `ShareService.handleList|handleGet`（分页快照 60s×8 份、按人限流），新增 `ShareDownloadGate` 一次性下载授权与 `shareDownloadDirName` 默认落点。`net/codec.ts` 加 `share` 白名单，`net/messenger.ts` 把 `share` 纳入可靠控制报文（TCP 兜底），`net/transfer.ts` 仍零改动。`FilesService` 新增 `offerSharePaths` 与 `onShareGetOffer`，`FilesBlob.purpose` 扩展 `share-get`；主进程装配 `handleShareCtl` / `requestShare` 并新增 `share:browse` / `share:download` 两个 IPC。renderer 新增 `components/FileCabinetPanel.vue`，`ChatPane` 加头部入口。新增测试：share 服务 31 例、codec 5 组、FilesService 5 例、messenger 超包 TCP 兜底回环 1 例。版本 **0.47.0 → 0.48.0**。
- 2026-07-25 v1.63 决议 #272/#274 第 ③ 步实现：`services/share.ts` 新增 `handlePut`（写权限 + 总量 + 共享根存在三项复核，返回 `共享根/<上传者显示名>/`）与 `shareUploadDirName`，`handleList` 的 `perm` 恢复按 `mode` 回报。`FilesService` 新增 `offerSharePut` 与 `onSharePutOffer`，`FilesBlob.purpose` 扩展 `share-put`；`finish()` 在入站 `share-put` 收口为 `done` 时调用 `announceShareUpload` 写入幂等系统提示（`share:<transferId>:uploaded`），桌面通知由既有 `notifyIncoming` 对 `system` 的跳过天然规避。新增 IPC `share:upload`（无路径时弹选择器，有路径时必须先过 `file:grant-paths`；主进程 `measureUploadPaths` 递归实测文件数与字节，超 2 GiB 直接回 `too-large`）。renderer 面板加上传按钮与拖入上传，`MessageRow` 让带 `fileRef` 的系统提示可点开目录。新增测试 12 例。版本 **0.48.0 → 0.49.0**。
- 2026-07-26 v1.64 决议 #279：`share:upload` 的体量测算从主进程装配层的同步递归改为 `util/upload-measure.ts` 的异步实现——`fs/promises` 的 `stat`/`readdir`、显式待处理队列代替递归、每批 64 条并发（批内跑满 libuv 线程池，批间让出事件循环），深度上限 32 与"任一条目读不到即整体失败"的语义保持不变。`index.ts` 移除 `readdirSync` 依赖，调用点改 `await`。新增 `util/upload-measure.test.ts` 8 例（单文件 / 递归目录 / 多入口累加 / 空目录 / 缺失条目 / 空入口 / 跨批 200 条 / 超 32 层）。协议、库表、IPC 契约与依赖均不变，版本 **0.49.1 → 0.49.2**。
- 2026-07-26 v1.65 决议 #280：`ShareDownloadGate` 从 `Map<peerId, grant>` 改为句柄化的在途授权数组——`begin()` 返回 token 并按登记顺序 FIFO 配对 offer，`cancel(token)` / `isPending(token)` 只作用于本次，在途上限 32；`index.ts` 的 `share:download` 超时分支相应从「consume 探测」改为「isPending + cancel」。新增内部 `resolveUnderRealRoot(realRoot, rel)`，共享根 realpath 由调用方解析一次后传入，`resolveWithinRoot` 对外签名不变。`listShareDirectory` 改用 `readdirSync(..., { withFileTypes: true })`，以 Dirent 类型为排序键先对全量条目排序再截断、随后按真实 `isDir` 复排一次，并省掉逐条 `lstatSync`。**遗留**：该函数仍全程同步且由对端浏览触发，5000 条目录会做 5000 次 `statSync`，异步化需连 `ShareService.handleList` 的返回契约一起改，记入 handoff §4。协议、库表与 IPC 契约不变，版本 **0.49.2 → 0.49.3**。
- 2026-07-26 v1.66 决议 #281/#282：renderer 新增 `utils/format.ts`（统一 `formatBytes`），`stores/transfers.ts` 的 `fmtBytes` 撤销、`FileCard` / `SettingsApp` / `FileCabinetPanel` 三处旧实现删除；`CaptureApp` 的 canvas 标注色改为从 `--primary` 读一次缓存。`services/files.ts` 抽出私有 `offerHidden(peerId, prepared, msgIdPrefix, blob)`，`offerUpdatePackage` / `offerSharePaths` / `offerSharePut` 共约 120 行的重复收尾收敛到一处，净减 46 行、行为零变化。协议、库表与 IPC 契约不变，版本 **0.49.3 → 0.49.5**。
- 2026-07-26 v1.59 决议 #283：文件柜提为一等入口。新增 `main/windows/cabinet-window.ts`（1000×680 / 最小 860×560、单例、**可缩放且非模态**——要能与主窗并排，故不复用设置窗的 modal + scrim 路径）与 `#/cabinet` 渲染入口 `CabinetApp.vue`；新增 `ui:open-cabinet`（可带 peerId 定位）与 `share:recent-uploads`（读既有 `transfers` 的 `purpose='share-put'` 入站完成记录汇总，不新增表列）两个 IPC。`SettingsApp` 移除「我的文件柜」整组（共享目录 / 默认档 / 按人例外的 5 个 `share:*` IPC 调用点整体搬到 `CabinetApp`），`App.vue` 导航栏底部工具组新增 cabinet 按钮，`FileCabinetPanel` 按同一套样式重画并新增「在文件柜窗口打开」。**协议 v0.50、SQLite v14、`services/share.ts`、`net/`、依赖清单一律未动**，纯前台入口与界面重组。版本 **0.49.5 → 0.50.0**。
- 2026-07-27 v1.60 决议 #284：文件柜由独立窗口改为主窗第三个页签。删除 `windows/cabinet-window.ts` 与 `#/cabinet` 渲染入口（回到四入口契约，决议 #210），界面拆为 `components/CabinetList.vue`（列表栏）+ `components/CabinetPane.vue`（内容区），共享状态收进 `stores/cabinet.ts`；`ui:open-cabinet` 改为「`showMainWindow()` + 向主窗发 `cabinet:focus-peer`」。**不用 App 内动态 import 来省闭包**——那会让 Rollup 把 App 的 facade 并进匿名共享块、manifest 丢掉 `src/App.vue` 动态入口，四入口门禁随之失效；改为把 `App.vue` 的静态闭包预算由 640/96 KiB 抬到 800/116 KiB（NSelect 等表单控件随文件柜进主窗），公共启动闭包仍为 80 KiB 未受影响。协议 v0.50、SQLite v14、`services/share.ts` 与依赖不变，版本 **0.50.0 → 0.51.0**。
- 2026-08-10 v1.61 决议 #285：新增英文 README、贡献/开发/第三方说明及 `docs/en/` 当前规范，`scripts/check-doc-locales.mjs` 校验文档对与双向链接，Release 说明增加双语标题和下载指引；同时修正公开开发指南的 OCR 选型漂移为 PaddleOCR PP-OCRv6 tiny + onnxruntime-web。运行时架构、协议 v0.50、SQLite v14、IPC、依赖与网络保持，版本 **0.51.0 → 0.51.1**。
- 2026-08-26 v1.62 决议 #286：Wayland 会话启动时合并启用 `WebRTCPipeWireCapturer`，但截图仍以 `desktopCapturer` 实际能力为准，不再按会话类型提前返回；主窗口隐藏抽为等待 `hide` 信号、合成器退场与最终可见性复核。新增 `capture:failed` main→renderer 事件，空源、空图和异常走应用内提示或系统通知。协议 v0.50、SQLite v14、依赖与网络保持，版本 **0.51.1 → 0.51.2**。
- 2026-08-27 v1.63 决议 #287：表情导入复用现有压缩入库动作，主进程增加独立选择授权与受限源图读取；网格仅增加原生 CSS 隐式行尺寸；群聊发送复用 `FilesService.offerGroupPaths(..., 'sticker')`。协议 v0.50、SQLite v14、依赖与端口保持，版本 **0.51.2 → 0.52.0**。
- 2026-08-29 v1.64 决议 #288：群聊引用回复。`group-text` 载荷新增可选 `replyTo`（源消息 ID 字符串）；codec 入站只允许受限非空字符串，拒绝空串与含 `senderName/text` 的对象；接收侧在本地群会话内按 ID 查询源消息，生成 `MessageView.replyTo.id/senderName/text`，本地 `messages.reply_to` 列存源 ID；目标消息不存在时接收正常，跳转与不可用提示由渲染层处理。协议升 v0.51，SQLite 升 v15。版本 **0.52.0 → 0.53.0**。
- 2026-08-29 v1.65 决议 #289：Issue #34 的麒麟 ARM64 Wayland 截图崩溃在 Electron 22 的 `desktopCapturer` 原生枚举阶段发生，进程级 SIGSEGV 无法由 JS 捕获。统一 `startCapture` 入口只对 ARM64 Wayland 在隐藏窗口和枚举前复用既有失败反馈与系统截图粘贴退路；其他平台分支不变。协议 v0.51、SQLite v15、依赖与网络均不变，版本 **0.53.0 → 0.53.1**。
- 2026-08-31 v1.66 决议 #290：群简介与群公告。`GroupMeta` 新增 `description`（≤ 200 字符）与 `announce`（≤ 1024 字符）字段；codec 接受旧端缺省并由 `GroupsService` 保留本地已知值，远端更新按单操作权限隔离；群主、管理员或正确密码持有者可设置与清空；SQLite v16 追加两列，迁移备份同步保留；renderer 以一个 `GroupTextDialog` 复用管理密码路径、忙态与错误反馈。协议 v0.51、SQLite v16，版本 **0.53.1 → 0.54.0**。
- 2026-09-05 v1.67 决议 #291：PR #39 复审修复。远端简介 / 公告在 `GroupsService` 统一做单操作权限隔离，旧端缺省字段由同一规范化入口保留；`GroupPanel` 复用 `prepareGroupAdminPatch` / `runUpdate`，共享 `GroupTextDialog` 只承担输入与可访问交互；备份导入导出覆盖两字段。协议 v0.51、SQLite v16、依赖与端口不变，版本 **0.54.0 → 0.54.1**。
- 2026-09-05 v1.68 决议 #292：`GroupsService.canApplyRemoteInfo` 按快照版本差区分相邻单操作和跨版本累积变化；文本鉴权通过后，结构变化继续复用既有分支校验。复用已有 `need/info` 与 LWW 入库流程，补实际发送端生成快照的补齐测试及高 rev 越权、夹带回归。协议 v0.51、SQLite v16、依赖与端口不变，版本 **0.54.1 → 0.54.2**。
