# Teahouse development handoff

> [简体中文](../handoff.md) · **English**

This is the English current-state handoff for developers and coding agents. Read it together with the [Contributing guide](../../CONTRIBUTING.en.md) and any local automation policy included in your development checkout. The Chinese handoff keeps the complete chronological release notes; `git log` remains authoritative for current implementation history.

Last updated: 2026-08-27 for **v0.52.0** (decision #287, Issue #30 sticker improvements). The application remains pinned to Electron 22.3.27, Node 16.17 main/preload, Chrome 108 renderer, and LAN-only runtime behavior.

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
| Version | 0.52.0 sticker import, grid, and group-send improvements |
| Branch/release base | `main`, previous release tag `v0.51.2` |
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

- Development Node is 18 or later; packaged main/preload runtime is Node 16.17.
- `.npmrc` values for Electron runtime/target, mirror, and `legacy-peer-deps` are intentional.
- A macOS Electron extraction failure may require `ditto` and a newline-free `path.txt`; see [Contributing](../../CONTRIBUTING.en.md#troubleshooting).
- Migrations append new entries only. Check existing schema before adding a table or column and run the Electron-ABI database self-test.
- Do not use `npm audit fix --force`; known tool/Electron advisories are handled through runtime isolation, no remote content, allowlisted input, and the fixed Windows 7 baseline.
