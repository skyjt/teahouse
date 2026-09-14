<div align="center">

<p><b>简体中文</b> · <a href="README.en.md">English</a></p>

<img src="build/icons/pantry-logo-icon.png" alt="茶话间 Logo" width="120" height="120" />

<h1>茶话间 &nbsp;·&nbsp; Teahouse</h1>

<p><b>不用连外网、不用架服务器，局域网里聊天和传文件</b></p>

<p>
  <a href="https://github.com/nameGXF/teahouse/releases/latest">
    <img src="https://img.shields.io/github/v/release/nameGXF/teahouse?style=flat-square&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&color=3D8B6B&logo=github&logoColor=white" alt="最新版本" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-GPL--3.0--only-3D8B6B?style=flat-square" alt="GPL-3.0-only" />
  </a>
  <a href="https://github.com/nameGXF/teahouse/releases">
    <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%207%2B%20%7C%20Linux%20%7C%20macOS-0366d6?style=flat-square" alt="平台" />
  </a>
  <img src="https://img.shields.io/badge/Electron-22-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 22" />
</p>

<p>
  <a href="#为什么做这个">为什么做</a>
  &nbsp;·&nbsp;
  <a href="#特性">特性</a>
  &nbsp;·&nbsp;
  <a href="#平台支持">平台支持</a>
  &nbsp;·&nbsp;
  <a href="#安装">安装</a>
  &nbsp;·&nbsp;
  <a href="#使用">使用</a>
  &nbsp;·&nbsp;
  <a href="#工作原理">工作原理</a>
  &nbsp;·&nbsp;
  <a href="#安全性">安全性</a>
  &nbsp;·&nbsp;
  <a href="#参与开发">参与开发</a>
</p>

</div>

---

同一个局域网里，每台电脑启动茶话间，就能自动看见彼此，点开就能发消息、传文件。全程不碰外网、不依赖任何服务器，数据只在内网里走。适合公司内网、隔离网、实验室这类不方便、或者根本不允许连外网的环境。

## 为什么做这个

内网里传个文件、说句话，本该是小事，可挑来挑去没一个顺手的：

- **飞鸽** 这类好用的商业工具需要付费；
- **内网通** 仅提供 Windows 版本，统信 UOS 与 Mac 无法直接安装；
- **iptux** 虽跨平台但界面上手门槛偏高，日常办公使用不够直观。

干脆自己写一个：免费开源、纯内网直连、从 Windows 7 到国产统信 UOS 再到 macOS 全平台覆盖、打开就会用。这就是茶话间。

## 特性

- **打开就用，零配置发现** —— UDP 广播自动发现同网段在线同事，节点直连通信，无需架设服务器或手动输入 IP。
- **跨网段与局域网更新** —— 支持手动添加对端 IP 与 CIDR 网段探测；已保存网段在在线节点间低频自动共享；支持全局网段扫描与实时进度；支持局域网内 P2P 索包自更新。
- **即时通信与群组协作** —— 支持单聊与讨论组群聊；支持文本、本地图片、截图粘贴、Twemoji SVG 图形表情与自定义表情收藏；具备消息送达确认、离线暂存与上线自动补发、2 分钟内撤回、消息转发、引用回复直达原消息、群内 @ 成员；支持群简介（≤200 字）与群公告（≤1024 字）同步广播；支持窗口震动提醒。
- **高速点对点文件传输** —— TCP 点对点直连，跑满局域网物理带宽；支持单文件、多选文件及完整文件夹发送，支持断点续传与传输历史记录；提供 24 小时领取时效机制，超期自动关闭接收。
- **共享文件柜（主界面第三页签）** —— 主窗口原生集成共享文件柜；支持发布本地文件夹，配置全局默认权限（关闭 / 只读 / 允许读写）与按联系人独立授权；支持分页浏览同事文件柜、面包屑导航、多选下载与另存为；在具备权限时可直接拖拽上传文件或文件夹，统一归档在独立子目录，避免覆盖他人数据；提供最近上传汇总。
- **独立大图浏览与内置离线 OCR** —— 独立看图窗口支持平滑缩放、双击锚点缩放、旋转与窗口居中；支持在当前会话图片历史中连续切换上一张 / 下一张；内置 PaddleOCR（PP-OCRv6 tiny + onnxruntime-web WASM）纯离线文字识别引擎，支持在原图文字位置直接拖选、跨行选择与复制文本，附带快捷复制全部文字；具备会话级内存缓存，重复查看秒级恢复文字层。
- **原生截图工具** —— 快捷键一键唤起；支持矩形选择、画笔、箭头、马赛克与原地单行文字标注；提供放大镜与取色坐标预览；适配 Linux Wayland 与 X11 环境。
- **本地历史与全文检索** —— 基于 SQLite WAL 模式与 FTS 全文索引，支持全局快速搜索联系人、群聊与聊天记录；支持单会话内历史消息搜索；支持聊天数据本地导出备份与换机迁移。
- **多语言即时切换** —— 原生支持简体中文与 English，在「设置 → 通用 → 语言 / Language」一键切换并即时同步全窗口；新安装根据系统首选语言自动初始化。
- **纯内网安全边界** —— 启动时全局注入 `--no-proxy-server` 禁用环境代理；彻底杜绝外网请求、统计上报与第三方 CDN 依赖；渲染层开启严格沙箱与上下文隔离；网络报文全程白名单校验；接收文件名执行路径穿越清洗；内联图片限制单边 ≤8192px 且总像素 ≤3200 万；日志脱敏处理，消息正文与文件内容绝不入日志。

## 平台支持

| 平台 | 支持范围 | 架构 | 安装包 | 真机实测 |
|---|---|---|---|---|
| Windows | 7 SP1 起（含 8 / 8.1 / 10 / 11） | x64 / 32 位（ia32） | NSIS 安装包、便携版 | ✅ Windows 7 x64；32 位构建支持 |
| 统信 UOS / 麒麟等（信创） | UOS 20 及以上、Kylin V10 | x64 / arm64 | .deb | ✅ UOS 20 x64；arm64 构建支持 |
| macOS | 12（Monterey）起 | Apple Silicon | .dmg、.zip | ✅ macOS 12+ / Apple Silicon |
| Debian / Ubuntu 等 | Debian 10（buster）起 | x64 / arm64 | .deb、AppImage | 构建支持 |

> 「真机实测」标有 ✅ 的环境，均在真实操作系统中实际安装并完整验证收发链路，超出仅在 CI 中完成静态编译的范畴。
>
> 为保证在 Windows 7 以及较老版本 Linux / 信创平台上的长期平稳运行，整个应用锁定在 **Electron 22.3.27** 基线。相关开发红线与依赖约束见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安装

前往 [**Releases**](https://github.com/nameGXF/teahouse/releases) 下载对应平台的安装包。

**Windows** — 根据系统架构选择 x64 或 ia32（32 位）NSIS 安装包，也可直接使用对应便携版。Windows 7 需安装 **SP1**；若启用了代码签名，未打补丁的 Win7 需先安装系统更新 KB4474419。

**Linux** — `.deb` 适用于 Debian / Ubuntu / 统信 UOS / 麒麟等；其他发行版可用 `AppImage`（赋予可执行权限后运行）：

```bash
chmod +x Teahouse-*.AppImage
./Teahouse-*.AppImage
```

**macOS** — 打开 `.dmg` 拖入「应用程序」。内网分发若未签名 / 公证，首次打开需在「系统设置 → 隐私与安全性」中允许，或在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/Teahouse.app
```

## 使用

1. 同一局域网内的设备各自启动茶话间，会通过 UDP 广播自动相互发现并出现在左侧列表中。
2. 点击联系人即可开始单聊，或点击加号新建多人讨论组；将文件或文件夹拖入聊天窗口即可发送。
3. 点击左侧导航栏的「文件柜」页签，可浏览同事开放共享的文件，或发布本机的共享文件夹并分配权限。
4. **跨网段通信**：当 UDP 广播无法穿透不同路由网段时，可在「设置 → 网络」中手动添加对端 IP 或配置 CIDR 网段探测；已保存的网段会在在线同事间低频自动共享；点击导航栏底部的刷新按钮可一键扫描全部网段并查看实时进度。
5. **图片查看与文字提取**：双击聊天图片打开独立看图窗口，点击两侧箭头可连续浏览该会话历史图片；点击下方「识别文字」即可在图内直接划选文字并复制。
6. 首次运行时操作系统防火墙若弹出放行提示，请允许通行（默认端口：UDP `17878` 与 TCP `17879`）。

## 工作原理

每个客户端都是平等的对等节点（P2P），整个系统**不设立中心服务器**：

```text
渲染进程 (Renderer) —— 会话列表 / 聊天面板 / 共享文件柜 / 图片查看器 / 设置窗口
   │  仅通过 contextBridge 暴露的安全 IPC 契约通信
主进程 (Main)
   ├─ 网络服务 (Net)   : UDP 广播发现与心跳、UDP+ACK / TCP 消息通道、TCP 文件直传
   ├─ 业务服务 (Services): 联系人管理、群组服务、共享文件柜服务、离线暂存队列
   ├─ 存储层   (Store) : SQLite (WAL 模式 + FTS 全文索引，持久化消息、群组、授权与传输记录)
   └─ 系统集成 (System): 系统托盘、桌面通知、全局快捷键、内置 OCR 调度与窗口管理
```

| 通道 / 模块 | 传输方式 | 默认端口 | 主要用途 |
|---|---|---|---|
| 节点发现 | UDP 广播 / 单播 | 17878 | 上线广播、在线应答、心跳保活、离线通知与共享网段交换 |
| 控制与短消息 | UDP + ACK 重传 | 17878 | 文本消息、送达回执、撤回指令、窗口震动、群控制、文件柜元数据 |
| 长文本通道 | TCP 直连 | 17879 | 超过 UDP MTU 大小的超长文本消息回退通道 |
| 文件与数据传输 | TCP 直连 | 17879 | 文件与文件夹分块校验直传、文件柜数据上行与下行、局域网 P2P 自更新包拉取 |

节点发现机制参考 IP Messenger 的上线广播与应答思想，通信协议采用自主设计的 UTF-8 JSON 格式，独立于传统 ipmsg 协议。

## 安全性

- **网络边界明确** —— 所有通信严格限制在局域网内部；启动时全局追加 `--no-proxy-server` 阻断系统与环境代理；应用内零外部请求、零数据上报、零自动检查更新。
- **最小化攻击面** —— 渲染进程仅加载本地受控打包资源，杜绝远程页面注入；强制开启 `contextIsolation` 与 Chromium 沙箱，禁用 `nodeIntegration`；全局拦截页面跳转与新窗口创建；配置严格的内容安全策略（CSP）。
- **不可信输入防护** —— 网络层接收的所有报文均执行严格的格式与长度白名单校验；对未知报文类型采取平滑忽略策略，保证安全性与向前兼容；聊天内联图片实行单边 ≤8192px 且总像素 ≤3200 万的边界校验，避免解码引起内存溢出。
- **本地落盘防护** —— 接收文件名执行全路径穿越清洗；文件保存严格落在用户指定目录或隔离子目录，采用重名自动编号处理，杜绝覆盖既有文件；文件柜上传仅允许写入对方指定的独立子目录。
- **运行日志脱敏** —— 消息正文与传输文件内容绝不写入任何日志文件，仅记录消息 ID、状态码、文件体积等基础审计元数据。
- **物理内网信任模型** —— 沿用 IP Messenger / iptux 等经典工具的局域网明文传输模型，适合在边界受控的公司内网、隔离办公区或专用实验室网络中运行。

## 参与开发

想自己编译、修改代码，或在本机多实例联调，请参阅 **[CONTRIBUTING.md](CONTRIBUTING.md)** —— 源码构建、运行环境、开发红线与调试方法均在此列明。

想了解整体架构、模块分层职责与二次开发扩展点，请参阅 **[DEVELOPMENT.md](DEVELOPMENT.md)** —— 架构图解、数据流向与设计决策均在此列明。

**界面语言设置**：可在「设置 → 通用 → 语言 / Language」自由切换简体中文或 English，即时对所有窗口生效。

完整文档索引与英文版规范见 **[docs/README.md](docs/README.md)**。

如遇问题或有功能建议，欢迎在 [Issues](https://github.com/nameGXF/teahouse/issues) 提交反馈。

## 参考项目

- [IP Messenger](https://ipmsg.org/) — 局域网即时通信协议鼻祖
- [iptux](https://github.com/iptux-src/iptux) — Linux 环境下流行的局域网通信工具
- 飞秋（FeiQ）、内网通 — Windows 平台广泛使用的局域网即时通信产品，提供了优秀的产品形态参考

## 第三方资源

渲染层标准表单与操作组件选用 [Naive UI](https://github.com/tusen-ai/naive-ui) 2.43.2（本地构建，MIT）；内置头像与 emoji 兼容显示采用 [Twemoji](https://github.com/jdecked/twemoji) SVG 图形子集（本地打包，CC-BY 4.0）；内置离线 OCR 采用 PaddleOCR 模型与 onnxruntime-web。完整第三方开源声明详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

Copyright © 2026 skyjt。

从 0.37.0 起，茶话间自身的源码与二进制分发采用 [GNU General Public License v3.0 only](LICENSE)（SPDX：`GPL-3.0-only`）。0.36.8 及更早版本已经授予的 MIT 权利继续有效。第三方组件与图形资源仍遵循 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中列出的各自许可证。
