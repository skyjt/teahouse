# 茶话间代码优化方案（决议 #200/#231）

> [简体中文](optimization-plan.md) · [English](en/optimization-plan.md)

> 审查基线：`main` @ `36823fc`（v0.32.3，2026-07-09）。全部行号引用以该版本为准，执行时如有漂移以描述定位。
> 本文是**优化工作的唯一待办清单**：跟进优化的 AI 代理从这里开工，逐项执行、逐项回写状态。
> 审查范围：主进程全部（net / store / services / ipc / windows / util）、preload、shared、渲染层 stores 与核心组件、构建配置、测试布局。

---

## 0. 执行者必读（开工前，不可跳过）

### 0.1 必读文件

按顺序读完再动手：`AGENTS.md`（9 条红线）→ `CLAUDE.md` → `docs/handoff.md` → 本文。

### 0.2 红线速查（本方案范围内最容易踩的几条）

1. **`electron` 锁死 `22.3.27`，所有依赖精确锁版本，永不 `npm update`**。本方案**所有条目都不需要新增或升级任何依赖**——如果你觉得需要装包，说明方案理解错了，停下来重读。
2. 主进程 = Node 16.17（无 `fetch`/`structuredClone`）；渲染层 = Chrome 108（无原生 CSS 嵌套等新语法）。构建目标已写死，越线会在 typecheck/build 阶段炸。
3. 分层铁律：`renderer/` 不 import electron/node；`net/`、`store/` 零 Electron 依赖；`ipc` 层只做校验转发。
4. **本方案没有任何一项需要改线上协议**（`docs/protocol.md` / `shared/protocol.ts` 的报文格式、常量、时序均不动）。若执行中你认为要改协议，停下来，说明对改动的理解有误。
5. 网络层（`src/main/net/`）任何行为改动**必须有对应回环集成测试**，测试必须 `bindAddress: '127.0.0.1'` + `broadcastTargets: []`。
6. 数据库迁移**只追加**（`migrations.ts` 数组 push 新项），永不修改已发布的旧迁移。

### 0.3 工作流程（每一项都按这个走）

1. 直接在 **`main`** 分支上工作（决议 #201：原 dev-claude 分支已废弃删除，不再新起开发分支）。
2. 一个 OPT 条目 = 一个完整增量：涉及文档的先改文档 → 改代码 → **`package.json` patch +1**（本方案全部条目按决议 #73 属 bug 修复/性能微调，patch +1；文档-only 条目不递增版本）→ 五连验证 → 一个中文 commit（`fix:`/`refactor:`/`docs:`/`test:` 前缀，消息中带 OPT 编号）。
3. 五连验证，全过才算完成：

```bash
npm test && npm run test:db && npm run typecheck && npm run build && npm run smoke
```

   （smoke 会在屏幕上闪一个窗口约 1.5 秒，正常现象。）
4. 完成一项后**回写本文该条目的「状态」行**（`待办` → `已完成（vX.Y.Z / commit 短哈希）`，如放弃写 `搁置（原因）`），与代码同一个 commit 提交。
5. 严格按条目边界执行，**不要顺手改无关代码**，不要把多个 OPT 混进一个 commit（明确标注可合并的除外）。
6. 拿不准就停：宁可搁置并写明原因，不要猜。

### 0.4 全局禁止事项

- 不新增依赖、不升级依赖、不动 `.npmrc` / `tsconfig` / `electron.vite.config.ts` 的目标基线。
- 不改协议报文与 `LIMITS`/`TIMINGS` 等线上常量（OPT-1 只是让代码回归已有常量 `GROUP_MAX_MEMBERS`）。
- 不引入组件库 / CSS 框架；UI 外观不许变化（本方案渲染层条目全部是"行为与外观完全不变，只降开销"）。
- 不实现 requirements §3 非目标清单里的任何东西；不碰内网通兼容（决议 #199 暂缓）。

---

## 1. 总体评价（审查结论摘要）

代码整体质量**高于同规模项目平均水平**：分层清晰且执行到位（net/store 确实零 Electron 依赖、可直接 vitest 实例化）、入站白名单校验完整、注释与决议编号对应良好、启动自愈/降级链（文件库→内存库）等健壮性设计到位。以下设计是**有意为之，不要"优化"它们**：

- better-sqlite3 同步 API（主进程单线程顺序访问，最简单可靠）；
- JSON 明文协议、无加密（决议 #5，非目标）；
- 发送端断点续传时整文件重读哈希（v0.12.1 有意取舍：避免大文件先整盘预读）；
- `.npmrc` 三件套、`legacy-peer-deps`、`@types/node` 锁 16。

问题集中在四个区域：**① 决议 #198（群 200 人）落地不完整留下的真 bug；② 文件传输数据面的健壮性（未捕获异常可崩主进程、fd 泄漏、无接收背压）；③ `messages` 表索引缺失导致的一组 O(N) 热路径（随聊天记录增长线性劣化，是长期使用后"越用越卡"的最大来源）；④ 渲染层 ChatPane 的整列表重渲染模式（含一个 500ms 定时器驱动的常态重渲染）。**

---

## 2. 优化项清单

优先级定义：P0 = 正确性/稳定性 bug，尽快修；P1 = 用户可感知的性能问题；P2 = 防劣化与开销收敛；P3 = 质量/文档/测试补齐。

---

### OPT-1 【P0·bug】决议 #198 群上限 200 落地不完整：IPC 与备份导入仍卡旧上限

- 状态：已完成（v0.32.4 / 13758e9）
- 涉及：`src/main/index.ts`、`src/main/services/porter.ts`；难度：小；commit 类型：`fix:`
- **问题**：#198 把 `GROUP_MAX_MEMBERS` 提到 200，但四处硬编码旧上限没跟上：
  1. `src/main/index.ts:1826` `groupCreate` handler：`memberIds.length > 64` 直接返回 null——UI（GroupCreator 已按 200 放开选人）选择 65 人以上建群时**静默失败**；
  2. `src/main/index.ts:1849` `groupUpdate` 的 `ids()`：add/remove 数组 `.slice(0, 64)`——一次添加超过 64 人被静默截断；
  3. `src/main/index.ts:1873` `groupSend`：mentions `.slice(0, 50)`——@ 超过 50 人被截断（codec 校验上限是 `GROUP_MAX_MEMBERS`）；
  4. `src/main/services/porter.ts:371` `importGroup`：成员 `.slice(0, 50)`——**导入备份时大群成员表被截断到 50 人**，且被截断的成员不会知道自己被移出，后续 LWW 同步会把错误成员表扩散出去。
- **方案**：四处统一改用 `GROUP_MAX_MEMBERS`（index.ts 已 import 自 `shared/protocol`；porter.ts 需补 import）。校验语义保持"超限拒绝或截断"原样，只换数字来源。
- **验收**：
  - `src/main/services/groups.test.ts` 补一条：`createGroup` 传 150 个成员 → 成员数 = 151（含自己）；
  - `src/main/store/db-selftest.ts` porter 段补一条：导出→导入含 120 成员的群，导入后成员数不变；
  - 五连验证全过。IPC 层两处改动靠 code review 确认（vitest 无法起 Electron ipcMain）。
- **注意**：`shared/protocol.ts` 的常量与 codec 本来就是 200，**不要动协议层**。修完在 `docs/requirements.md` §11 加一行变更记录（引用 #198，说明补齐 IPC/导入层）。

---

### OPT-2 【P0·稳定性】文件接收落盘的同步 fs 调用未捕获异常，可直接崩掉主进程

- 状态：已完成（v0.32.5 / e7b34f5）
- 涉及：`src/main/net/transfer.ts`；难度：小；commit 类型：`fix:`
- **问题**：`pullTransfer()` 里 `mkdirSync`（:256/:260）、`renameSync`（:328）、`rmSync` 都跑在 socket 事件回调内，**没有 try/catch**。目标目录不可写、中间路径被文件占位（ENOTDIR）、传输中保存目录被删等情况会抛出未捕获异常 → Electron 主进程崩溃弹窗。接收端 `existing`/`stream` 错误路径有处理，唯独这些同步调用是裸的。
- **方案**：把 `next()` 内的 `mkdirSync` 两处、`done` 帧回调内的 `renameSync(item.partPath, dedupeTargetPath(item.finalPath))` 用 try/catch 包住，失败走既有 `fail('write-error')`（rename 失败时同时 `rmSync(partPath, { force: true })` 清理，注意 rmSync 本身也要包）。`statSync` 已在 try 内的不动。
- **验收**（网络层行为改动，必须回环测试）：`src/main/net/transfer.test.ts` 新增用例——`saveDir` 下先放一个**文件** `x`，接收计划里给出 `relPath: 'x/y.bin'`（mkdirSync 必抛 ENOTDIR）：修复前进程会抛未捕获异常，修复后断言 `pullTransfer` reject 且 reason 为 `write-error`，测试进程存活。五连验证全过。
- **注意**：不要改协议帧、不要动发送端；`fail()` 的清理语义保持现状。

---

### OPT-3 【P0·资源泄漏】发送端 socket 中断后读流不销毁：fd 泄漏 + 流永久挂起

- 状态：已完成（v0.32.6 / 77a2fd3）
- 涉及：`src/main/net/transfer.ts`（`TransferServer.serve`，:67-171）；难度：中；commit 类型：`fix:`
- **问题**：`serve()` 供流过程中，若接收方中途断开（取消/崩溃/断网）：`sendDataChunk` 里 `socket.write` 返回 false → `stream.pause()` 并等 `socket.once('drain')`——但 socket 已销毁，`drain` 永不触发，**读流永久 pause、文件 fd 泄漏**（断点续传路径的 `hashStream` 也会白读整个大文件）。每次被中断的发送泄漏 1-2 个 fd，长期运行的办公机会累积。
- **方案**：在 `serve()` 内跟踪当前活动流（`let activeStreams: Array<ReturnType<ReadStreamFactory>> = []`，开流时登记、`finish` 时清空），给 socket 挂 `close` 处理：`socket.on('close', () => { for (const s of activeStreams) s.destroy(); activeStreams = [] })`。同时复位 `busy`（连接已关，复位只是卫生）。
- **验收**（必须回环测试）：`transfer.test.ts` 新增——利用已有的 `openReadStream` 注入点（`TransferServer` 构造第 4 参）注入可观测流（记录每个流实例），接收端拉取大 payload 中途 `socket.destroy()`，断言发送端所有已打开的读流 `destroyed === true`。既有传输用例全过，五连验证全过。
- **注意**：正常完成路径流自己关；destroy 已结束的流是 no-op，安全。

---

### OPT-4 【P0·内存】接收端写盘无背压：快网络 + 慢磁盘时内存无界增长

- 状态：已完成（v0.32.7 / 44ded19；**决议 #205 补丁 v0.32.21** 修多文件死锁）
- 涉及：`src/main/net/transfer.ts`（`pullTransfer` raw 回调）；难度：中；commit 类型：`fix:`
- **问题**：接收裸流回调里 `current.stream.write(chunk)` 忽略返回值，socket 不暂停。千兆内网收 10GB 文件写入慢盘（USB 盘/网络盘/老机械盘）时，写缓冲在内存里无界堆积，最坏可达 GB 级 → OOM 或系统卡死。发送端有对称的背压处理，接收端漏了。
- **方案**：raw 回调中 `write` 返回 false 时 `socket.pause()`，`drain` 后 resume；并用 `socketPaused` 去重监听。
- **#205 补丁**（CI 发现）：Node Writable 在 `end()`/`finish` 路径上**可能不再 emit `drain`**。若上一文件因写盘背压 pause 了 socket、done 处理时调用 `stream.end()` 吞掉 drain，socket 永久 pause → 下一文件 `pull-ok` 读不到死锁。修复：在 `done` / `fail` / `succeed` 路径显式 `resumeSocket()`；`TransferServer.stop` 强制销毁连接。
- **验收**（必须回环测试）：可选 `openWriteStream?` 注入慢写流；单文件 5MB 背压用例 + **多文件 + 慢写盘**回归用例（#205）全过，五连验证全过。
- **注意**：`files.ts` 调用处不需要变（注入点可选）。不要给 socket.pause 加超时逻辑——写流出错已有 `write-error` 路径兜底。
- **验收备注（2026-07-09，v0.32.22）**：#205 的「多文件 + 慢写盘」用例依赖回环时序，快盘机器上锁不住死锁（修复前代码也能通过）；已补**确定性**回归用例（手工帧服务端单包写出 `pull-ok+裸流+done` + 1 字节水位写流），验证过修复前必死锁超时、修复后必通过。首轮验收（v1.3）放行 OPT-4 时未推演出 end() 吞 drain 的路径，属验收失误，引以为戒。

---

### OPT-5 【P1·性能/存储】`messages` 表缺 seq 索引：插入与分页随历史量线性劣化（"越用越卡"的最大来源）

- 状态：已完成（v0.32.8 / 30250ec）
- 涉及：`src/main/store/migrations.ts`、`docs/tech-design.md` §5；难度：小；commit 类型：`fix:`（文档先行）
- **问题**：`messages` 只有 `idx_messages_conv (conv_id, ts, seq)`（`migrations.ts:54`），导致三组热路径全表/全会话扫描：
  1. **每次插入消息**执行 `SELECT COALESCE(MAX(seq), 0) + 1 FROM messages`（`msg-repo.ts:88`）——seq 无索引，**每条消息插入都全表扫**。10 万条历史时每次收发消息都要扫 10 万行；
  2. 分页 `WHERE conv_id = ? [AND seq < ?] ORDER BY seq DESC LIMIT ?`（`msg-repo.ts:89-97`）与搜索跳转 `around()`——索引第二列是 ts，按 seq 排序无法走索引，退化为该会话全量扫描 + 排序；
  3. 会话列表 preview 子查询 `ORDER BY m.seq DESC LIMIT 1`（`conv-repo.ts:71-78`）——**每收一条消息就会对每个会话做一次全量扫描**（`emitConvs` 每条消息触发，见 OPT-15），复合放大。
- **方案**：
  1. 先改 `docs/tech-design.md` §5 库表章节：迁移清单补 v10 说明（两个索引 + 动机），变更记录留痕；
  2. `migrations.ts` 数组**追加**（不动旧项）：

```sql
-- v10：消息 seq 索引（决议 #200 / OPT-5）：MAX(seq) 取号与按 seq 分页/预览不再全表扫
CREATE INDEX idx_messages_seq ON messages(seq);
CREATE INDEX idx_messages_conv_seq ON messages(conv_id, seq);
```

  3. 代码零改动（SQLite 查询计划自动受益）。不要删旧索引 `idx_messages_conv`（会话内时间范围查询 `search.conversation` 仍依赖）。
- **验收**：`npm run test:db`（db-selftest 在真实 Electron ABI 上跑迁移）；`npm test` 中 fts/repo 相关用例全过；对旧库文件启动一次确认 `user_version` 升到 10 且历史查询正常。五连验证全过。
- **注意**：迁移**只能 push 到数组末尾**。handoff.md 里"迁移 v8"的过期表述由 OPT-16 统一修。

---

### OPT-6 【P1·性能/存储】备份导入 O(n²)：每行重新 prepare + 每条消息全表 MAX(seq)

- 状态：已完成（v0.32.9 / b0e7e63）
- 涉及：`src/main/services/porter.ts`（`importBackup` 及各 `importXxx`，:298-484）；难度：中；commit 类型：`fix:`
- **问题**：导入事务里**每一行都重新 `db.prepare()`**（`importMessage` 一条消息 prepare 4 次：exists 查询 :457、insert :463、FTS :479、conv bump :481；peers/groups/convs/transfers/stickers 同病）。且 insert 的 seq 用子查询 `(SELECT COALESCE(MAX(seq),0)+1 FROM messages)`（:465）——配合无索引即 O(n²)：往已有 5 万条的库导入 5 万条备份是数十亿行扫描级的工作量，用户面对的是导入卡死几分钟到几十分钟（期间主进程同步阻塞，整个应用无响应）。
- **方案**：
  1. 在 `importBackup()` 开头（事务外）一次性 prepare 全部语句，作为局部变量传给各 import 函数（或 constructor 字段化）；
  2. seq 改为：事务开始时查一次 `MAX(seq)`，之后内存自增，insert 直接绑定数值（主进程单线程 + 单事务内，无竞争）；
  3. 行为保持不变：仍按 id 幂等跳过、仍写 FTS、仍 bump 会话 last_ts。
- **验收**：`npm run test:db`（porter 段导入导出往返用例必须全过）；db-selftest 补一条量级日志：2 万条消息备份导入耗时打印（不设硬阈值，供回归肉眼比对）。五连验证全过。
- **注意**：OPT-5 的索引先落地，本条收益才完整。两条分开 commit。

---

### OPT-7 【P1·性能/主进程】每条入站消息用全量会话列表查 muted

- 状态：已完成（v0.32.10 / a5c32d4）
- 涉及：`src/main/index.ts:1080`、`src/main/services/chat.ts`；难度：小；commit 类型：`fix:`
- **问题**：`notifyIncoming()` 判断免打扰用 `chat?.listConversations().find(...)`——每条入站消息（含群消息扇入）都全量拉会话列表（每个会话还带 preview 子查询，OPT-5 第 3 组扫描），只为读一个 `muted` 布尔。
- **方案**：`ChatService` 已有私有 `isConversationMuted(convId)`（`chat.ts:509-511`）——公开它（或新增公开 `isMuted`），`notifyIncoming` 改调。
- **验收**：`chat.test.ts` 补一条直接断言（muted 会话返回 true）；五连验证全过。

---

### OPT-8 【P1·性能/渲染】ChatPane 撤回倒计时 500ms 定时器驱动整列表常态重渲染

- 状态：已完成（v0.32.11 / 1bb4249）
- 涉及：`src/renderer/src/components/ChatPane.vue`（:319-320 定时器、:1095-1117 倒计时函数、:1694-1696 模板绑定）、`src/renderer/src/components/ImageBubble.vue`；难度：中；commit 类型：`fix:`
- **问题**：`nowTs` 是响应式 ref，`setInterval` 每 500ms 更新（无条件常驻）。模板对每条图片/表情消息绑定 `:recall-disabled="!canRecallMessage(msg)"`、`:recall-label="recallButtonLabelFor(msg)"`，两者都读 `nowTs` → **只要当前会话有任意一条图片消息，整个消息列表 render 每 500ms 重跑一次**（所有消息的 `textParts`/`splitEmojiText` 全部重算 + 全列表 vdom diff）。Win7 软渲染机器上是常态 CPU 开销，会话越长越贵。
- **方案**（外观与交互完全不变）：
  1. ChatPane 倒计时定时器改为**仅在右键菜单打开期间运行**（`msgMenu` null → 非 null 启动，关闭清除）；菜单里的 `recallButtonLabel`/`recallButtonDisabled` 逻辑不变；
  2. ImageBubble 自己算撤回标签：ChatPane 不再传 `recall-disabled`/`recall-label` 两个时变 props，改传静态的 `recall-visible` 与**非时间因素**禁用原因（`mediaRecallDisabledReason(msg)` 结果字符串）；ImageBubble 内部持有自己的 `nowTs` + interval，**仅在其悬浮菜单展开时启动**，标签格式复用现有 `撤回（mm:ss）`/`撤回（超时）`/`撤回（原因）` 文案（时间部分逻辑抽成 utils 纯函数共用）；
  3. 点击撤回的即时判定（`recallMessage` → `canRecallMessage`）改用 `Date.now()` 直接计算，不依赖响应式 `nowTs`。
- **验收**：手测三点——右键文本消息菜单倒计时仍每约 0.5s 刷新；图片悬浮菜单撤回项倒计时正常、超时变灰；菜单全关时 devtools Performance 确认无 500ms 周期重渲染。`npm test` + 五连验证全过。
- **注意**：先读 `ImageBubble.vue` 现有 props/菜单结构再动手；不改撤回时窗常量与文案。

---

### OPT-9 【P1·性能/渲染】消息列表整体重渲染：抽 MessageRow 行组件

- 状态：已完成（v0.32.12 / 0292385）
- 涉及：`src/renderer/src/components/ChatPane.vue`（模板 :1667-1756）、新增 `src/renderer/src/components/MessageRow.vue`；难度：大（谨慎执行）；commit 类型：`refactor:`
- **问题**：消息列表是巨型内联 `v-for`（:1667），任何触发 ChatPane 重渲染的状态变化（新消息、任一条状态变化、输入区/浮层状态）都会**重跑所有行的渲染函数**：每行的 `textParts()`（正则 matchAll）、`splitEmojiText()`、`needSeparator()` 全部重算。50 条一页尚可，向上翻几页（几百条 DOM）后每次变化都是全量 vdom 重建。
- **方案**：把 `v-for` 循环体抽成 `MessageRow.vue` 子组件（Vue 对子组件按 props 变化跳过重渲染）。要点：
  - props（粗粒度、引用稳定）：`msg`（对象引用；store 原地改 status 仍可触发行内更新）、`prevTs`（供时间分隔线，替代 `needSeparator(msg, index)`）、`isGroupConv`、`senderName`、`senderAvatar`、`highlighted: boolean`（父级算好传布尔，避免所有行依赖 highlightId）、`canSendPk`、`recallVisible`/`recallDisabledReason`（衔接 OPT-8 静态 props）；
  - emits：`contextmenu`（event+msg）、`forward`、`recall`、`participate-pk`、`resend`；
  - `textParts`/`splitEmojiText` 移入 MessageRow 内 `computed`，随行缓存；
  - 时间分隔线 `<div class="sep">` 与状态 hint 行一并移入 MessageRow（模板结构、类名、样式**逐字保留**，scoped 样式相应搬移）。
- **验收**：外观与交互零变化（对照改前逐项核对：分隔线、群发送者行、头像、气泡右键、链接点击、图片/文件/PK 气泡、状态图标、失败重发点击、高亮动画）；`npm test` 全过；五连验证全过；手动冒烟：单聊 + 群聊各收发一轮，历史向上翻页正常。
- **注意**：本方案改动面最大的一项，**单独 commit，改坏立即回滚重来**，不夹带其他优化。OPT-8 先完成再做本项。

---

### OPT-10 【P2·性能/渲染】长会话消息数组无上限：贴底时裁剪

- 状态：已完成（v0.32.13 / 8e4fe81）
- 涉及：`src/renderer/src/stores/chat.ts`、`src/renderer/src/components/ChatPane.vue`；难度：中；commit 类型：`fix:`
- **问题**：`loadEarlier()` 向上翻页只增不减；长时间挂机 + 活跃群持续追加。翻过几千条后 DOM 节点数与 vdom 成本一路上涨（决议 #192 的"重进会话重载 50 条"只在重进时兜底，会话持续打开时无保护）。
- **方案**：在 ChatPane 现有"尾部追加且贴底"侦听（:496-512）里加裁剪：`isNearBottom()` 且非 `viewingHistory` 且列表长度 > 400 时，调用 store 新增 action `trimConversationHead(convId, keep = 300)`（splice 后**必须**按 `setConversationMessages` 的方式重建消息缓存）。用户在底部时头部裁剪不可感知；`loadEarlier` 语义不受影响（裁掉的还能再翻回来）。
- **验收**：手测——长会话（dev 双实例灌 500+ 条）持续接收时列表长度稳定在 ~300-400；向上翻页仍能加载更早消息；历史搜索跳转不受影响（`target` 模式不裁剪）。`stores/chat.test.ts` 补 trim 的缓存一致性断言（`byId`/`ids` 与 list 同步）。五连验证全过。
- **注意**：只在贴底路径裁剪；`viewingHistory`、`target` 高亮期间绝不裁剪。在 OPT-9 之后做。

---

### OPT-11 【P2·性能/网络】`scanHosts` 每个地址一个 setTimeout：大扫描一次性创建上万定时器

- 状态：已完成（v0.32.14 / de9cc55）
- 涉及：`src/main/net/discovery.ts:181-187`；难度：小；commit 类型：`fix:`
- **问题**：`scanHosts()` 对每个主机 `setTimeout(..., i * delay)`——设置页单网段扫描与自动后台扫描（`index.ts:809-816`）都走它，单网段最多 1024 个定时器，多网段自动扫描可叠到上万，一次性全量分配。主界面全局刷新已用正确的泵式模式（`startGlobalRangeScan` 单定时器链，`index.ts:743-767`），两处不一致。
- **方案**：`scanHosts` 改为单定时器泵：内部索引推进，每 tick `probe` 一个地址后 `setTimeout(tick, hostDelayMs)`；返回值仍为地址总数（签名兼容）。顺带用内部 generation 计数支持中止（新一轮使旧泵自然停止）。
- **验收**（必须回环/单测）：`discovery.test.ts` 既有用例全过；补一条 fake timers 用例——扫 100 个地址时任意时刻活跃定时器数为 1（`vi.useFakeTimers` + 逐步推进断言 probe 次数递进）。五连验证全过。
- **注意**：限速语义（默认 8ms/地址、自动扫描 62ms/地址）必须保持。
- **验收备注（2026-07-09）**：generation 中止带来一个轻微语义变化——多次调用 `scanHosts` 由"并行各扫各的"变为"新一轮中止上一轮"；若两个自动后台扫描恰好同刻触发，先启动的会被中止且因 `lastAutoScanAt` 已标记、12 小时内不补扫。触发概率低（30–90 分钟随机抖动窗口）、后果轻（下个 12h 周期补扫 + gossip/手动刷新兜底），接受现状；若未来观察到网段长期漏扫，再改为把多网段主机列表合并进同一泵。

---

### OPT-12 【P2·性能/主进程】`PeerRegistry.list()` 每次调用带中文排序：非 UI 调用方不需要

- 状态：已完成（v0.32.15 / cde849c）
- 涉及：`src/main/net/peer-registry.ts:121-126` 及各调用方；难度：小；commit 类型：`fix:`
- **问题**：`list()` 每次 `[...values()].sort(localeCompare(…,'zh-Hans-CN'))`。带 locale 参数的 `localeCompare` 每次比较都走 Intl 查找，比缓存 `Intl.Collator.compare` 慢一个量级；且多数调用方不需要排序：presence 单播（每 30s，`discovery.ts:199`）、gossip、`announceProfile`、退出单播、`peersRepo.upsertMany(registry.list())` 持久化（`index.ts:1006`）、RangeSync `shareNow`、updater 候选（`index.ts:555`）。
- **方案**：
  1. 模块级 `const zhCollator = new Intl.Collator('zh-Hans-CN')`，`list()` 排序改用 `zhCollator.compare`；
  2. 新增 `values(): PeerRecord[]`（不排序）；上列非 UI 调用方全部换 `values()`（UI 投影 `peerViews()`、搜索 `search.ts` 保留 `list()`）。
- **验收**：`discovery.test.ts`/`messenger.test.ts` 全过；grep 确认每个调用方的选择有明确理由；五连验证全过。

---

### OPT-13 【P2·性能/主进程】`search.conversation` 每次查询动态 prepare

- 状态：已完成（v0.32.16 / 783771e）
- 涉及：`src/main/services/search.ts:171-178`；难度：小；commit 类型：`fix:`
- **问题**：会话内历史搜索每次（200ms 防抖后）都拼 SQL 并 `db.prepare()`。子句组合是有限集（≤24 种）。
- **方案**：类内 `Map<string, Statement>` 以 SQL 文本为键缓存 prepared statement。
- **验收**：db-selftest 搜索段全过；五连验证全过。

---

### OPT-14 【P2·清理】网络/服务层小项打包（一个 commit）

- 状态：已完成（v0.32.17 / 96a49b5）
- 涉及：`messenger.ts` / `udp.ts` / `files.ts` / `discovery.ts`；难度：小；commit 类型：`fix:`
- **问题与方案**（合并一个 commit，逐项核对）：
  1. **（可选，收益小）**`messenger.ts:161` 同一信封 `JSON.stringify` 判长 + `udp.send` 内部再 `encode()` 序列化一次——如做：先 `encode(env)` 得 Buffer 按长度判限并复用；必须保持 `UdpChannel.send(env)` 公有签名兼容，"超长文本走 TCP 控制帧"既有用例必须过；嫌风险大可跳过并在状态行注明；
  2. `messenger.ts:183-196`：收件人不在注册表时（从未见过的群成员），重试循环白等 1+2+4s 才入队——`step()` 首次发现 `registry.get(peerId)` 为空直接了结（TCP 兜底同样拿不到地址，结局必然 queued）。**补回环测试**：向未知 peerId `sendUserMessage`，断言快速返回 `queued`；
  3. `messenger.ts` `cancelledQueued` 键残留（撤回一条已送达消息即永久残留）：`dropQueuedMessage` 里仅当 `this.pending.has(key) || this.flushing.has(peerId)` 时才加入 set（其余场景 `queue.remove` 已足够）；
  4. `udp.ts` `buckets` 令牌桶 Map 无清理——惰性清理：`onMessage` 时若 `buckets.size > 2048`，删除 `last` 距今超 10 分钟的桶；
  5. `files.ts` `finish()` 里补 `lastEmit.delete(transferId)`；`incoming` 保留 failed 是断点续传有意行为（**不要删**）；
  6. `discovery.ts:131` gossip 洗牌 `sort(() => Math.random() - 0.5)` 有偏——换 Fisher-Yates。
- **验收**：`messenger.test.ts`/`discovery.test.ts` 全过 + 第 2 点新增回环用例；五连验证全过。

---

### OPT-15 【P2·性能/主进程】`emitConvs` 每事件全量查询 + 全量 IPC 推送：微任务合并

- 状态：已完成（v0.32.18 / f74e0e0）
- 涉及：`src/main/services/chat.ts:505-507`、`groups.ts:367-369`、`files.ts:1039-1041`；难度：小；commit 类型：`fix:`
- **问题**：三个服务的 `emitConvs()` 每次触发都全量查会话列表并整表推渲染层；单条消息处理链路可能触发多次，群消息扇入更密。OPT-5 后单次查询已便宜，但 IPC 序列化与渲染刷新仍按次付费。
- **方案**：三处各自加微任务合并（`convsScheduled` 标志 + `queueMicrotask`），同一同步批次合并为一次查询 + 一次推送。渲染层 `onConvsUpdated` 是整表替换，语义无损。
- **验收**：依赖 `convs` 事件的测试注意时序（事件变异步，允许调整测试等待方式，不允许放宽断言）；五连验证全过。
- **注意**：`queueMicrotask` Node 16 可用。若测试大面积依赖同步时序导致改动扩散，允许降级为"仅 ChatService 合并"并在状态行说明。

---

### OPT-16 【P3·文档】文档漂移修正（纯文档，不递增版本）

- 状态：已完成（纯文档 / 49e6498）
- 涉及：`docs/handoff.md`、`docs/requirements.md`、`docs/tech-design.md`、`docs/ui-design.md`；难度：小；commit 类型：`docs:`
- **问题**：
  1. **OCR 引擎表述过期**：handoff §5 等四处文档仍写旧 OCR 引擎名，实际代码是**内置 PaddleOCR（PP-OCRv6 tiny，onnxruntime-web 本地 wasm）**——`src/renderer/src/utils/paddleocr/`、`build/ocr/*.onnx`、`scripts/prepare-ocr-assets.mjs`。逐处核对改写（`electron.vite.config.ts` 注释里的类比可保留）；
  2. **迁移版本表述过期**：handoff §1"迁移 v8"与代码地图"migrations(v8·只追加)"——实际已 v9（OPT-5 后 v10），改为随实际版本或写"见 migrations.ts"；
  3. 各文档变更记录留痕。
- **验收**：全文搜索旧 OCR 引擎名，仅剩历史决议记录中的合理引用；跑 `npm test` 确认无副作用。

---

### OPT-17 【P3·质量】index.ts 图片发送四个 IPC handler 重复逻辑收敛

- 状态：已完成（v0.32.19 / 7cabe69）
- 涉及：`src/main/index.ts:1582-1636`；难度：小；commit 类型：`refactor:`
- **问题**：`imgSendBytes`/`groupImgSendBytes` 与 `imgOfferPath`/`groupImgOfferPath` 两两只差目标参数与调用的 files 方法，~40 行重复；`IMG_EXTS` 在 `index.ts:159` 与 `ChatPane.vue:1184` 各一份。
- **方案**：主进程内抽私有函数（`stageImageBytes` + 参数校验小函数），四个 handler 收敛为薄壳；`IMG_EXTS` 提为 `src/shared/` 常量（shared 只放类型与常量，符合分层），主进程与 ChatPane 共用。
- **验收**：行为完全不变（校验边界一致：64/128/2048 长度、20MB、扩展名回退 .png）；五连验证 + 手动冒烟：粘贴截图、拖图、群聊发图各一次。
- **注意**：IPC 层只做校验转发的红线不变，抽的函数放 index.ts 内部即可，不新建 service。

---

### OPT-18 【P3·测试】测试补齐：range-sync 与 peer-registry 缺专项测试

- 状态：已完成（v0.32.20 / fad9333）
- 涉及：新增 `src/main/net/range-sync.test.ts`、`src/main/net/peer-registry.test.ts`；难度：中；commit 类型：`test:`
- **问题**：网络层唯二没有专项测试的模块。`peer-registry.ts` 的**地址漂移防护规则**（在线节点不接受源地址漂移、离线换址必须带完整 profile，`peer-registry.ts:53-60`，防伪造关键闸门）无直接断言。
- **方案**：
  - `peer-registry.test.ts`：seed 幂等、touch 新节点、在线地址漂移拒绝、离线带 profile 换址接受、离线不带 profile 拒绝、profileRev 旧值不回退、sweep 判定、online 事件时序（字段先更新后 emit）；
  - `range-sync.test.ts`：回环两实例（127.0.0.1 + `broadcastTargets: []`，timings 注入缩短抖动）——上线触发延迟分享、`acceptRanges` 收到去重后的合法 CIDR、非法/重复 CIDR 被滤、`stop()` 后无残留定时器。
- **验收**：新测试稳定通过（无真实网络发包、无长 sleep——用注入 timings + fake timers）；五连验证全过。

---

### OPT-19 【P1·低性能平台】Win7 / UOS 第一批渲染、OCR、图片 I/O 与资源预算收敛

- 状态：已完成（v0.39.3 / 本提交）
- 涉及：`src/main/index.ts`、`src/shared/ipc.ts`、renderer 根组件 / 样式 / 资源、`scripts/check-renderer-bundles.mjs`、`scripts/gen-app-icons.mjs`；难度：中；commit 类型：`fix:`
- **问题**：Win7 与 Linux 已默认禁硬件加速，但 renderer 无法获知该画像，剩余浮层仍运行 blur 与大阴影；图片查看器会在小图加载后自动初始化约 18 MiB 的 OCR 资源；图片发送暂存、OCR 图源读取与另存仍有同步大文件 I/O；构建只约束公共 bootstrap，未约束四个根窗口的完整静态 JS / CSS 闭包；renderer 品牌图和文件 atlas 超出实际展示所需尺寸，增加安装体积与解码内存。
- **方案**：`AppInfo` 下发统一 `softwareRendering`；软渲染画像关闭浮层 blur、收紧阴影，小图 OCR 改为手动；图片暂存 / OCR 读取 / 另存切换到 `node:fs/promises`；构建门禁对四个动态根分别计算完整静态闭包并设 JS / CSS 预算；品牌图降到 256px，atlas 降到 512px，同时把品牌派生写入生成脚本。
- **验收**：纯函数测试覆盖运行时画像与 OCR 策略；源码测试锁定异步 I/O 和软渲染 CSS；bundle gate 测试覆盖完整闭包、共享依赖去重和超预算报错；PNG 头测试锁定 256 / 512 RGBA；五连验证全过。Win7 / UOS 实机流畅度与 OCR 手动入口留给目标平台发布前复测。
- **边界**：不改 Electron / Node / Chrome 基线，不新增依赖，不改协议 / 数据库 / 网络，不移除 OCR 功能，不调整正常硬件加速平台的小图自动 OCR。

---

### OPT-20 【P1·低性能平台】滚动媒体惰性加载与主窗口 Naive UI 复用审查

- 状态：已完成（v0.39.4 / 本提交）
- 涉及：`ImageBubble.vue`、`ChatPane.vue`、`EmojiPanel.vue`、renderer UI 源码测试；难度：小；commit 类型：`fix:`
- **问题**：消息列表、聊天记录搜索结果与表情包网格挂载后，屏外图片也会进入浏览器取图 / 解码调度；长会话或大量表情包场景会在滚动容器创建时集中占用 I/O、CPU 与解码内存。主窗口现有 Naive UI 使用边界也需在保留依赖的前提下重新审查，避免为了统一外观把高密度交互全部组件化后增加实例开销。
- **方案**：三个可滚动媒体面统一增加原生 `loading="lazy"` 与 `decoding="async"`；独立看图、截图和首屏品牌资源保持立即加载。Naive UI 审查只登记复用候选：普通输入框与主次按钮后续可迁移，高密度成员复选框、消息工具栏、右键菜单与聊天输入器维持项目实现；本项不修改可见控件。
- **验收**：源码测试锁定三个惰性加载点，同时断言独立看图与截图资源未被误设为 lazy；Node 16 / Chrome 108 类型检查、构建门禁与五连验证全过。
- **边界**：不移除或升级 Naive UI，不新增依赖，不改变图片地址、加载失败占位、点击 / 右键行为、协议、IPC、存储与网络。

---

### OPT-21 【P2·主窗口一致性】讨论组与联系人资料标准控件复用

- 状态：已完成（v0.39.5 / 本提交）
- 涉及：`GroupCreator.vue`、`ProfileCard.vue`、renderer UI 源码测试；难度：小；commit 类型：`refactor:`
- **问题**：两个主窗口子组件仍维护独立的文本框、主按钮与次按钮样式，圆角、焦点环、禁用态和加载态与主窗口既有 Naive UI 主题存在细微差异；重复 CSS 也增加后续明暗主题维护面。
- **方案**：`GroupCreator` 的普通文本字段与页脚操作、`ProfileCard` 的备注字段与资料页操作复用现有 `NInput` / `NButton`；沿用 `App.vue` abstract Provider 和集中主题。密集成员勾选、已选成员标签及专用结构保留轻量节点。
- **验收**：源码测试锁定两个组件的复用边界、原生成员复选框与 Provider 契约；类型检查、构建闭包预算和五连验证全过。
- **边界**：不新增或升级依赖，不改业务调用、字段长度、回车保存、协议、IPC、存储与网络；主窗口完整静态闭包继续受既有预算约束。

---

### OPT-22 【P1·低性能平台】图片像素门禁与有界缩略图缓存

- 状态：已完成（v0.39.6 / 本提交）
- 涉及：shared 图片元数据解析、main 图片发送 / 受限媒体协议 / 派生缓存、renderer 聊天气泡与记录搜索；难度：中；commit 类型：`fix:`
- **问题**：现有 20MB / 10MB 仅限制压缩文件体积，极高像素 JPEG/WebP 仍可能在 Win7/UOS renderer 解码为数百 MiB；聊天气泡与 72px 搜索结果直接读取同一原图，惰性加载只能推迟首次全图解码，重新进入视口仍缺少应用可控的派生缓存。
- **方案**：文件头解析 PNG/JPEG/GIF/WebP/BMP 真实格式与宽高，内联上限为单边 8192px / 总像素 3200 万，异常与超限内容转普通文件；静态大图在接近视口时直接缩小解码为最长边 320px WebP，经受限 IPC 原子写入 128MB LRU 缓存，并通过 `pantry-thumb` 展示。GIF、APNG、动画 WebP 与小图保留原图，独立看图、OCR、复制与收藏统一先过像素门禁。
- **验收**：纯函数覆盖五种格式、动画与边界；缓存测试覆盖原子写入、哈希路径、1MiB / 320px 门禁和 LRU 清理；源码测试锁定共享近视口观察器、resize 解码、缩略图协议与独立看图原图；五连验证和四窗口闭包预算全过。
- **边界**：不新增依赖，不改线上协议 / 数据库 / 原图文件，不缓存动画，不把缩略图写入备份；派生缓存随时可安全删除并按需重建。

---

### OPT-23 【P2·UI】会话右键菜单视口避让

- 状态：已完成（v0.54.4 / 本提交，决议 #294）
- **问题**：会话菜单直接使用指针坐标，靠近窗口底部时后两项被裁切。
- **方案**：DOM 更新后测量菜单实际尺寸，沿用现有菜单的 CSS 像素夹紧方式，在视口四边保留 8px；菜单打开期间随窗口尺寸变化重新定位。
- **验收**：四角、100/110/125% 页面缩放、窗口调整后菜单完整可见；置顶、免打扰、移除确认、10 秒撤回和 Esc 优先关闭保持有效；五连验证通过。
- **边界**：仅修正会话菜单位置，保留布局、样式、事件消费顺序和既有 `webContents` 缩放路径。

---

### OPT-24 【P2·稳定性】全局搜索请求生命周期

- 状态：已完成（v0.54.5 / 本提交，决议 #295）
- **问题**：旧请求晚返回会覆盖新关键词结果；面板卸载未清理防抖定时器，请求失败无法结束加载状态。
- **方案**：保留 200ms 防抖，在关键词变化和面板卸载时清理计时器并使旧回调失效；只提交当前请求的结果和完成状态。加载与失败使用现有占位样式，重新输入可重试。
- **验收**：假时钟覆盖防抖期卸载、请求中卸载、连续输入、乱序返回、旧请求失败与失败后重试；联系人、消息、文件结果及点击跳转保持；五连验证通过。
- **边界**：IPC、SQL、排序、条数限制和输入法路径不变。

---

### OPT-25 【P2·性能】引用与传输状态读取去重

- 状态：已完成（v0.54.6 / 本提交，决议 #296）
- **问题**：每个消息行重复遍历当前消息列表查找引用；多个展示位置同时补载同一页外消息或传输时重复 IPC；较早的传输读取可能覆盖新推送。
- **方案**：复用既有会话消息 ID 索引，为索引替换与按 ID 更新补足 Vue 响应式，引用始终按所属会话查找。历史消息读取、传输 ensure 分别按 ID 合并进行中的 Promise，成功、缺失或失败均释放；读取失败沿用缺失退路并允许后续重试。传输读取返回后再次检查实时投影，已有推送优先。
- **验收**：50 次同目标并发读取只触发一次 IPC，失败/缺失后可重试；50/300/1000 条缓存验证索引、追加、裁剪、重载、撤回更新和会话隔离；传输进度及完成/取消状态不被旧读取回退；五连验证通过。
- **边界**：仅合并进行中请求，不增加常驻历史结果缓存；协议、数据库、传输状态机、媒体与输入兼容路径保持。

---

### OPT-26 【P1·性能】全局搜索减少重复 FTS

- 状态：已完成（v0.54.7，决议 #297）
- **问题**：全局搜索先聚合，再对最多 10 个会话重复 MATCH；高频词阻塞主进程。
- **方案**：一次 MATCH 同时聚合 text/pk 计数、text/pk 的最大时间和全部类型的最大命中 seq；按现有 `(conv_id, seq)` 索引读摘要。遇到重复 seq 等无法唯一定位的历史记录，回退原最新命中查询，保留原选择行为。
- **兼容**：保留计数只含 text/pk、摘要可来自文件/图片等类型的既有差异；不改分词、LIKE 转义、排序和条数，不改数据库迁移或依赖。
- **验收**：真实 Electron Node16 上逐字段对照旧查询，覆盖混合类型、PK、撤回、相同时间/序号、10 会话截断、旧库迁移和无命中；五连验证。基线探针：macOS arm64 / SQLite 3.45.3，10 万条高频词从 358.94ms 到 50.27ms；无命中 2.75ms 到 2.74ms；文件名高命中 9.31ms 到 10.84ms，最终以实现后对照复测为准。

---

## 3. 建议执行顺序

| 批次 | 条目 | 说明 |
|---|---|---|
| A（先做） | OPT-1 → OPT-2 → OPT-3 → OPT-4 | 全部是真 bug；各自独立 commit，各 patch +1 |
| B | OPT-5 → OPT-6 → OPT-7 | 存储热路径；OPT-5 是地基，先行 |
| C | OPT-8 → OPT-9 → OPT-10 | 渲染层；严格按序（互有依赖），OPT-9 改动大可单独排期 |
| D | OPT-11 → OPT-12 → OPT-13 → OPT-14 → OPT-15 | 网络/主进程收敛，彼此独立、可乱序 |
| E | OPT-16 → OPT-17 → OPT-18 | 文档与质量，随时可插队 |
| F（低性能平台） | OPT-19 | 软渲染画像、OCR 策略、图片 I/O、资源与构建预算一次闭环 |
| G（低性能平台） | OPT-20 | 滚动媒体惰性加载；主窗口 Naive UI 复用边界审查 |
| H（UI 一致性） | OPT-21 | 讨论组与联系人资料普通输入、主次操作复用现有主题 |
| I（低性能平台） | OPT-22 | 图片像素门禁、近视口缩略图生成与 128MB LRU 派生缓存 |
| J（2026-09 评审第一批） | OPT-23 → OPT-24 → OPT-25 | 用户已确认执行；逐项落档、验证与提交 |
| K（2026-09 评审第二批） | OPT-26，随后不活跃缓存回收、缩略图并发约束 | 用户已确认执行；先测量，再独立提交 |

每批做完向用户汇报一次（完成项、版本号轨迹、验证结果），再进下一批。

## 4. 明确不做 / 需用户拍板的事项（本文档只登记，执行者不要动）

1. **媒体缓存清理**：`userData/data/images/out/` 发送暂存与接收图片缓存只增不减（磁盘长期增长）。属"空间占用/缓存清理"设置功能（handoff §5 已列打磨项），功能形态需用户拍板，不是纯技术优化。
2. **导出/导入异步化**：porter 在主进程同步执行，大数据量会阻塞 UI 数秒（OPT-6 已把最坏情况从"几十分钟"压到"数秒"）。进一步异步化涉及进度 UI 与体验取舍，需用户拍板。
3. **消息列表虚拟滚动**：OPT-9/10 之后若真实场景仍卡顿再评估——虚拟滚动对滚动恢复/贴底/跳转逻辑侵入太大，收益存疑。
4. **`peersRepo.upsertMany` 全表落库**：注册表变化后 1s 全量 upsert（≤1000 行事务毫秒级，tech-design 有意为之）。规模上到数千节点才需增量化，暂不动。

## 5. 变更记录

- 2026-07-09 v1.0 初稿（决议 #200）：基于 main @ 36823fc / v0.32.3 全库审查，落档 18 项分级优化待办。
- 2026-07-09 v1.1 决议 #201：工作流程改为直接在 main 分支执行（dev-claude 已废弃删除）。
- 2026-07-09 v1.2 执行完成：18 项由 GPT 逐项落地（13758e9…fad9333，v0.32.4 → v0.32.20，共 18 commit）。
- 2026-07-09 v1.3 **验收通过**（Claude 复核）：逐项对照代码 diff 与验收标准检查——P0 四项修复正确且回环测试齐全；迁移 v10 只追加；porter 导入 2 万条 93ms（db-selftest 实测）；渲染层 ChatPane 撤回倒计时已收敛到菜单开启期、MessageRow 行组件行为等价、样式逐字搬移；协议 / 依赖 / 构建基线零触碰；测试新增 15+ 用例且全部遵守 127.0.0.1 + 空广播纪律；五连验证（test 213 过 / test:db PASS / typecheck / build / smoke exit 0）全过。状态行补记各 commit 短哈希；OPT-11 留一条 generation 中止的语义备注（见该条目）。
- 2026-07-14 v1.4 决议 #231：在第二轮代码扫描后追加 OPT-19，聚焦 Win7 / UOS 软渲染画像、OCR 自动策略、图片 I/O、renderer 位图与四窗口完整启动闭包预算。
- 2026-07-14 v1.5 OPT-19 完成：345 项测试、数据库自测、Node 16 / Chrome 108 类型检查、构建与 smoke 全过；四窗口完整静态闭包预算启用，renderer 两张位图合计由 726,604 字节降至 281,015 字节。
- 2026-07-14 v1.6 决议 #232：追加 OPT-20，保留主窗口 Naive UI 混合接入，聚焦聊天流、记录搜索与表情包网格的图片惰性加载和异步解码。
- 2026-07-14 v1.7 OPT-20 完成：349 项测试、数据库自测、Node 16 / Chrome 108 类型检查、构建与 smoke 全过；三类滚动媒体启用惰性加载与异步解码，独立看图和截图保持立即加载。
- 2026-07-14 v1.8 决议 #233：追加 OPT-21，迁移 `GroupCreator` 与 `ProfileCard` 的普通输入及主次操作到主窗口现有 Naive UI 主题，密集成员选择保持轻量实现。
- 2026-07-14 v1.9 OPT-21 完成：353 项测试、数据库自测、Node 16 / Chrome 108 类型检查、构建与 smoke 全过；主窗口完整静态闭包为 JS 593,462 字节 / CSS 79,809 字节，维持既有预算且公共启动闭包仍为 80,223 字节。
- 2026-07-14 v1.10 决议 #234：追加 OPT-22；用户拍板单边 8192px / 总像素 3200 万、320px WebP 与 128MB LRU 缓存，异常和超限图片按普通文件处理。
- 2026-07-14 v1.11 OPT-22 完成：369 项测试、数据库自测、Node 16 / Chrome 108 类型检查、构建与 smoke 全过；App / Settings / Capture / ImageViewer 完整静态闭包分别为 JS 596,562 / 640,621 / 88,503 / 121,280 字节，CSS 79,985 / 27,902 / 6,110 / 10,002 字节，公共启动闭包 80,223 字节，全部维持既有预算。
- 2026-08-10 v1.12 决议 #285：新增英文当前优化状态与执行边界文档、中英双向入口；优化项状态与代码行为保持，版本 **0.51.0 → 0.51.1**。
- 2026-09-05 v1.13 决议 #294：按用户确认的第一批优化追加 OPT-23，会话菜单使用实际尺寸避让视口，计划版本 **0.54.4**。
- 2026-09-05 v1.14 OPT-23 完成：656 项测试、Electron Node16 数据库自测、类型检查、构建与回环 smoke 全过；macOS 实窗验证 100/110/125% 底部菜单、置顶、免打扰、移除确认及撤回、Esc 消费。四角与缩小视口由几何测试覆盖。
- 2026-09-05 v1.15 决议 #295：追加 OPT-24，全局搜索按面板生命周期清理旧任务并隔离过期结果，计划版本 **0.54.5**。
- 2026-09-05 v1.16 OPT-24 完成：662 项测试及五连验证全过，smoke 仅回环；macOS 实窗确认等待提示、联系人离线展示、关键词切换与消息命中跳转。
- 2026-09-05 v1.17 决议 #296：追加 OPT-25，复用响应式消息索引、合并历史消息和传输进行中读取，计划版本 **0.54.6**。
- 2026-09-05 v1.18 OPT-25 完成：674 项测试、Electron Node16 数据库自测、类型检查、构建及回环 smoke 全过；真实 Electron 首次打开 50 条同源引用只产生 1 次消息读取，引用跳转、撤回/缺失/跨会话提示与普通输入通过。公共启动闭包 80,252 字节，App 闭包 JS 796,078 / CSS 115,605 字节，四窗口均在既有预算内。第一批 OPT-23–25 完成，Win7/UOS 等目标系统实机验证仍按既有外部验证边界执行。
- 2026-09-05 v1.19 决议 #297：启动用户确认的第二批；OPT-26 以单次 FTS 聚合及现有索引读取减少重复查询，计划版本 **0.54.7**。
- 2026-09-05 v1.20 OPT-26 完成：674 项测试及五连验证全过，数据库自测补充 v9 升级和旧查询逐字段对照。真实 Electron Node 16.17.1 / ABI 110 / SQLite 3.45.3，交替运行新旧实现各 8 次取中位数：10 万条高频词 **366.56 → 51.63ms（下降 86%）**，无命中 **2.69 → 2.73ms**，文件名高命中 **9.27 → 10.83ms**；全部结果一致。文件名样本多聚合匹配类型产生约 1.6ms 开销，保留现有混合类型摘要语义。
