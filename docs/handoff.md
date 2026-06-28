# 茶话间（Teahouse）开发交接文档

> 给接手本项目的任何 AI 代理或开发者。读完本文 + [AGENTS.md](../AGENTS.md) 即可无缝继续开发。
> 最后更新：2026-06-28（**v0.29.5，Debian 10 / UOS 20 arm64 锁定 Ruby 2.5 兼容 ffi 依赖**）：公开仓库统一为 `skyjt/teahouse`，v0.11.4 为发布整理版；v0.12.0 补齐群改名系统提示（#87）与私聊顶部 IP 完整展示（#88）；v0.12.1 修复发送端先整文件预读 SHA-256 再发数据导致 10GB 级文件接受后长时间 0B 的问题；v0.13.x–v0.16.x 打磨文件卡片、关于页、独立图片查看窗口、本地 OCR、品牌 SVG、通知兼容、私聊震动和会话滚动；v0.17.0 新增 `scan-ranges` 网段记录低频同步（#114）；v0.18.0 新增左侧刷新全局用户（#115）；v0.19.x 打磨左侧导航 tooltip / 自己信息卡 / 焦点框（#116–#121）；v0.20.0 完成英文品牌名 Teahouse 更名（#124）；v0.21.x 完成移除会话删除聊天内容、置顶底色、顶栏等高与输入框拖拽、右键菜单关闭、文件卡片对齐、消息缓存索引、高频渲染路径优化和安全扫描报告修复（#125–#138）；v0.22.x 完成 PK 分歧解决与 UI 打磨（#139–#148）；v0.23.x–v0.26.x 完成设置页重组、网段表格、默认目录与图片传输修复；v0.27.x 推进局域网 P2P 自更新，当前已完成发现提示、更新请求协议地基、关于页主动检测 / 索包入口、`purpose:"update"` 更新包隔离接收、`update:request` 向最佳源请求已有本地安装包回传，以及设置-关于检测更新区按方案 A 并入键值行、机制说明收进圆形问号 tooltip、tooltip 上浮防裁切（#166–#173）；v0.28.x 完成私聊文件「直接发送」、拖拽 / 粘贴授权、文件卡 UI 收紧、默认接收目录统一与第三方截图粘贴去重；v0.29.0 新增 Linux arm64 deb/AppImage 发布 job，并让自更新安装包查找按架构匹配；v0.29.1 将 arm64 容器内发布脚本独立为 `scripts/ci-linux-arm64.sh`；v0.29.2 取消 QEMU，Linux arm64 发布 job 改用 GitHub 远程 `ubuntu-22.04-arm` runner + Debian 10 arm64 容器；v0.29.3 安装系统 fpm/mksquashfs 并将 Linux dist 脚本显式限定 `deb/AppImage` 架构；v0.29.4 尝试预装 `ffi 1.17.4`；v0.29.5 改为 `libffi-dev` + Ruby 2.5 兼容的 `ffi 1.15.5`。仍遵守 Electron 22.3.27 / Node16 / Chrome108 / 纯内网红线。本文会过期——以 `git log` 与各文档变更记录为准。

## 0. 必读顺序（15 分钟上手）

1. **[AGENTS.md](../AGENTS.md)** —— 9 条硬性红线（Electron 22.3.27 焊死、纯内网、分层铁律等），违反即错误；
2. 本文 —— 状态、工作流、下一步；
3. 设计四件套（按需细读）：[requirements.md](requirements.md)（功能与 184 项决议）→ [protocol.md](protocol.md)（线上协议 v0.34）→ [ui-design.md](ui-design.md)（界面）→ [tech-design.md](tech-design.md)（选型/分层/库表）；
4. `git log --oneline` —— 提交历史就是完整开发史，每条 commit message 都是一份增量说明。

## 1. 项目状态一览

纯内网、无服务器、基于 IP 的局域网 IM + 文件传输（Electron 22 / Vue 3 / better-sqlite3）。
**v0.1、v0.2、v0.3、v0.4/P1 主链路已完成，本地迭代至 v0.29.5**（对照 tech-design §12）。Windows / Debian / UOS 真实打包运行测试留给目标平台执行：

| 已交付 | 说明 |
|---|---|
| 发现层 | UDP 广播 + 心跳（30s/90s）+ 探活；跨网段三板斧：手动 IP / CIDR 扫描 / gossip（结识即交换+周期）；扫描范围 `scan-ranges` 低频同步（只同步配置候选，自动扫描延迟 30–90 分钟、12 小时去重、在线规模抽样）；主界面全局刷新可扫描全部已保存网段并显示进度 |
| 单聊 | 文本 UDP+ACK 退避重传，UDP 无 ACK 后 TCP 控制帧兜底一次，离线补发队列（落库）、24h 去重、打开会话二次探活；私聊窗口震动为可靠即时提醒动作，不离线补发，收发两端写本地系统提示行，收端唤起主窗并定位到发起人单聊，发送/接收均按同一对端 60s 最多 2 次、两次至少间隔 15s 限流 |
| 讨论组 | LWW 元数据（rev+updatedTs）、同一信封逐成员扇出、need/info 补元数据；群管理按创建 IP / 可选管理密码+提示控制；群名变化写入幂等系统提示（改名人「你把群名…」、其他成员「备注/昵称把群名…」）；群聊图片/文件按在线成员逐个点对点传输 |
| 文件 | TCP 拉取式流传输、SHA-256 流式校验、文件夹递归、重名避让、路径穿越防护；普通手动接收与私聊「直接发送」自动接收在未另存为时都默认保存到 `文件保存位置/联系人名称/`；群聊文件不支持直接发送 |
| 图片/表情 | 单聊图片 offer purpose=image ≤20MB 免确认；群聊图片 ≤10MB 才按图片消息投递，超限按文件卡片手动接收；截图粘贴/拖图（第三方截图工具粘贴时浏览器 paste 与原生剪贴板兜底互斥，不重复发送）；右键收藏（canvas 压缩 512px WebP）；图片查看窗口内建本地 OCR，小图自动识别、大图手动识别，图片上不再渲染 OCR 覆盖层 / token / 拖选交互，点击识别或已识别按钮会打开独立文本结果窗，用户在原生 textarea 内自行选择复制；识别结果由主进程会话级内存缓存，重新打开图片可直接查看文本结果，OCR 后图片拖拽平移始终不受影响 |
| 内置截图 | 全局快捷键 Ctrl/Cmd+Alt+A、框选窗、剪贴板+直发会话、截图隐藏主窗（可配）|
| 撤回 | 自己文本/群文本/PK 消息 5 分钟内可撤（决议 #63/#139，右键菜单实时倒计时 mm:ss、超时变灰）；`msg.kind:"recall"` 可靠投递 + 离线补发；本地/对端隐藏原消息并插系统提示，撤回 PK 不级联影响别人之后另发的 PK |
| PK 分歧解决 | 输入区 `PK` 入口（表情后、窗口震动前），线性拳头相碰图标 + 并排「猜拳 / 骰子」浮层；结果由主进程随机，气泡本地播放约 1.5s 动画后定格。他人的 PK 旁显示「我也来 / 掷一下」按钮，每次参与发一条新消息；单聊仅对方在线可发，群聊只发给当时在线成员；通知 / 预览 / 搜索不透结果，PK 可撤回但不可复制 / 转发 |
| P1 消息交互 | 链接识别可点、消息转发（文本/图片/文件/表情可基于本地媒体转发）、~~多选群发~~（决议 #62 已取消，改用讨论组）、群内 @ 加强提醒、长文本 TCP 控制帧 |
| P1 文件/数据 | `.part` 断点续传；传输记录；HTML/TXT 阅读导出；`.pantry-bak` 迁移备份包（消息、联系人、群、传输、表情、图片/表情媒体）+ 身份映射导入 |
| P1 系统/设置 | 开机自启、关闭到托盘/退出、通知预览、系统提示音开关、托盘 / 菜单栏未读数字与闪烁兜底、深色主题、字体缩放、截图/显示隐藏快捷键、UDP/TCP 端口保存（重启生效）、局域网自更新发现提示、关于页主动检测与键值行索包请求 |
| 打包链条 | `electron-builder@24.13.3` 精确锁；`dist:win`/`dist:linux`/`dist:mac` 本地脚本；Windows/Debian 真实打包测试留给目标平台 |
| GitHub 发布 | 公开仓库：[skyjt/teahouse](https://github.com/skyjt/teahouse)；`.github/workflows/release.yml` 已配置 Windows 7 x64、Debian 10 / UOS 20 x64、Debian 10 / UOS 20 arm64、macOS arm64 四条发布线；Linux CI 在 Debian 10 容器内强制源码重建 better-sqlite3，electron-builder 关闭二次 `npmRebuild`，并检查源码重建产物与最终包内 `.node` 最高 GLIBC 符号不超过 2.28；arm64 使用 GitHub 远程 `ubuntu-22.04-arm` runner 跑 Debian 10 arm64 容器，安装系统 fpm / mksquashfs 与 `libffi-dev`，先锁定 `ffi 1.15.5` 再安装 `fpm 1.9.3`，并显式构建 `deb:arm64` / `AppImage:arm64`，产出 deb/AppImage 与独立 SHA 清单；push `main` / 手动触发上传 artifact，推送 `v*` tag 自动创建/更新 GitHub Release；目标平台真实桌面冒烟仍按 packaging-test 执行 |
| UI | **沉浸式无标题栏主窗/设置窗（决议 #49/#51/#52：mac 红绿灯置列表栏顶部 x=68、Win/Linux 右上自绘控制按钮、顶部 32px 隐形拖拽带——mac/Win 走 CSS 拖拽区，Linux 因 CSS 拖拽区吞点击改 Pointer Capture + 主进程光标跟随 JS 拖拽，`WindowDragStrip` 组件分流）**、三栏主窗、左侧 68px 浅灰导航（聊天/通讯录主图标 25px，刷新全局用户按钮位于设置上方并带细进度条，设置图标 21px；导航按钮在鼠标真实移动后延迟显示单体中文 tooltip，自己头像仅鼠标悬停显示分组个人信息卡）、三级通讯录树（公司▸部门▸团队，单击右侧资料页、双击直达单聊）、联系人完整资料页+本地备注、私聊头部资料弹窗+备注编辑、私聊顶部完整 IP 副标题、全局搜索（FTS 按字）、发起讨论组两步搜索选人+设置、自绘 SVG 系统图标、明确齿轮设置入口、20 个 Twemoji 本地 SVG 动物头像 + 背景色模板、设置页头像编辑器（决议 #50：大预览 + 图标/昵称首字分段切换 + 图标网格 + 色板）、内置 emoji 子集 Twemoji 本地 SVG 兼容渲染（面板 / 输入框编辑态 / 消息正文；输入框镜像按实际字体 DOM 探针逐字符测宽，与光标逐像素对齐）、系统通知 emoji 文本降级与真实应用图标（决议 #108）、茶杯气泡品牌 logo 三件套（菜单栏单色缩小留边、彩色小标、大图标/空状态）、输入区图标中文延迟提示、输入框 placeholder 独立浅 hint 色、输入区最右侧会话内历史搜索（设置页尺度弹窗，默认显示最近记录，关键词/图片/文件/连续日期筛选，图片结果显示缩略图）、独立图片查看窗口（标题栏文件名、初始 70% 屏幕阈值缩放、底部半透明菜单、缩放/适应窗口/原始大小/旋转/拖拽平移、双击以鼠标位置锚点放大、OCR 独立文本结果窗与缓存、另存为/快捷键，不遮挡主聊天窗）、消息内容级右键菜单与边缘避让、历史滚动加载、会话滚动位置按会话恢复且后台/通知直达默认最新（决议 #111）、设置独立小窗（桌面软件式分组面板）、首启向导、托盘+通知直达会话 |
| 存储 | SQLite WAL，迁移 v8（user_version 机制，**只追加永不改旧迁移**）|

## 2. 开发工作流（沿用即可）

**一个增量 = 设计文档同步 → 实现 → `package.json` 按决议 #73 递增版本号 → 五连验证 → 一个中文 commit**：

```bash
npm test          # vitest：codec/discovery/messenger/transfer/frame/sanitize/cidr/fts/zip 等
npm run test:db   # 数据库自测：ELECTRON_RUN_AS_NODE 在真实 ABI(110) 上跑迁移/各 repo
npm run typecheck # node16 + chrome108 双基线
npm run build     # 三端产物
npm run smoke     # 启动 1.5s 干净退出（PANTRY_SMOKE 钩子，CI 同款）
```

- 本机三客户端联调：懒人入口用 `npm run dev:2` 一次拉起前两个、`npm run dev:3` 一次拉起三个；也可分别在三个终端跑 `npm run dev:client1`、`npm run dev:client2`、`npm run dev:client3`。三个实例使用 `/tmp/pantry-dev1..3` 和 `17878/27878/37878` UDP 端口、`17879/27879/37879` TCP 端口。
- 决策落档：新决议追加到 requirements §9 决议记录 / §11 变更记录（编号已到 #180，续 #181+）；协议改动必须 protocol.md 先行。
- 与用户协作：**全程中文**；用户技术方向不在网络/协议——技术细节直接定但落档、**不要追问底层**；产品可感知取舍（功能形态/默认参数）用 2-4 个带推荐的选项问他。

## 3. 代码地图（src/，分层铁律见 AGENTS.md #7）

```
shared/    protocol.ts(协议TS化·唯一来源) ipc.ts(IPC契约·唯一来源)
main/
  net/     codec(校验白名单) udp(限速/广播) discovery(发现/gossip/探活)
           messenger(可靠投递·等待表与队列按"消息×收件人"复合键) transfer(TCP数据面) frame cidr
  store/   db(WAL) migrations(v8·只追加) peers/conv/msg/queue/dedup/group/transfer/sticker-repo
           fts(中文按字) app-state(identity/config) db-selftest(test:db 入口)
  services/ chat groups files search —— 用例编排层；业务禁入 ipc 层（AI 接口预留，决议#21）
  windows/ tray settings-window capture-window tray-icon(base64内嵌)
  index.ts 装配+IPC handlers+通知+截图编排+pantry-img/pantry-sticker 协议
preload/   contextBridge 唯一入口（window.pantry，类型=shared/ipc.ts 的 PantryApi）
renderer/  main.ts 哈希三入口(App/#settings/#capture)；stores(pinia=主进程投影)；components
```

关键不变量：net/ 与 services/ **零 Electron 依赖**（vitest 可直接实例化）；renderer 一切经 `window.pantry`；消息 id=信封 id=去重锚点；群消息同一信封 id 发全员。

## 4. 下一步：P1 交付收尾

1. **本地五连验证**：后续代码改动仍需按 `npm test` → `npm run test:db` → `npm run typecheck` → `npm run build` → `PANTRY_UDP_PORT=47878 PANTRY_TCP_PORT=47879 npm run smoke` 重跑，任何失败先修复再交付。
2. **目标平台打包测试**：GitHub Actions 可先产出 Windows 7 x64、Debian 10 / UOS 20 x64、Debian 10 / UOS 20 arm64、macOS arm64 发布候选；真实启动、收发、托盘、通知、防火墙/权限仍交给对应目标环境按 [packaging-test.md](packaging-test.md) 冒烟。
3. **v1.0 打磨项**：macOS universal 包专项、Win7 / UOS 真实平台复测（本地 SVG emoji/头像、软渲染、SHA-2 KB 提示文案）。

## 5. 已知遗留 / TODO（非阻塞）

- 系统 UI 图标仍为项目内自绘 SVG；头像模板和内置 emoji 子集使用 Twemoji 本地 SVG 子集（`src/renderer/src/assets/twemoji/`），输入框编辑态通过 textarea 镜像层显示同套 SVG，emoji 占位宽度由 `utils/emoji-metrics` 的隐藏 DOM 探针按输入框实际字体逐字符测量（canvas measureText 对 emoji 与 DOM 排版不一致，不可用；探针挂 `<html>` 下避开 body zoom），协议/复制仍保留 UTF-8 emoji 字符。后续若扩展 emoji 子集，必须同步 `compat-emoji` 映射、Twemoji SVG 文件、输入框镜像渲染覆盖和 CC-BY 4.0 署名，不引入运行时远程资源。
- 群聊图片/文件已支持：发送端按在线成员逐个点对点 transfer，离线成员不入文件队列；群聊图片单图 ≤10MB 走图片消息，超过 10MB 退化为普通文件卡片并由接收端手动接收；表情包面板群内直发仍暂不开放（转发本地媒体可复用群媒体通道）。
- 群消息不做按成员送达回执（本端入库即 sent），明细 P2。
- 设置页结构已重排为左侧分组 + 右侧面板；高级项仍是打磨：聊天记录存储位置迁移、空间占用/缓存清理、诊断日志导出、快捷键冲突实时检测、清空全部记录双重确认。核心 P1 设置（资料、头像、文件目录、通知、自启、关闭行为、主题、字体、快捷键、端口、导入导出）已可用。
- npm 11 对 `.npmrc` 自定义键（electron_mirror/runtime 等）打 deprecation 警告——npm 12 需改用环境变量，暂可忽略。
- Linux arm64 产物已进入 Release workflow；真实 UOS / Debian arm64 桌面冒烟仍需目标机器按 packaging-test 执行。
- 局域网 P2P 自更新已完成发现提示、主动检测 / 索包请求、`update req` 可靠投递、已有本地安装包的隐藏 `purpose:"update"` 回传与隔离接收；仍缺 A 侧备包（nsis 自留 / deb 自重打包）、B 侧包格式与版本核对、安装重启、进度呈现与失败重试闭环。
- 图片 OCR 当前使用 Tesseract.js 识别，不落库、不做全文索引、不做“大爆炸”分词面板；图片上不再叠加 OCR 选择层，不做逐字拖选。识别结果按 `transferId:naturalSize` 缓存在主进程会话级内存中，图片窗口加载后先查缓存，命中后底部按钮可直接打开文本结果窗，用户在原生 textarea 中选择 / 复制文字；小图自动 OCR 不自动弹窗，大图仍手动触发。后续扩展语言包必须继续走本地静态资源复制并评估包体与启动后首次识别耗时。

## 6. 环境与坑（新机器上手）

- 开发机 Node ≥18（仅工具链；运行时是 Electron 内置 Node 16.17，**主进程代码无 fetch/structuredClone**）。
- `npm install` 后 Electron 报损坏 → README「常见问题」的 ditto 解法（macOS 解压坑）。
- `.npmrc` 三件套**都是故意的，不要"修"**：`legacy-peer-deps`（@types/node 锁 16）、`runtime=electron`+`target`（native 模块面向 Electron ABI 编译，开发机 Node 太新会编不过 9.x 源码）。
- 网络相关测试必须 `bindAddress: '127.0.0.1'` + `broadcastTargets: []`——**绝不向真实局域网发包**。
- 数据库迁移只追加（migrations.ts 数组 push 新项）；建新表前检查是否已存在于早期迁移（groups/stickers/transfers 都吃过"漏建表"的亏，db-selftest 会抓）。
- `npm audit` 会报 Electron 22 EOL、builder/rebuild/tar、Vite/Vitest 本地开发服务器类 advisories；**不要跑 `npm audit fix --force`**，它会升级 Electron / builder / 测试工具大版本并破坏 Win7 基线。运行时缓解仍按 README「安全性」：只加载本地资源、严格隔离、无外网、入站白名单校验。
