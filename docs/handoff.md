# 茶话间（Pantry）开发交接文档

> 给接手本项目的任何 AI 代理或开发者。读完本文 + [AGENTS.md](../AGENTS.md) 即可无缝继续开发。
> 最后更新：2026-06-12（v0.5.0 P1 本地交付候选）。**本文描述"当前状态与下一步"，会过期——以 `git log` 与各文档变更记录为准。**

## 0. 必读顺序（15 分钟上手）

1. **[AGENTS.md](../AGENTS.md)** —— 9 条硬性红线（Electron 22.3.27 焊死、纯内网、分层铁律等），违反即错误；
2. 本文 —— 状态、工作流、下一步；
3. 设计四件套（按需细读）：[requirements.md](requirements.md)（功能与 28 项决议）→ [protocol.md](protocol.md)（线上协议 v0.16）→ [ui-design.md](ui-design.md)（界面）→ [tech-design.md](tech-design.md)（选型/分层/库表）；
4. `git log --oneline` —— 提交历史就是完整开发史，每条 commit message 都是一份增量说明。

## 1. 项目状态一览

纯内网、无服务器、基于 IP 的局域网 IM + 文件传输（Electron 22 / Vue 3 / better-sqlite3）。
**v0.1、v0.2、v0.3、v0.4/P1 主链路已完成，本地进入 v0.5.0 交付候选**（对照 tech-design §12）。Windows / Debian 真实打包运行测试留给目标平台执行：

| 已交付 | 说明 |
|---|---|
| 发现层 | UDP 广播 + 心跳（30s/90s）+ 探活；跨网段三板斧：手动 IP / CIDR 扫描 / gossip（结识即交换+周期）|
| 单聊 | 文本 UDP+ACK 退避重传、离线补发队列（落库）、24h 去重、打开会话二次探活 |
| 讨论组 | LWW 元数据（rev+updatedTs）、同一信封逐成员扇出、need/info 补元数据；群管理按创建 IP / 可选管理密码控制 |
| 文件 | TCP 拉取式流传输、SHA-256 流式校验、文件夹递归、重名避让、路径穿越防护 |
| 图片/表情 | offer purpose=image/sticker，≤20MB 免确认；截图粘贴/拖图；右键收藏（canvas 压缩 512px WebP）|
| 内置截图 | 全局快捷键 Ctrl/Cmd+Alt+A、框选窗、剪贴板+直发会话、截图隐藏主窗（可配）|
| 撤回 | 自己文本/群文本消息 2 分钟内可撤；`msg.kind:"recall"` 可靠投递 + 离线补发；本地/对端隐藏原消息并插系统提示 |
| P1 消息交互 | 链接识别可点、消息转发（文本/图片/文件/表情可基于本地媒体转发）、多选群发、群内 @ 加强提醒、长文本 TCP 控制帧 |
| P1 文件/数据 | `.part` 断点续传；传输记录；HTML/TXT 阅读导出；`.pantry-bak` 迁移备份包（消息、联系人、群、传输、表情、图片/表情媒体）+ 身份映射导入 |
| P1 系统/设置 | 开机自启、关闭到托盘/退出、通知预览、系统提示音开关、深色主题、字体缩放、截图/显示隐藏快捷键、UDP/TCP 端口保存（重启生效） |
| 打包链条 | `electron-builder@24.13.3` 精确锁；`dist:win`/`dist:linux`/`dist:mac` 本地脚本；Windows/Debian 真实打包测试留给目标平台 |
| UI | 三栏主窗、三级通讯录树（公司▸部门▸团队）、资料卡+本地备注、全局搜索（FTS 按字）、自绘线性 SVG 系统图标、明确齿轮设置入口、20 个亲和动物 emoji + 背景色头像模板、输入区图标中文延迟提示、消息内容级右键菜单与边缘避让、历史滚动加载、设置独立小窗、首启向导、托盘+通知直达会话 |
| 存储 | SQLite WAL，迁移 v7（user_version 机制，**只追加永不改旧迁移**）|

## 2. 开发工作流（沿用即可）

**一个增量 = 设计文档同步 → 实现 → 五连验证 → 一个中文 commit**：

```bash
npm test          # vitest：codec/discovery/messenger/transfer/frame/sanitize/cidr/fts/zip 等
npm run test:db   # 数据库自测：ELECTRON_RUN_AS_NODE 在真实 ABI(110) 上跑迁移/各 repo
npm run typecheck # node16 + chrome108 双基线
npm run build     # 三端产物
npm run smoke     # 启动 1.5s 干净退出（PANTRY_SMOKE 钩子，CI 同款）
```

- 本机三客户端联调：懒人入口用 `npm run dev:2` 一次拉起前两个、`npm run dev:3` 一次拉起三个；也可分别在三个终端跑 `npm run dev:client1`、`npm run dev:client2`、`npm run dev:client3`。三个实例使用 `/tmp/pantry-dev1..3` 和 `17878/27878/37878` UDP 端口、`17879/27879/37879` TCP 端口。
- 决策落档：新决议追加到 requirements §9（编号已到 #28，续 #29+）+ 涉及文档的变更记录；协议改动必须 protocol.md 先行。
- 与用户协作：**全程中文**；用户技术方向不在网络/协议——技术细节直接定但落档、**不要追问底层**；产品可感知取舍（功能形态/默认参数）用 2-4 个带推荐的选项问他。

## 3. 代码地图（src/，分层铁律见 AGENTS.md #7）

```
shared/    protocol.ts(协议TS化·唯一来源) ipc.ts(IPC契约·唯一来源) 
main/
  net/     codec(校验白名单) udp(限速/广播) discovery(发现/gossip/探活)
           messenger(可靠投递·等待表与队列按"消息×收件人"复合键) transfer(TCP数据面) frame cidr
  store/   db(WAL) migrations(v7·只追加) peers/conv/msg/queue/dedup/group/transfer/sticker-repo
           fts(中文按字) app-state(identity/config) db-selftest(test:db 入口)
  services/ chat groups files search —— 用例编排层；业务禁入 ipc 层（AI 接口预留，决议#21）
  windows/ tray settings-window capture-window tray-icon(base64内嵌)
  index.ts 装配+IPC handlers+通知+截图编排+pantry-img/pantry-sticker 协议
preload/   contextBridge 唯一入口（window.pantry，类型=shared/ipc.ts 的 PantryApi）
renderer/  main.ts 哈希三入口(App/#settings/#capture)；stores(pinia=主进程投影)；components
```

关键不变量：net/ 与 services/ **零 Electron 依赖**（vitest 可直接实例化）；renderer 一切经 `window.pantry`；消息 id=信封 id=去重锚点；群消息同一信封 id 发全员。

## 4. 下一步：P1 交付收尾

1. **本地五连验证**：本轮头像模板补调与退出补发保护已于 2026-06-12 跑通 `npm test` → `npm run test:db` → `npm run typecheck` → `npm run build` → `PANTRY_UDP_PORT=47878 PANTRY_TCP_PORT=47879 npm run smoke`；后续改动仍需按同链路重跑，任何失败先修复再交付。
2. **目标平台打包测试**：按用户要求，本地确认基本无误后交给 Windows 7 x64 VM / Debian 10 做真实打包与运行冒烟；macOS 当前架构包可本机验证。流程见 [packaging-test.md](packaging-test.md)。
3. **v1.0 打磨项**：GitHub Actions（linux 必须 debian:10 容器编译 native）、macOS universal 包专项、Win7 VM 专项（twemoji 图片渲染、软渲染验证、SHA-2 KB 提示文案）、LICENSE 定稿（暂定 MIT，需用户确认）。

## 5. 已知遗留 / TODO（非阻塞）

- 系统 UI 图标已改为项目内自绘 SVG；消息正文与 emoji 面板里的 emoji 仍用系统字形渲染，**twemoji 子集图片替换**（Win7 彩色方案，tech-design §7）留待 Win7 冒烟时做（纯展示层，协议无关）。
- 群内暂不支持文件/图片/表情包（传输是单目标的；UI 已禁用并提示"后续版本"）。
- 群消息不做按成员送达回执（本端入库即 sent），明细 P2。
- 设置页高级项仍是打磨：聊天记录存储位置迁移、空间占用/缓存清理、诊断日志导出、快捷键冲突实时检测、清空全部记录双重确认。核心 P1 设置（资料、头像、文件目录、通知、自启、关闭行为、主题、字体、快捷键、端口、导入导出）已可用。
- npm 11 对 `.npmrc` 自定义键（electron_mirror/runtime 等）打 deprecation 警告——npm 12 需改用环境变量，暂可忽略。
- linux arm64 产物：CI 用 docker buildx，拖节奏就先只发 x64（tech-design §9 已记）。
- 协议 `profile.ver` 已传输，"发现内网新版本提示"（P2）尚未做 UI。

## 6. 环境与坑（新机器上手）

- 开发机 Node ≥18（仅工具链；运行时是 Electron 内置 Node 16.17，**主进程代码无 fetch/structuredClone**）。
- `npm install` 后 Electron 报损坏 → README「常见问题」的 ditto 解法（macOS 解压坑）。
- `.npmrc` 三件套**都是故意的，不要"修"**：`legacy-peer-deps`（@types/node 锁 16）、`runtime=electron`+`target`（native 模块面向 Electron ABI 编译，开发机 Node 太新会编不过 9.x 源码）。
- 网络相关测试必须 `bindAddress: '127.0.0.1'` + `broadcastTargets: []`——**绝不向真实局域网发包**。
- 数据库迁移只追加（migrations.ts 数组 push 新项）；建新表前检查是否已存在于早期迁移（groups/stickers/transfers 都吃过"漏建表"的亏，db-selftest 会抓）。
- `npm audit` 会报 Electron 22 EOL、builder/rebuild/tar、Vite/Vitest 本地开发服务器类 advisories；**不要跑 `npm audit fix --force`**，它会升级 Electron / builder / 测试工具大版本并破坏 Win7 基线。运行时缓解仍按 README「安全性」：只加载本地资源、严格隔离、无外网、入站白名单校验。
