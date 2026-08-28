# Teahouse technical design

> [简体中文](../tech-design.md) · **English**

| Field | Value |
|---|---|
| Current design | v1.63 for v0.52.0 |
| Runtime baseline | Electron 22.3.27 / Node 16.17 / Chrome 108 |
| Upstream | [Requirements](requirements.md), [Protocol](protocol.md), and [UI design](ui-design.md) |
| Authority | [tech-design.md](../tech-design.md) is the canonical technical design record |

## 1. Technology decisions

| Area | Decision | Rationale |
|---|---|---|
| Language | TypeScript across main, preload, renderer, and shared code | One strict contract language for wire, IPC, and storage models |
| Build | electron-vite 2 and Vite 5 | Separate bundles with enforced Node 16 / Chrome 108 targets |
| Renderer | Vue 3 and Pinia | Component/state model fits the three-column desktop UI |
| Styling | Native CSS variables plus selective Naive UI 2.43.2 | Mature forms with project-owned messenger surfaces |
| Storage | better-sqlite3 9.6.0, WAL, FTS5 | Synchronous main-process access with one audited native module |
| Images | Chromium canvas and `createImageBitmap` | Avoid additional native image dependencies |
| OCR | PaddleOCR PP-OCRv6 tiny through onnxruntime-web 1.20.1 | Fully local model and WASM runtime |
| Configuration | Atomic JSON writes through temporary file + rename | Small, dependency-free, and Node 16 compatible |
| Logging | Lightweight daily files, seven-day retention | Metadata-only logs without a new dependency |
| Packaging | electron-builder 24.13.3 | Windows, Linux, and macOS output matrix |
| Unit tests | Vitest 2 | Direct coverage of Electron-free modules |

Dependencies use exact versions. Electron remains exactly 22.3.27. `better-sqlite3` is the only permitted native module and is rebuilt for Electron ABI 110.

### 1.1 Naive UI boundary

- Keep `naive-ui@2.43.2`; 2.44.x requires Node 20 and violates the toolchain/runtime matrix.
- Import it only from renderer roots/components. Do not move it into the common `main.ts` startup closure.
- Use `renderer/src/ui/naive-theme.ts` to map design tokens.
- Keep named imports and tree shaking; do not add vfonts, xicons, CDN assets, or remote resources.
- Reuse the root provider for Group Creator and Profile Card. Dense selection lists remain lightweight project nodes.

### 1.2 Renderer performance profile

Structural panes use CSS surfaces, inset borders, and controlled shadows. Blur is limited to true overlays. Main process computes `softwareRendering` for Windows 7/Linux and renderer roots use solid overlay surfaces, shorter shadows, and reduced automatic image/OCR work.

Static and common renderer bundle sizes are checked after every build. Four renderer roots remain independently reachable. The main App static closure budget accounts for File Cabinet and selected Naive UI controls; the common startup closure stays bounded.

## 2. Process and window model

```text
Main process — Node 16.17
├─ Network I/O: UDP 17878 and TCP 17879
├─ SQLite repositories and configuration
├─ Services that orchestrate network + storage
├─ Tray, notifications, shortcuts, startup, single-instance lock
└─ Window management
   ├─ Main window, 960×640 minimum, frameless
   ├─ Settings, 640×480, lazy singleton
   ├─ Capture window(s), one per display, ephemeral
   └─ Image viewer, lazy/managed

Renderer processes — Chromium 108 sandbox
└─ Vue roots whose state is projected through IPC
```

The app requests a single-instance lock and focuses the existing main window on a second launch. Main window starts hidden and appears after `ready-to-show`.

Security settings are fixed for every renderer window:

```text
contextIsolation: true
sandbox: true
nodeIntegration: false
```

All navigation is blocked, `setWindowOpenHandler` denies new windows, and renderer CSP permits only required local schemes/resources. Main process adds `no-proxy-server` before networking starts.

macOS uses hidden-inset traffic lights. Windows/Linux draw client controls and use IPC for minimize, maximize/restore, and close. Renderer DOM never calls `window.close()` for the main window because that can bypass the hide-to-tray close path.

## 3. Module boundaries

```text
src/
├─ shared/    dependency-free types, constants, protocol and IPC contracts
├─ preload/   the contextBridge implementation of PantryApi
├─ main/
│  ├─ net/       Electron-free discovery, codec, messaging, transfer
│  ├─ store/     Electron-free SQLite repositories and migration logic
│  ├─ services/  use-case orchestration
│  ├─ util/      pure filesystem/data helpers
│  └─ windows/   Electron window and tray integration
└─ renderer/  Vue UI, Pinia projections, project components, local assets
```

Dependency rules:

1. Renderer imports no Node or Electron module.
2. `net/` and `store/` remain independent and Electron-free.
3. IPC handlers validate and forward; business decisions live in services.
4. Shared code has no runtime dependency.
5. Network and storage modules receive configuration and collaborators through constructors or explicit methods.

## 4. IPC contract

`src/shared/ipc.ts` defines `PantryApi`, the single type source for `window.pantry`. Preload implements the bridge explicitly. Main handlers use narrow channel names and validate every argument before service invocation.

Major capability families include:

- app/profile/settings and platform information;
- peer discovery, ranges, refresh, contacts, notes;
- conversations, messages, search, groups, recall, forward, nudge, PK;
- file/image/folder selection, path grants, offers, transfer actions;
- cabinet configuration, grants, browse, download, upload, recent uploads;
- backup/export/import;
- capture, image viewer, OCR, clipboard, and open-location;
- window controls and Settings modal state.

Main process sends event projections to the relevant windows. It does not expose raw Electron objects, filesystem handles, sockets, or SQLite access.

## 5. Network architecture

- `codec.ts` performs exact envelope/payload allowlist validation and bounded decoding.
- `udp.ts` owns socket/broadcast behavior and rate limits.
- `discovery.ts` coordinates entry, heartbeat, offline state, probing, and gossip.
- `messenger.ts` owns ACK waiters, retry, TCP fallback, and persistent-queue callbacks.
- `transfer.ts` owns framed TCP control and receiver-pull byte streams.
- `frame.ts` terminates malformed streams after the first parse error.
- `peer-registry.ts` tracks online endpoints; `peer-clock.ts` estimates display-time offsets.
- `range-sync.ts` handles bounded, low-rate CIDR sharing.

The transfer server allows three active data streams, 256 sockets, a 15-second first-frame deadline, and a 60-second active idle timeout. Queue and wait behavior is tied to a validated authorized pull.

Protocol changes follow: canonical protocol document → shared types/constants → codec validator → network/service implementation → tests.

## 6. Storage design

SQLite runs in WAL mode. The schema is migration-driven through `PRAGMA user_version`; released migrations are append-only.

Logical repositories cover:

| Repository/data | Purpose |
|---|---|
| Peers and notes | Persistent peer profile, address, local display note, last seen |
| Conversations | Private/group conversation metadata, unread, pin, mute, sequence |
| Messages | Message ID, sender, kind, timestamps, status, payload/file reference |
| Reliable queue | Sender-side offline retry envelopes and expiry |
| Deduplication | Recently received envelope IDs |
| Groups | Metadata, roles, revisions, avatar hash, member state |
| Transfers | Direction, purpose, file tree, progress, state, paths, expiry |
| Stickers | Managed local media metadata and order |
| Share grants | Per-peer cabinet permission override |
| FTS | Search projection for message text and supported metadata |

Configuration remains in atomically written JSON, including identity, network ports/ranges, UI preferences, directories, receive behavior, shortcuts, and file-cabinet root/default permission.

Database tests run through Electron's embedded Node via `ELECTRON_RUN_AS_NODE=1` because the native SQLite binary targets Electron ABI 110. Vitest runs pure repository logic that does not load the native module.

## 7. Data directories and authorization

Application-managed data contains configuration, databases, logs, avatars, image media, stickers, thumbnails, OCR assets/cache state, update packages, and partial transfers.

Renderer input cannot name arbitrary filesystem paths. A main-process file/folder picker creates a window-scoped, one-time authorization. Sticker import uses a separate grant store, consumes each selected path once, then applies extension, real-image, pixel, and source-size gates before reusing the existing WebP/GIF collection pipeline. Managed schemes (`pantry-img`, `pantry-sticker`, `pantry-avatar`, and thumbnail equivalents) validate identifier, record state, type, and managed-directory containment before returning bytes.

Path policy rejects absolute remote paths, traversal, drive prefixes, reserved names/characters, and canonical paths escaping an approved root. Cabinet access additionally rechecks `realpath` beneath the owner root.

## 8. Renderer architecture

`renderer/src/main.ts` dispatches by URL hash to four roots:

- `App.vue`: main window with Chat, Contacts, and File Cabinet tabs;
- `SettingsApp.vue`;
- `CaptureApp.vue`;
- `ImageViewerApp.vue`.

Pinia stores are projections of main-process state. They do not implement authoritative network/storage behavior. Explicit conversation navigation receives a monotonic generation; asynchronous IPC results verify generation and target conversation before committing, preventing stale navigation results from replacing the current view.

Media rendering uses validated image metadata, near-viewport observation, a bounded 320px WebP derivative cache, and native lazy/async image behavior. The cache is rebuildable, capped at 128 MiB, and never included in backup.

Windows 7 uses the tested system-font contenteditable composition path. Other systems use the textarea/mirror path. WebContents zoom replaces renderer CSS body zoom so IME/screen coordinates remain in Chromium's native transform chain.

## 9. Export and import

`.pantry-bak` is a ZIP-compatible migration archive:

```text
manifest.json
messages.jsonl
peers.json
groups.json
stickers.json
media/transfers/...
media/stickers/...
media/avatars/...
```

Import rewrites prior local `is_mine` senders to the current Node ID, merges newer peer metadata, and uses message IDs for deduplication. Only media present in the archive is restored into managed locations. Ordinary transferred files remain filename/history references and are not copied into the archive.

Readable export supports self-contained HTML and plain text. The custom archive reader/writer uses store/deflate and adds no runtime dependency.

## 10. Risks and controls

| Risk | Control |
|---|---|
| Electron 22 age | Strict local-only renderer, sandbox/isolation, blocked navigation, allowlisted inbound data |
| Windows 7 / UOS glyph differences | Project icons, local Twemoji, platform-specific composer paths |
| Debian 10 glibc 2.28 | Build native module inside Buster container and inspect GLIBC symbols in final package |
| Linux arm64 packaging | Native arm64 runner inside Buster container; pinned ffi/fpm; final architecture and GLIBC checks |
| Weak/old GPU drivers | Disable hardware acceleration by default on Windows 7 and Linux; software-rendering UI profile |
| Wayland and Linux desktop capture differences | Detect Wayland from `XDG_SESSION_TYPE` (falling back to `WAYLAND_DISPLAY`) and merge-enable Electron 22's `WebRTCPipeWireCapturer`, but still probe `desktopCapturer` instead of returning early. Wait for the main-window hide signal plus compositor settling and verify invisibility before capture. Restore and provide in-app or system-notification guidance for empty sources, empty images, or exceptions, including the system-capture + `Ctrl+V` fallback. |
| Broadcast isolation | Manual IP, rate-limited CIDR probe, gossip, persisted peer cache |
| Large files/images | Streaming file I/O, bounded metadata/decode, pixel limits, bounded thumbnail/OCR caches |
| Malformed/slow TCP peers | Exact frame allowlists, per-socket failure isolation, connection/stream/time budgets |
| Unsolicited update package | Source/version/platform/architecture-bound one-time gate and exact package/size/version checks |
| Arbitrary local path read | Picker authorization, managed schemes, record-state checks, canonical containment |
| Clock skew | Local monotonic sequence plus bounded peer-clock correction for display |
| 1,000-peer bursts | Jitter, rate limits, bounded inbound queues, aggregation before renderer projection |
| Compatibility-mode leakage | Separate socket/codec/service/projection; default off; implementation paused |

## 11. Build and CI

electron-builder settings:

| Platform | Targets | Architecture/baseline |
|---|---|---|
| Windows | NSIS and portable | x64 and ia32; Windows 7 SP1+ |
| Linux | deb and AppImage | x64 and arm64; Debian 10 / UOS 20 glibc baseline |
| macOS | dmg and zip | Apple Silicon arm64 |

`productName` is ASCII `Teahouse` for safe installation paths while platform display/shortcut names use 茶话间. Linux packaging disables hard-link copy optimization and validates that the deb archive has no cross-directory hard link or Chinese installation path.

GitHub Actions runs five platform jobs. Each validates package/tag versions, installs exact dependencies, rebuilds/checks native binaries, runs the standard five checks, builds artifacts, and emits SHA-256 manifests. A tag-triggered publish job downloads all artifacts, verifies artifact versions, generates bilingual release headings and package guidance, and creates/updates the GitHub Release with write permission limited to that job.

`package.json` is the version source. `package-lock.json`, `v<version>` tag, and every `Teahouse-<version>-...` artifact must match. Documentation/refinement increments patch; user-visible features increment minor and reset patch.

## 12. Test strategy

- Vitest for codec allowlists, pure utilities, service behavior, queueing, UI source/logic, and loopback network integration.
- Electron-ABI database self-test for migrations, repositories, and FTS.
- Type checks for Node 16 and Chrome 108 targets.
- Production build plus renderer bundle/reachability budgets.
- Electron launch smoke test.
- Real target-system validation for installation, startup, discovery, messaging, files, cabinet, tray, notifications, shortcuts, capture, and input methods.

Network integration binds `127.0.0.1` and uses empty broadcast targets. It must not contact the actual LAN.

## 13. Current milestone map

| Milestone | Main delivery |
|---|---|
| v0.1–v0.5 | Discovery, reliable private/group chat, files, media, capture, history/search, settings, export/import |
| v0.17–v0.18 | Scan-range sharing and global refresh |
| v0.27+ | Peer-update discovery and package request/transfer foundation |
| v0.28–v0.30 | Direct private files and media recall |
| v0.32+ | 200-member groups and UI/reliability hardening |
| v0.42–v0.44 | Content-addressed custom avatars and resilience |
| v0.45–v0.46 | File expiry, IME/composition, table paste, group creation recovery |
| v0.47–v0.49 | Shared file cabinet permissions, browsing, download, upload |
| v0.50–v0.51 | First-class cabinet navigation, finalized as the third main-window tab |
| v0.51.1 | Maintained English documentation, locale validation, bilingual release headings |
| v0.51.2 | Capability-first Wayland capture, verified main-window hiding, visible failure feedback |
| v0.52.0 | Native multi-image sticker import, stable scrolling grid, group sticker delivery to online members |
| Paused | Neiwangtong compatibility and experimental attachment interoperability |
| v1.0 work | Target-platform polish, updater completion, release documentation |

## 14. Change record

- **2026-08-10, v1.61, decision #285:** introduced the maintained English technical reference, document-pair validation, and bilingual release headings; corrected the public development guide to the actual PaddleOCR/onnxruntime-web stack. Runtime architecture, protocol, database, and dependencies are unchanged. Repository version 0.51.0 → 0.51.1.
- **2026-08-26, v1.62, decision #286:** merge-enabled Electron 22's `WebRTCPipeWireCapturer` for Wayland while retaining capability probing through `desktopCapturer`; extracted hide-signal/compositor settling with a final visibility check; and added a main-to-renderer `capture:failed` path plus system-notification fallback. Protocol v0.50, SQLite v14, dependencies, and network behavior are unchanged. Repository version 0.51.1 → 0.51.2.
- **2026-08-27, v1.63, decision #287:** reused the existing sticker compression/store action for a separately authorized native multi-image picker, fixed the grid with native implicit-row sizing, and routed group stickers through the existing `offerGroupPaths(..., 'sticker')` path. Protocol v0.50, SQLite v14, dependencies, and ports are unchanged. Repository version 0.51.2 → 0.52.0.
