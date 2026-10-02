# Teahouse development handoff

> [简体中文](../handoff.md) · **English**

> Current update: 2026-10-02, v0.61.0 (#318), PR #42 integration and interaction/bundle fixes. GitHub Release is authoritative for publication status. Next decision: #319.
> Historical update: 2026-09-18, **v0.60.2 discovery and scan reliability (#317)**. Shared scan queue with manual priority/background resumption, recurring range scheduling, source validation, paced gossip, unknown-heartbeat recovery, correlated dp1 probes and same-revision ordering. Next decision: **#318**. Local implementation, not published. Validation: 126 files / 842 tests, Electron database, typecheck, build/bundle gates and isolated smoke passed. Real Electron 22 verified profile/group refresh, dp1 advertisement and global/single-range scan IPC/progress; loopback includes delayed legacy replies, with simulated scale/time checks. Physical target-platform and VLAN/1000-device acceptance remain open.

This is the English current-state handoff for developers and coding agents. Read it together with the [Contributing guide](../../CONTRIBUTING.en.md) and any local automation policy included in your development checkout. The Chinese handoff keeps the complete chronological release notes; `git log` remains authoritative for current implementation history.

Last updated: 2026-09-18. **v0.60.1 fixes contact profile synchronization (#316); this local increment is not published.** App-state shares one persisted monotonic revision between profile saves and runtime capability changes; PeerRegistry emits updates for changed full profiles at the same revision. Electron 22.3.27, Node 16.17, Chrome 108 and LAN-only behavior remain fixed. Next decision: #318.

Validation: 124 files / 823 tests, Electron ABI database checks, typecheck, build, isolated smoke and version consistency passed. Real Electron 22 loopback verified independent company/department/team edits and clearing, contact grouping and an already-open profile card, same-revision changes, duplicate suppression, local remarks, contact persistence and actual settings input/blur saves. Startup capability revisions persist and subsequent company edits advance them. These are local results; Win7/UOS/Kylin hardware acceptance remains pending.

Image Viewer now offers Previous/Next canvas buttons across the full local history of the opened conversation, skipping unavailable images and disabling endpoints. Switching keeps window bounds and resets image/OCR state. Wire protocol, database schema, and dependencies are unchanged.

OCR now starts manually on every platform and restores cached results directly as a native transparent text layer over the image. A single local Worker keeps inference off the viewer UI thread and cancels unfinished work on image changes/close. The separate OCR text panel is removed.

## 0. Reading order

1. [Contributing](../../CONTRIBUTING.en.md) — repository hard constraints and delivery checklist.
2. [README](../../README.en.md) — product, platform matrix, installation, security model.
3. [Requirements](requirements.md) — current functionality, scope, and priorities.
4. [Protocol](protocol.md) — exact wire behavior and constants.
5. [UI design](ui-design.md) — current three-column and cabinet interaction.
6. [Technical design](tech-design.md) — layering, storage, risks, tests, and packaging.
7. `git log` — most recent implementation truth.

## 1. Current state

| Area | State |
|---|---|
| Version | 0.59.2 compact assistance cards updated in place (#314); not released |
| Branch/release base | Verify from `git log` and live GitHub Release state; design documentation does not establish release completion |
| Core messaging | Private/group text, images, files, stickers, recall, forwarding, mentions, nudge, PK, offline retry |
| Discovery | Same-subnet broadcast, manual IP/CIDR, gossip, scan-range sharing, confirmed global refresh |
| Storage | SQLite WAL, append-only migrations, local history/search/transfers/settings |
| File cabinet | Complete P1 browse/download/upload flow; now the third main-window tab |
| Avatars/OCR/media | Managed custom avatars; PaddleOCR PP-OCRv6 tiny through local onnxruntime-web; bounded image metadata and thumbnails |
| Platforms | Windows x64/ia32, Linux x64/arm64, macOS arm64 CI packaging |
| Documentation | Chinese canonical set plus maintained English current specifications and locale checks |
| Neiwangtong compatibility | Design only; implementation paused by #199 |
| Peer updater | Discovery/request/hidden package transfer foundation exists; package creation/apply/restart UX remains incomplete |

Decision #287 resolves Issue #30: the sticker panel imports multiple local images through a dedicated one-time path grant, reuses the existing WebP/GIF collection pipeline, keeps square grid rows non-overlapping with vertical overflow, and enables saved stickers in groups through the existing online-member media path. Protocol v0.50 and SQLite v14 remain unchanged.

Decision #288 implements group-text quoted replies. The `group-text` payload gains an optional `replyTo` source-message-ID string. The codec accepts only bounded non-empty strings and rejects empty strings or objects with `senderName`/`text`. Senders carry only the ID; receivers look up the source in the local group conversation, populate `ReplyMeta` with sender name and first-line text summary, and render a quoted-context bar above the bubble. If the target is absent locally, receipt succeeds and the renderer shows an unavailable-target hint. Protocol advances to v0.51; SQLite advances to v15. Repository version 0.52.0 → **0.53.0**.

Decision #289 prevents Issue #34's Kylin ARM64 Wayland capture crash. Electron 22 may terminate natively while enumerating screen sources, before JavaScript error handling can recover. The shared capture entry now skips `desktopCapturer` only for ARM64 Wayland and reuses the visible system-capture + `Ctrl+V` fallback; x64 Wayland, ARM64 X11, and other platforms keep the existing capture path. Protocol v0.51, SQLite v15, dependencies, and network behavior are unchanged. Repository version 0.53.0 → **0.53.1**; the reporter confirmed the fix on the original machine on 2026-08-31 and Issue #34 is closed.

Decision #286 fixes Linux capture startup: Wayland merge-enables Electron 22's PipeWire capturer but still probes actual sources, Linux waits for the main-window hide signal and compositor settling, and all empty-source/image/error paths provide visible in-app or system-notification fallback guidance. The protocol remains v0.50 and SQLite remains v14; reported Kylin/UOS target machines still require final hands-on validation.

## 2. Development workflow

1. Read the canonical documents relevant to the task.
2. For a product/design change, update the Chinese fact source and append the next decision/change record before code.
3. Update the matching English current-state document in the same increment.
4. Implement within the layer boundaries.
5. Add focused tests, including loopback coverage for network behavior.
6. Increment version: feature → minor/reset patch; fix, docs, or refinement → patch.
7. Run:

```bash
npm run check:docs
npm test
npm run test:db
npm run typecheck
npm run build
PANTRY_UDP_PORT=47878 PANTRY_TCP_PORT=47879 npm run smoke
```

8. Review the full diff, version consistency, and worktree before committing.

Network tests use `127.0.0.1` and empty broadcast targets. Do not emit test traffic onto the real LAN.

## 3. Code map

| Path | Responsibility |
|---|---|
| `src/shared/` | Dependency-free protocol/IPC/types/constants |
| `src/preload/` | Explicit `window.pantry` context bridge |
| `src/main/net/` | Electron-free codec, UDP discovery, reliable messaging, TCP transfer |
| `src/main/store/` | Electron-free SQLite migrations and repositories |
| `src/main/services/` | Chat, groups, files, share, updater, search, backup orchestration |
| `src/main/util/` | Pure path, archive, media, and atomic-write helpers |
| `src/main/windows/` | Tray and auxiliary-window lifecycle |
| `src/main/index.ts` | Assembly, validated IPC handlers, system integration |
| `src/renderer/src/stores/` | Pinia projections of authoritative main-process state |
| `src/renderer/src/components/` | Chat, group, media, file, cabinet, and profile surfaces |
| `src/renderer/src/styles/tokens.css` | Single source of visual tokens |
| `scripts/` | Builds, bundle/version/docs checks, CI helpers, local clients |
| `.github/workflows/release.yml` | Five-platform validation/package matrix and tag release |

Layer rules:

- renderer uses no Electron/Node import;
- `net/` and `store/` do not depend on Electron or each other;
- services own business logic;
- IPC handlers validate and forward;
- shared code has no runtime dependency.

## 4. Safe next work

**Remote desktop viewing (#310, v0.58.0 implemented, not released):** private-chat View screen → peer consents/selects one screen → independent viewer. Default Auto 10/5/3 fps, manual 3/5/10 fps, per-session mode. JPEG uses the existing plaintext TCP listener, one frame on demand, without new dependencies or servers.

- Read [requirements](requirements.md#remote-view), [protocol](protocol.md#remote-view), [technical design](tech-design.md#remote-view) and [UI behavior](ui-design.md#remote-view). The next decision is #316.
- Entry points: `services/remote-view.ts`, `net/screen-stream.ts`, `windows/remote-view-window.ts`, `util/linux-screen-lock.ts` and the fifth dynamic root `RemoteViewApp.vue`.
- Run all five checks and, after build, `npm run test:screen`. Use `PANTRY_SCREEN_TEST_MS=600000 npm run test:screen` for ten minutes. The real Electron test uses synthetic office content and exercises actual media/Canvas/IPC/TCP/display without capturing the user's desktop.
- Local results (2026-09-16): 120 files / 776 tests and all five checks passed. Synthetic Electron viewing ran for ten minutes at about 9.45 fps; reverse media/encoding/transport and lock cleanup passed, as did small-window, bilingual/theme and stale-frame recovery checks.
- Remaining hardware work: Win7 x64/ia32 and UOS/Kylin capture, pointer, text, DPI, CPU/memory and lock behavior; macOS physical-screen permission grant/deny/revoke. Record dual-machine/routed-subnet behavior, 30 real capture cycles and latency percentiles per technical §3.1.6.
- Linux requires existing `gdbus` plus working DDE/UKUI lock state; monitor loss disables capability and ends sessions. Preserve the ARM64 Wayland sharing guard. Builds and synthetic loopback do not establish target-platform support.

### 4.1 Always required for later increments

- Keep Chinese and English current docs synchronized and run `npm run check:docs`.
- Keep package/lock/tag/artifact versions identical.
- Run the five local checks before delivery.
- Run real platform smoke checks for releases when the target machines are available.

### 4.2 Product work already identified

- Finish the peer-update loop: retain/rebuild installer packages, verify package version/format, apply with platform authorization, restart, show progress, retry, and recover failures.
- Complete v1.0 target validation: Windows 7 x64/ia32, UOS/Debian x64/arm64, macOS, tray/notifications/capture/input methods/firewall behavior.
- Evaluate macOS universal or Intel packaging as a dedicated task.
- Continue storage/cache/diagnostic Settings polish only after a new scoped decision.

### 4.3 Paused work

Neiwangtong compatibility (#194–#196) is a design-only long-term item. Decision #199 explicitly pauses implementation. Do not add `net/compat` or schedule VM investigation until the user reopens the product decision. Resume from [nwt-compat-design.md](nwt-compat-design.md) §15.

## 5. Known non-blocking items

- System UI icons remain local project SVG. Built-in emoji/avatar artwork is a local Twemoji subset with CC BY 4.0 attribution.
- Group files/images use per-online-member point-to-point transfers; offline group members do not receive queued file offers.
- Group message delivery does not expose per-member delivery receipts.
- Settings advanced storage migration, cache cleanup, diagnostic export, shortcut conflict detail, and destructive history cleanup still need dedicated scope.
- npm may warn about legacy `.npmrc` custom keys; do not run force audit/update commands that move Electron or the build chain.
- Linux arm64 artifacts are produced in CI; real UOS/Debian arm64 desktop smoke remains target-machine work.
- Windows ia32 is produced and PE-architecture checked; real Windows 7 SP1 32-bit desktop smoke remains target-machine work.
- Local OCR stores no text in SQLite/FTS. Results use a session memory cache keyed by transfer/natural size.

## 6. Environment notes

Documentation update 2026-09-16: requirements, protocol, UI, architecture, and implementation/acceptance plans for #308 were synchronized in both languages. Capture/network implementation and target-platform feature validation have not started.

Decision #309 updates the documented target to 10 fps with matching limits, scheduling, and acceptance; there is still no feature implementation.

- Development Node is 18 or later; packaged main/preload runtime is Node 16.17.
- `.npmrc` values for Electron runtime/target, mirror, and `legacy-peer-deps` are intentional.
- A macOS Electron extraction failure may require `ditto` and a newline-free `path.txt`; see [Contributing](../../CONTRIBUTING.en.md#troubleshooting).
- Migrations append new entries only. Check existing schema before adding a table or column and run the Electron-ABI database self-test.
- Do not use `npm audit fix --force`; known tool/Electron advisories are handled through runtime isolation, no remote content, allowlisted input, and the fixed Windows 7 baseline.

CI decision #300: Linux explicitly restores required install hooks and builds better-sqlite3 once through `scripts/ci-install-linux.sh`. All five jobs reuse one application build for smoke and packaging, cache downloads per job, and avoid artifact recompression. Triggers and validation gates remain unchanged.

Decision #305 corrects native selection-box dimensions and keeps a text cursor throughout cross-line dragging, preserving manual OCR and bounded resource usage.

- **2026-09-07, decision #306, v0.56.2:** built-in emoji retain transparent Unicode text beneath local SVGs for native selection/copy without extra line breaks; whole-message copy retains original text. The Win7 editor copies/cuts its existing logical draft selection. Linux text inputs use native insertText only for explicit NumLock-on Numpad digits or matching navigation keys, without modifiers or composition; consume events only on successful insertion. Readonly/disabled fields, NumLock-off navigation, Windows and macOS keep native behavior. No protocol, schema, IPC or dependency changes. UOS native event-chain verification remains a target-platform check.

Validation for #306: all five local gates passed (115 test files, 714 tests). Run `node scripts/input-selftest.cjs` to rebuild and mount the real components in isolated Electron 22, checking native emoji copy/paste/cut/undo and 31 numpad cases without starting application networking. Target Win7/UOS native event chains still require real-platform verification.

> 2026-09-09: v0.57.0 (#307, local implementation complete) adds offline Chinese/English switching across all windows and structured metadata for new system messages. Existing configurations keep Chinese; historical messages retain their original text. All five local gates passed (117 test files, 723 tests), with all four entry bundle budgets preserved. After building, run `node scripts/i18n-selftest.cjs` for real Electron 22 checks of onboarding, bidirectional switching across four windows, draft/selection retention, persistence, legacy configuration and invalid language rejection. The test uses isolated data and loopback-only UDP/TCP. English layouts were inspected at the minimum settings size and in capture/image windows. Win7/UOS UI verification remains a target-platform check; installer publication status is tracked by GitHub Release.

- 2026-09-16, decision #310: v0.58.0 implements view-only remote assistance, independent windows, Auto (10/5/3 fps) and manual Economy/Standard/Smooth modes. Consent, one-frame backpressure, bounded deadlines, lock detection and forced window cleanup are covered by local tests. Physical target-platform permission and performance checks remain pending; this iteration is not a release.

- 2026-09-17, #311, v0.58.1: fixed source actions, compact 440×180 sharing content area, native bitmap ownership transfer with explicit release, and bounded 3/5/10 fps capture constraints. Linux lock checks start asynchronously, use 60-second idle / 5-second active polling, recover monitoring and support the newer DDE interface. Preserve minimized state during invitations and reuse IME-aware Escape. After building, `PANTRY_SCREEN_SOFTWARE=1 PANTRY_SCREEN_PROFILE=1 npm run test:screen` exercises actual Electron with synthetic-only sources; optional `PANTRY_REMOTE_TEST_ARTIFACTS` saves screenshots. Physical Win7/UOS/Kylin/macOS permissions, DPI and native capture cost still require target machines. Not released.

Local validation: **121 test files / 790 tests**, Electron-ABI database checks, type checks, build, startup smoke and version consistency passed. Actual Electron software-rendering tests cover native bitmap transfer and forced Canvas 2D fallback; 120-second viewing averaged **9.30 fps**. In one same-host 30-second comparison, viewer CPU was **2.053% → 0.757%** and working set **645 → 188 MiB**; these figures do not establish target-platform savings. Capture constraints at 10/5/3/10 fps, bounded high-resolution output, unsupported-constraint fallback and lock-triggered cleanup passed. Physical permissions, DPI and long-term memory still require Win7/UOS/Kylin/macOS target machines.

- 2026-09-17, #312, **v0.59.0**: confirm before sending (cancel sends nothing); reuse the sharing window/stream as a 320×56 DIP edge strip. Persist one local system card per legitimate request, updating refusals/cancellations/timeouts and start/end/monotonic connected duration. Reuse SQLite metadata with no migration or wire changes; unfinished records on startup/import become interrupted with unknown end/duration. Lifecycle-only writes occur after capture cleanup; no per-frame writes, duplicate unread events or deleted-history resurrection. `test:screen` covers real native confirmation/Tab/Escape, cards, both themes/languages and edge bounds; `test:db` covers persistence, recovery and backup/export. Target-machine permission, native capture and DPI checks remain open. Not released.

Local validation for #312: 121 files / 795 tests; database self-test on Node 16.17.1 / ABI 110, typecheck, build, smoke and version consistency passed. Actual Electron 22 software-rendered synthetic loopback covers confirmation/cancel, Tab/Escape, languages/themes, pending/declined/completed cards, 320×56 edge placement/work-area changes, existing rate modes and lock cleanup. This does not establish physical target-platform support.

- 2026-09-17, #313, **v0.59.1**: assistance cards reuse ordinary message rows and persisted `isMine` for right/left initiator alignment, preserved through updates and history reload. No new timers, dependencies, protocol or storage changes. All five checks passed (121 files / 795 tests); real Electron 22 with software rendering verified request, completion, incoming, refusal and reload geometry, with bilingual/theme screenshots inspected. Not released.

- 2026-09-17, #314, **v0.59.2**: compact two-line assistance cards measured 260×63.5px locally, using mine/peer bubble colors. Full times/reasons remain in native hover and accessible text; remove the duplicate normal-session banner and timing table. Reuse existing in-place session updates. Real Electron assertions confirm unchanged record ID, DOM node and card count through request/start/end; refusal, reload, themes and languages passed. All five checks passed (122 files / 796 tests); main-window JS/CSS decreased by 444/86 bytes with no added per-frame or per-second work. Not released.

## 2026-09-17 — v0.60.0 diagnostics (#315)

Implemented: DiagnosticsService owns bounded logs and redaction; diagnostics-ui and its Worker export a local ZIP; DiagnosticsPanel lives in Settings → About. No database or wire changes. Next decision #316. Target-platform hardware/permission acceptance remains pending.

Validation: 123 files / 801 tests, Electron ABI database checks, typecheck, build and isolated smoke all passed. `npm run test:diagnostics` exercises real Electron 22 IPC/Worker, redacted bundles, disk errors, abnormal restart and light/dark/English 125% UI. A local ~9 MiB fixture exported in 221 ms with a 17 ms maximum main-thread heartbeat interval; this is a local sample only. The synthetic-screen regression also passed. Win7/UOS/Kylin hardware acceptance remains pending. No new dependencies, migrations or wire changes.


### PR #42 integration (decision #318, v0.61.0)

Preserves nameGXF's mention keyboard navigation, remark/nickname filtering, committed IME @ detection and mention-everyone support. Only the complete keywords 所有人 / 全体 / all / everyone expose the everyone candidate, so a short name query cannot select everyone by default. Arrow keys wrap; Enter confirms only a currently valid token. Caret/selection changes invalidate the picker, and mouse confirmation also revalidates the range without overwriting following prose. Composition keys and keyCode 229 remain native; both @ and full-width ＠ can open the picker.

Any current group member may mention everyone. Delivery remains per-member unicast excluding the sender; former members cannot send. The reserved mentions value `"@all"` marks the conversation and emphasizes notification titles while preserving mute, notification and focused-window gates. Older clients, including v0.60.3, receive the text without everyone emphasis. No new field, capability, database schema, dependency or external request. Editing the label into a different token removes the outgoing broadcast marker.

Official repository, download, issue and source links remain skyjt/teahouse; fork migration is excluded. This feature increments v0.60.3 to v0.61.0. The original PR's #308–#310 conflict with upstream decision numbers, so this integration uses #318. Twemoji SVGs are packaged as separate local assets loaded on demand, reducing inline graphics parsed by each window without raising JS/CSS budgets or changing Electron 22 / Chrome 108.

Validation: 129 files / 864 tests, typecheck, Electron Node16.17.1 / ABI110 database tests, build and version consistency passed. Isolated Electron 22 startup passed under Xvfb; an Electron/Chromium harness executing extracted component handlers verified caret movement, prose preservation and edited everyone labels, and all emitted SVG assets loaded. Of eight new event-handler regressions, seven fail on the original PR and all pass after the fix. Native Win7/UOS IMEs and physical desktop notifications still need target-device validation.
