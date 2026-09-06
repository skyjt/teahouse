# Teahouse requirements

> [简体中文](../requirements.md) · **English**

| Field | Value |
|---|---|
| Status | Current for v0.56.1 image selection alignment and cursor fixes; Neiwangtong compatibility remains paused by decision #199 |
| Updated | 2026-09-06 |
| Authority | The [Chinese requirements document](../requirements.md) is the canonical feature and decision record. This document translates the current effective requirements. |

## 1. Product goals

Teahouse is a serverless, IP-based LAN messenger and file-transfer application.

1. **No server and minimal setup** — Install, start, and discover equal peers automatically.
2. **LAN-only operation** — Runtime data remains on the local network; there is no telemetry or Internet dependency.
3. **Office-grade reliability** — Messages must not disappear silently and file transfer should use available LAN throughput.
4. **Legacy-friendly desktop coverage** — Support Windows 7 SP1, Debian 10 / UOS 20, current Linux distributions, and macOS.

The primary deployment is an office network with tens to hundreds of users, multiple subnets or VLANs, and a practical need for routed-subnet discovery. The design budget is at most 1,000 online peers on one network (decision #15).

## 2. Users and environments

- General office workers who expect a familiar, zero-training interface.
- IT administrators who distribute packages, configure firewalls, and define scan ranges.
- Windows 7 virtual machines, including x64 and 32-bit systems; UOS and Debian desktops; and Apple Silicon Macs.
- Small single-subnet teams and personal multi-device transfer are naturally supported secondary uses.

Each device is an independent identity. Teahouse has no account system that merges one person's devices.

## 3. Out of scope

- Internet messaging, cloud synchronization, cloud storage, or any central server.
- Mobile clients.
- Rich-text formatting and video calls. Voice intercom and remote assistance remain future evaluations.
- Read receipts. Message status ends at delivered (decision #1).
- Transport encryption. The security model trusts the LAN boundary (decision #5).
- A server-backed account or organization directory.
- Wire compatibility in the primary UTF-8 JSON protocol. Any Neiwangtong/IP Messenger interoperability is isolated in a separately enabled compatibility mode.

## 4. Terms

| Term | Meaning |
|---|---|
| Peer | One running Teahouse client instance |
| Node ID | Persistent local identity created on first launch; independent of IP address and nickname |
| Conversation | Chat context with a peer or discussion group |
| Discussion group | Fixed-member peer-to-peer group; the sender delivers to members individually |
| Organization path | User-declared company, department, and team fields used to group contacts |
| Offline retry | Persistent sender-side queue that retries in order after a peer returns online |
| File cabinet | A user-selected local folder exposed with default and per-peer permissions |

## 5. Feature priorities

P0 is required for a usable product, P1 is expected for a complete release, and P2 is an enhancement.

| Area | Capability | Priority | Delivered/planned |
|---|---|---|---|
| Discovery | Same-subnet discovery, heartbeat, online list | P0 | v0.1 |
| Discovery | Manual IP, CIDR probing, peer-list gossip | P0 | v0.1–v0.3 |
| Discovery | Low-rate scan-range sharing and global refresh | P0 | v0.17–v0.18 |
| Contacts | Persistent peers, search, notes, three-level organization | P0/P1 | v0.1–v0.3 |
| Messaging | Private text, delivery state, retry, offline queue | P0 | v0.1 |
| Messaging | Images, emoji, stickers, paste, drag and drop | P0/P1 | v0.2+ |
| Messaging | Discussion groups, roles, mentions, forwarding, recall | P0/P1 | v0.3+ |
| Messaging | Search, history, export, migration import | P0/P1 | v0.2+ |
| Capture | Region capture, annotation, and shortcut | P0 | v0.3 |
| Files | Files, folders, queue, resume, records | P0/P1 | v0.2+ |
| File cabinet | Permissioned browse, download, upload, and first-class tab | P1 | v0.47–v0.51 |
| Desktop | Tray, notifications, startup, shortcuts | P0/P1 | v0.1+ |
| Updates | Peer-to-peer update discovery and package transfer | P1 | v0.27+, incomplete end-to-end |
| Settings | Profile, avatar, ports, destinations, theme, shortcuts | P0/P1 | v0.1+ |
| Application language | Simplified Chinese default | P2 | Future |
| Documentation language | Simplified Chinese and English | Maintained | v0.51.1 |
| Compatibility | Neiwangtong compatibility mode | Paused | Unscheduled (#199) |
| Local API | Optional local automation/AI interface | P2 | Future research |

The v0.51.1 localization applies to repository and release documentation. Application UI localization remains a separate P2 product decision.

## 6. Functional requirements

### 6.1 Discovery and presence

- **Same subnet:** broadcast entry on startup, respond after a randomized delay, update the online list, broadcast exit on graceful shutdown, and use heartbeat timeout after abnormal termination.
- **Routed subnets:** support manually entered peer IPs, rate-limited CIDR probes, and peer-list gossip. One reachable bridge peer can introduce nodes from another subnet.
- **Scan-range sharing (#114):** share user-added CIDRs at a low rate. Receiving a range records it without an immediate full scan. Background scans wait 30–90 minutes, scan a range no more than once every 12 hours, and sample about 10% of clients when more than 50 peers are online. Removing a learned range adds a local ignore entry.
- **Global refresh (#115/#197):** the navigation-rail refresh action asks for confirmation, deduplicates hosts from every saved valid range, probes with the normal manual rate limit, displays progress, and prevents concurrent scans.
- **Stable identity:** generate and persist a Node ID on first launch. Conversations and history follow Node ID across nickname or IP changes.
- **Contact projection:** retain peers after they go offline, gray offline rows, show green/gray status dots, sort online entries first, and refresh profile data after entry, profile-version mismatch, or explicit update.
- **Organization:** users self-declare company, department, and team. Contacts aggregate into a collapsible three-level tree; empty levels are skipped.
- **Secondary liveness check:** probe a peer when opening its conversation; message delivery still depends on ACK.
- **Local notes:** a private note can override the displayed nickname and participate in contact, conversation, and search matching.
- **Avatars (#243–#249):** support animal emoji, nickname initial, and custom image modes. Custom static JPG/PNG/WebP/BMP images are locally cropped to a bounded 192×192 WebP. The profile announces a SHA-256 hash and peers fetch/cache it on demand through the LAN. Numeric avatars remain the fallback for old clients and missing content.

### 6.2 Messaging

- **Private text:** UTF-8 text and emoji use globally unique message IDs. Short messages prefer UDP+ACK, fall back to one TCP control-frame attempt after UDP retries, and send oversized payloads directly over TCP.
- **State:** outgoing messages show sending, delivered, failed, or waiting for the peer. No read receipt is produced.
- **Offline queue:** keep messages for seven days, preserve order, cap each target at 200 queued items, and deduplicate by message ID on receipt.
- **Images:** accept pasted, dragged, or selected images; render a thumbnail and open a validated original. Oversized or invalid inline images become ordinary files.
- **Conversation image navigation (#303):** the image window shows Previous/Next buttons on the two sides of the canvas. Browse the full local history of the opened private/group conversation in message sequence order, including screenshots and table images. Disable the corresponding button at either end without wrapping. Skip recalled, incomplete incoming, missing or invalid images; exclude stickers and ordinary files, and show each group image message once. History-search images use the same scope. Switching keeps the window bounds and resets image transforms and OCR display; existing arrow-key panning remains. Disable navigation during requests and show retryable failures.
- **Selection alignment and gesture cursor (#305):** restore the existing expanded detection bounds instead of the raw shrunken contour, then fit the native text selection box to its OCR line bounds, measuring only when the result layout changes. A gesture started on text keeps the text cursor over line gaps and image blank areas; release it on pointer up/cancel, blur, hiding or image change. Blank-area gestures still pan. Preserve native copying, one node per line and existing OCR resource limits.
- **In-image OCR selection (#304):** all platforms start recognition only after clicking Recognize Text. Cached results restore selectable text directly over the image without inference. Use native partial/cross-line selection, Ctrl/Cmd+C, Copy Selection and Copy All; remove the separate text-result panel. Blank image areas still pan and text follows zoom/rotation. One local single-threaded Worker runs at most one image; changing images or closing cancels active work. Keep the existing models and 2200px input/960px detection limits. Each recognized line uses one DOM node with no per-character hit-test loop or polling. Special fonts/spacing/skew can affect character alignment; recognition may briefly occupy one CPU core, without a hardware-independent timing/CPU guarantee.
- **Table paste (#190/#270):** paste table text into the draft and show a small “send as image” choice. Enter sends plain text. Image conversion is explicit. Peers advertising `tbl1` may also receive bounded TSV metadata for a local image/text view toggle.
- **Discussion groups:** support up to 200 members. Owners appoint administrators; all members may invite contacts; owners and administrators can rename and remove members according to the role matrix. The owner transfers deterministically when leaving. Optional management passwords grant selected legacy management operations. Group metadata changes produce idempotent system messages. Group owners, administrators, or password-holding members can set or clear a group description (≤ 200 characters) and a group announcement (≤ 1024 characters) from the member panel; empty text is omitted from display. Changes broadcast via `group.info`; old packets that omit either field preserve the local known value or default to empty on first receipt. Migration backups preserve both fields.
- **Group media:** send one offer per online member. Offline members do not enter a file queue. Images up to 10 MiB use the image path; larger images become manual file transfers.
- **History and search:** store locally in SQLite, support infinite pagination and per-conversation scroll restoration, provide global search across contacts/groups/messages/files, and provide filters within one conversation.
- **Export and migration:** export readable HTML/TXT and a `.pantry-bak` migration archive. Import maps the previous local identity to the current Node ID and merges by message ID.
- **Recall:** allow the sender to recall eligible text, group text, game, image, and unfinished file messages within five minutes. Completed files remain on disk. Group-file recall is available only while every recipient transfer is unfinished.
- **Emoji and stickers:** render a local Twemoji subset on legacy platforms while preserving UTF-8 characters on the wire and clipboard. Stickers can be collected from chat images or imported through the native multi-image picker, retain the existing static/GIF size controls, and can be sent in private or group conversations. Group stickers follow group-image delivery and reach only currently online members.
- **Forwarding and mentions:** forward supported content through a global modal and support mentions in groups. **Quoted replies** (decision #288, v0.53): tapping a message in a group conversation attaches its source message ID (`replyTo`) to the next send; the codec rejects empty strings and objects with `senderName`/`text`. Receivers look up the source ID in the local group conversation, populate `ReplyMeta` with sender name and first-line text summary, and render a quoted-context bar above the bubble; clicking jumps to the source message's conversation. If the target is absent locally, receipt succeeds and the renderer shows an unavailable-target hint.
- **Nudge:** private chats can send a reliable, rate-limited window nudge. It is never queued for a later offline delivery.
- **PK games:** rock-paper-scissors and dice use delayed reveal semantics defined by the current protocol and UI documents.

### 6.3 Files and file cabinet

- Send one file, multiple files, or a complete directory through a pull-based TCP stream.
- Sanitize names, constrain paths, avoid overwrites, write `.part` files, resume by offset, and verify SHA-256 before completion.
- Limit concurrent streams and queued work; show progress, pause/wait states, cancellation, failure, resume, and transfer records.
- Ordinary chat files expire after 24 hours. Both sides display an explicit expired terminal state and disable new retrieval.
- Private-chat “direct send” may auto-accept into the configured contact directory when both peers support it. “Save as” remains an explicit destination choice.
- File cabinet sharing defaults to off. The owner selects an approved root outside dangerous system/home/application-data roots and assigns `off`, read, or read/write as a default plus per-peer exceptions.
- The cabinet browser paginates and snapshots directory listings, enforces rate and size limits, rechecks `realpath` containment, and presents permission-specific download/upload actions.
- Uploads land under a sanitized uploader-specific directory inside the shared root and generate an idempotent local system message.
- The main window exposes File Cabinet as its third tab with a peer list, My Cabinet management, list/grid browsing, selection, keyboard navigation, and transfer progress.

### 6.4 Capture, desktop, and settings

- Region capture supports multi-display work areas, annotation tools, and copy/send. On Wayland it enables the PipeWire portal and attempts real source capture instead of rejecting the session up front. Empty sources, empty images, and capture errors restore the main window and produce visible in-app feedback; hidden shortcut invocations use a system notification when available. Every failure offers system capture plus chat-box `Ctrl+V` as a fallback. Before capture, hiding the main window waits for the hide signal and compositor settling, then verifies that the window is no longer visible.
- Tray state, unread attention, native notifications, startup, close behavior, and global shortcuts work across the platform matrix.
- Notifications suppress message bodies in logs and honor user settings, conversation mute, current visibility/focus, and mention rules.
- Settings cover identity, organization, avatar, directories, receive behavior, notifications, startup, theme, font size, send key, shortcuts, ports, backup/import, and About.
- Port editing requires an explicit risk confirmation before an individual field unlocks.
- Peer-to-peer update discovery compares version, platform, and architecture. Package transfer requires explicit user action, exact package naming, a short-lived source-bound grant, SHA-256 integrity, a size limit, and local package-version validation. Applying and restarting remain incomplete on all target paths.

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Scale | Up to 1,000 online peers and 200 members per discussion group |
| Compatibility | Electron 22.3.27, Node 16.17 main/preload, Chrome 108 renderer |
| Security | Context isolation, sandbox, disabled Node integration, strict CSP, blocked navigation/new windows |
| Network | LAN-only runtime, global no-proxy switch, no telemetry or remote assets |
| Validation | Exact inbound allowlists, bounded frames, rate limits, resource budgets, unknown-type ignore |
| Privacy | Never log message bodies or file content; log metadata only |
| Reliability | Persistent offline queue, deduplication, retry, `.part` resume, integrity verification |
| Performance | Stream large files, bound images/thumbnails/caches, debounce search, throttle UI progress |
| Accessibility | Keyboard operation, focus restoration, reduced-motion behavior, meaningful accessible labels |
| Packaging | Windows x64/ia32, Linux x64/arm64, macOS arm64; exact artifact/version consistency |
| Documentation | Bidirectional language links and synchronized Chinese/English current specifications |

## 8. Decision record

The complete append-only ledger is maintained in [requirements.md §9](../requirements.md#9-决议记录). English current specifications cite the decisions that remain materially important. The localization increment adds:

| Decision | Context | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|---|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| #285 | Publish maintainable English README, user/developer guides, and current design documentation | Keep established Chinese paths canonical; add English counterparts and bidirectional navigation; validate document coverage and links in CI; use bilingual GitHub Release headings; ship as v0.51.1. Application UI language remains unchanged.                                                                                                                                                                                                                                |
| #286 | Kylin and UOS/Huawei systems can ignore capture clicks or retain the main window in screenshots (#29 / #31) | Enable Electron 22's PipeWire capturer on Wayland but still probe `desktopCapturer`; wait for the hide signal and compositor settling, verify invisibility, and surface every empty-source/image/error outcome in-app or through a system notification with a system-capture + `Ctrl+V` fallback. Ship as v0.51.2 without protocol, database, dependency, or network changes.                                                                                                  |
| #287 | Issue #30: stickers require a chat-image workaround, multi-row grids overlap, and saved stickers cannot be sent to groups | Add native multi-image import with a separate window-scoped one-time path grant, reuse the existing WebP/GIF collection pipeline, size implicit grid rows to their square items with vertical overflow, and route group stickers through the existing online-member `purpose:"sticker"` media path. Ship as v0.52.0 without protocol, database, dependency, or port changes.                                                                                                   |
| #288 | Implement group-text quoted replies | Add optional `replyTo` source-message-ID to the `group-text` payload. The codec accepts only bounded non-empty strings and rejects empty strings and objects with `senderName`/`text`. Senders carry only the ID; receivers look up the source in the local group conversation, populate `ReplyMeta`, and store the raw ID in `messages.reply_to`. Missing targets are handled gracefully by the renderer. Advance protocol to v0.51, SQLite advances to v15. Ship as v0.53.0. |
| #289 | Issue #34: Kylin ARM64 Wayland exits when capture enumerates screens | Electron 22 can crash natively before JavaScript can recover. At the shared capture entry, skip `desktopCapturer` only on ARM64 Wayland and reuse the visible system-capture + `Ctrl+V` fallback. Keep x64 Wayland, ARM64 X11, other platforms, protocol v0.51, SQLite v15, dependencies, and network behavior unchanged. Ship as v0.53.1.                                                                                                                                     |
| #290 | Group description and group announce | Group owners, administrators, or password-holding members may set or clear a group description (≤ 200 characters) and a group announcement (≤ 1024 characters) from the group panel. Empty text is omitted from display. Changes broadcast via `group.info` and produce idempotent system hints. Omitted legacy fields preserve local values; migration backups preserve both fields; inbound changes enforce one-operation permission isolation. SQLite migration v16 adds both columns. Protocol remains v0.51; SQLite advances to v16. Ship as v0.54.0. |
| #291 | Harden PR #39 after review | Keep the new `group.info` fields optional for legacy peers and preserve locally known values when omitted. Accept one description or announcement change at a time only from an owner, administrator, or member with the correct management password; reject text smuggled alongside invite, rename, or another text change. Reuse one renderer dialog and the existing password-aware update path, and preserve both fields in backups. Protocol v0.51, SQLite v16, dependencies, and ports remain unchanged. Ship as v0.54.1. |
| #292 | Restore group snapshot catch-up | Local IPC and adjacent revisions remain single-operation. A cumulative snapshot needs a revision gap covering its changed text fields and recognized structural operation; text authorization and the existing structural permission matrix must both pass. High revisions never bypass authorization or allow unknown structural combinations. Protocol v0.51 and SQLite v16 remain unchanged. Ship as v0.54.2. |
| #293 | Main-window Escape | An unmodified, non-repeating Escape hides the main window after local overlays and selection have handled it. Composition and consumed events take precedence. Only the main renderer can invoke the hide IPC; minimize when the tray is unavailable. Close preferences and configurable global shortcuts remain intact. Ship as v0.54.3. |
| #294 | OPT-23: conversation menu placement | Clamp the measured menu inside the CSS viewport with an 8px margin and reposition while open on resize. Preserve pin/mute/remove actions, confirmation, ten-second undo, Escape priority, and existing page zoom. Protocol, storage, dependencies, and platform compatibility branches stay unchanged. Ship as v0.54.4. |
| #295 | OPT-24: global-search lifecycle | Clear debounce timers and invalidate stale requests on query change/unmount. Only the current request updates results, error, and loading state. Preserve 200ms debounce, query categories/order/limits, navigation, and IME behavior; use existing loading/error placeholders and retry on new input. Ship as v0.54.5. |
| #296 | OPT-25: quote/transfer reads | Quotes use the existing conversation-scoped ID index with reactive append/trim/reload/recall updates. Coalesce same-ID in-flight historical-message and transfer reads; release after success, missing result, or failure and allow retry. Realtime transfer state takes precedence over an earlier read. No additional permanent history cache or protocol/database/state-machine/platform changes. Ship as v0.54.6. |
| #297 | OPT-26: global FTS query | One MATCH preserves text/PK counts and ordering while obtaining the newest seq across all matching kinds. Read summaries through the existing index; non-unique seq values use the original MATCH lookup. Keep tokenizer, LIKE escaping, sorting/limits, old databases, schema, and dependencies intact. Ship as v0.54.7. |
| #298 | OPT-27: inactive caches | Keep at most 10 inactive conversation snapshots totaling 3000 messages, evicting oldest whole snapshots and their indexes. Protect the active conversation and pending removal undo window; reload latest/history from main and reject stale page results. Retain active transfers and component-referenced states, cap unused terminal states at 200, and release terminal speed samples. Preserve realtime precedence, unread state, forwarding/retry, persistent data, and platform paths. Ship as v0.54.8. |
| #299 | OPT-28: thumbnail concurrency | Bound the near-viewport thumbnail pipeline to 4 hardware-rendered or 2 software/unknown-profile jobs. Same-ID images share work; leaving the near viewport, rebinding, or unmounting releases a demand, and unstarted jobs with no remaining demand are discarded. Running jobs complete and release their slots. Reuse the existing 512-entry LRU for completed URLs, preserving cache parameters, animation/small-image/original fallbacks, the 480px margin, viewer/OCR/pixel guards, and existing protocol/IPC/database/dependencies. Ship as v0.54.9. |
| #300 | CI packaging performance | Linux installs dependencies without automatic lifecycle hooks, explicitly restores required non-native setup, and source-builds better-sqlite3 once on Debian 10. Each platform builds the application once and reuses it for smoke and packaging. Cache downloads per platform/job and disable artifact recompression. Keep all validation, triggers, five platforms, 15 assets, and compatibility baselines. Ship as v0.54.10. |
| #301 | OPT-29: readable list metadata | Apply the existing secondary-text token locally to conversation times/previews/counts, contact IPs/counts/offline names, search labels/summaries/organization/offline information, and placeholders/status messages. Preserve gray offline semantics, disabled controls, global tokens, geometry, typography, zoom and platform branches. Ship as v0.54.11. |
| #302 | OPT-30: keyboard list actions | Use native type=button controls for conversations, contact groups/peers and all global-search result categories. Tab/Enter/Space follow native behavior and existing click callbacks, with a local inset focus-visible outline. Preserve double-click chat, context menus, Escape, geometry, font inheritance, truncation, reduced motion and IME/platform branches. Expose expanded/current/contact-status semantics without new global shortcuts. Ship as v0.54.12. |
| #303 | Conversation image navigation | Add Previous/Next canvas buttons over complete local conversation history in messages.seq order. Reuse managed-media validation, skip unavailable media, deduplicate group transfers by message, keep window bounds, and reset image/OCR state. Add a read-only local IPC without wire/schema/dependency changes. Ship as v0.55.0. |
| #304 | In-image text selection on low-end desktops | User chose manual recognition with result caching. Replace the separate OCR panel with a native transparent line text layer; one local cancellable single-threaded Worker, bounded caches, no automatic or parallel inference. Keep models, resolution, wire protocol, schema, dependencies and CSP. Ship as v0.56.0. |
| #305 | Selection alignment and cursor | Fit native text boxes to OCR bounds and keep the text cursor throughout a text selection gesture. Preserve native selection and bounded OCR work. Ship as v0.56.1. |

## 9. Open items

- Complete peer-to-peer update package retention, validation, apply/restart, progress, and recovery.
- Target-platform smoke testing on Win7 x64/ia32, UOS/Debian x64/arm64, and macOS.
- macOS universal/Intel packaging evaluation.
- Neiwangtong compatibility remains paused and must not enter implementation without a new product decision.
- Application UI localization remains a future P2 decision; repository documentation now supports English independently.

## 10. Translation maintenance

Update this document whenever the current functional or non-functional requirements change. Preserve decision numbers and update the canonical Chinese decision ledger first. Historical superseded experiments may remain summarized in English when they no longer affect current behavior.
