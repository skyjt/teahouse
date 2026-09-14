# 参与开发

> [简体中文](CONTRIBUTING.md) · [English](CONTRIBUTING.en.md)

感谢你对茶话间的关注。本文说明如何从源码构建、本地联调，以及参与开发时必须遵守的几条硬约束。

## 环境要求

- **Node.js ≥ 18**（仅供工具链使用，Vite 5 要求）。应用运行时是 Electron 内置的 **Node 16.17.1**，与本机 Node 版本无关。
- 国内网络建议在 `.npmrc` 配置 Electron 镜像（仓库已内置）：

  ```ini
  electron_mirror=https://npmmirror.com/mirrors/electron/
  electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
  ```

## 快速开始

```bash
git clone https://github.com/nameGXF/teahouse.git
cd pantry
npm install
npm run dev          # 本地开发（热重载）
```

## 常用脚本

```bash
npm run dev          # 本地开发（热重载）
npm run dev:2        # 本机联调：一次性启动客户端 1 + 2
npm run dev:3        # 本机联调：一次性启动客户端 1 + 2 + 3
npm run build        # 编译 main / preload / renderer
npm test             # vitest：协议编解码 + 发现层回环集成 + 纯函数
npm run test:db      # 数据库自测（在 Electron 内置 Node 真实 ABI 上执行）
npm run typecheck    # node16 / chrome108 两套类型基线
npm run smoke        # 构建 + 启动冒烟（1.5s 干净退出）
npm run dist:win     # NSIS 安装包 + 便携版（x64；请在 Windows / Win7 VM 测试）
npm run dist:linux   # deb + AppImage（x64；请在 Debian 10 环境测试）
npm run dist:mac     # dmg + zip（当前 macOS 架构）
```

## 本机多客户端联调

无需多台机器即可验证发现 / 消息 / 文件链路——每个客户端有独立身份、独立数据目录、错开的 UDP / TCP 端口：

```bash
# 懒人入口：一个终端里直接拉起多个客户端，Ctrl+C 结束
npm run dev:2
npm run dev:3

# 或分终端逐个启动
npm run dev:client1  # /tmp/pantry-dev1，端口 17878 / 17879
npm run dev:client2  # /tmp/pantry-dev2，端口 27878 / 27879
npm run dev:client3  # /tmp/pantry-dev3，端口 37878 / 37879
```

## 核心约束（务必遵守）

整个项目围绕「一套二进制覆盖 Win7 到最新系统」这一目标构建，以下约束是它的基石，改动代码时请勿打破：

1. **Electron 精确锁定 `22.3.27`** —— 不升级、不加 `^` / `~`。这是支持 Windows 7 的根决策（Electron 23 起官方放弃 Win7）。
2. **运行时基线** —— 主进程按 **Node 16.17** 写代码（无全局 `fetch`、无 `structuredClone`，网络一律用 `net` / `dgram` / `http`）；渲染层按 **Chrome 108** 写代码（无原生 CSS 嵌套 / Popover / `text-wrap: balance` / subgrid）。构建目标已在 `electron.vite.config.ts` 固定为 `node16` / `chrome108`。
3. **依赖纪律** —— 所有依赖精确锁版本（`npm i -E`）；新增依赖先确认其 `engines` 兼容 Node 16；原生模块仅允许 better-sqlite3 一个，且需针对 Electron 22 的 ABI 用 `@electron/rebuild` 重编。
4. **安全基线不可动** —— `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，拦截窗口内导航与 `window.open`，严格 CSP，渲染进程永不加载远程内容。
5. **纯内网原则** —— 不引入任何外网请求（更新检查、统计上报、CDN 字体、远程图片、第三方 API 一律禁止）。这是产品命门。
6. **入站报文白名单校验** —— 所有来自网络的数据按不可信输入处理（长度、类型、字段白名单）；未知报文类型忽略而非报错（向前兼容）。

## 提交前自测

改动交付前请跑完下面五连验证：

```bash
npm test          # 编解码 + 回环集成 + 纯函数
npm run test:db   # 真实 ABI 上的迁移 / repo / FTS
npm run typecheck # node16 / chrome108 两套类型基线
npm run build     # 三端产物
npm run smoke     # 构建 + 启动 1.5s 干净退出（退出码 0）
```

网络相关测试必须绑定 `127.0.0.1`，**绝不向真实局域网发包**。

## 项目结构

```
pantry/
├─ src/
│  ├─ main/        # 主进程：net/（发现、传输、协议编解码）、store/（SQLite）、services/、windows/
│  ├─ preload/     # contextBridge 安全桥，渲染进程唯一的能力入口
│  ├─ renderer/    # UI（Vue 3 + Pinia，构建目标 chrome108）
│  └─ shared/      # 主 / 渲染进程共享的类型与常量
├─ build/          # 打包资源（图标、安装器配置）
├─ references/     # 参考资料与开源项目源码（本地克隆，不入库；见该目录 readme）
└─ scripts/        # 构建 / 发布 / 本机多客户端联调脚本
```

**分层约定**：`renderer/` 不直接 import electron / node 模块，一切能力经 `window.pantry`（preload）；`net/`、`store/` 互不感知且零 Electron 依赖（保证可单元测试），业务编排在 `services/`；`shared/` 零运行时依赖。

> 更详细的目录树、各模块职责、数据流，以及「想做某项改动从哪下手」的扩展点清单，见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 打包与发布

- GitHub Actions `release.yml`：构建 Windows 7 x64、Debian 10 / UOS 20 x64 等产物并上传；推送 `v*` tag 时自动创建 Release。
- 各平台产物仍需在对应真机 / VM 上冒烟验证（Win7 SP1 x64、Debian 10 / UOS 20）。

## 常见问题

**macOS 上 `npm install` 报 `Electron failed to install correctly`**：解压环节对 zip 内符号链接处理失败（常见于较新的 npm / Node）。处理：进入 `node_modules/electron`，用系统 `ditto -xk ~/Library/Caches/electron/<哈希目录>/electron-v22.3.27-darwin-arm64.zip dist/` 手动解压，再执行 `printf "Electron.app/Contents/MacOS/Electron" > path.txt`（**必须用 printf，路径不能带换行**）。
