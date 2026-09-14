# Contributing

> [简体中文](CONTRIBUTING.md) · [English](CONTRIBUTING.en.md)

Thank you for your interest in Teahouse. This guide covers local setup, multi-client development, validation, and the compatibility constraints every change must preserve.

## Prerequisites

- **Node.js 18 or later** for the development toolchain. The packaged application runs on Node 16.17.1 embedded in Electron 22.
- npm. The repository `.npmrc` pins the Electron ABI and uses `legacy-peer-deps` intentionally.
- Platform build dependencies are required only when producing installers.

The checked-in `.npmrc` uses npm mirror settings suitable for development in mainland China. You may override them with environment variables in another environment while keeping dependency versions unchanged.

## Quick start

```bash
git clone https://github.com/nameGXF/teahouse.git
cd teahouse
npm install
npm run dev
```

## Common commands

```bash
npm run dev          # Development with hot reload
npm run dev:2        # Start two isolated local clients
npm run dev:3        # Start three isolated local clients
npm run build        # Build main, preload, and renderer bundles
npm test             # Vitest unit and loopback integration tests
npm run test:db      # SQLite migration/repository/FTS tests on Electron's real ABI
npm run typecheck    # Node 16 and Chrome 108 type baselines
npm run smoke        # Build and launch for a clean 1.5-second smoke test
npm run dist:win     # Windows x64 NSIS and portable packages
npm run dist:linux   # Linux x64 deb and AppImage packages
npm run dist:mac     # macOS arm64 dmg and zip packages
```

## Local multi-client testing

The helper scripts give each instance a separate identity, data directory, and UDP/TCP port pair:

```bash
npm run dev:2
npm run dev:3

# Individual clients in separate terminals
npm run dev:client1  # /tmp/pantry-dev1, ports 17878 / 17879
npm run dev:client2  # /tmp/pantry-dev2, ports 27878 / 27879
npm run dev:client3  # /tmp/pantry-dev3, ports 37878 / 37879
```

Terminate the launcher with `Ctrl+C`.

## Hard constraints

Teahouse deliberately supports Windows 7 and older Linux systems. Preserve these constraints:

1. **Electron stays exactly at `22.3.27`.** Do not upgrade it or add a semver range.
2. **Main and preload code target Node 16.17.** Global `fetch` and `structuredClone` are unavailable. Use the Node 16 `net`, `dgram`, `http`, and filesystem APIs.
3. **Renderer code targets Chrome 108.** Native CSS nesting, Popover, `text-wrap: balance`, and subgrid are unavailable.
4. **Dependencies use exact versions.** Install additions with `npm i -E` only after checking Node 16 engine support. `better-sqlite3` is the sole permitted native module.
5. **The security baseline is fixed.** Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, blocked navigation, blocked `window.open`, strict CSP, and local-only renderer resources.
6. **Runtime operation is LAN-only.** Do not add telemetry, analytics, update checks, CDN fonts, remote images, third-party APIs, or any other Internet request.
7. **Inbound messages use allowlist validation.** Validate message type, length, and fields. Ignore unknown message types to preserve forward compatibility.
8. **Layer boundaries are enforced.** Renderer capabilities go through `window.pantry`; `net/` and `store/` remain Electron-free and independent; IPC handlers validate and forward; services own business orchestration.

Repository automation checkouts may provide additional local agent policy. Public contributors should treat this guide and the canonical design documents as the maintained constraints.

## Validation before delivery

Run the five standard checks in order:

```bash
npm test
npm run test:db
npm run typecheck
npm run build
npm run smoke
```

Network tests must bind to `127.0.0.1` with empty broadcast targets. Tests must never emit traffic onto the real LAN.

Documentation-localization changes should also run:

```bash
npm run check:docs
```

## Project layout

```text
pantry/
├─ src/
│  ├─ main/        # Main process: networking, SQLite, services, windows
│  ├─ preload/     # contextBridge boundary
│  ├─ renderer/    # Vue 3 and Pinia UI targeting Chrome 108
│  └─ shared/      # Dependency-free shared types and constants
├─ build/          # Icons and installer resources
├─ docs/           # Chinese canonical design documents and English current-state translations
├─ references/     # Local reference checkouts; external source trees are ignored
└─ scripts/        # Build, release, validation, and local-client helpers
```

For a detailed code map and data flows, see the [Development guide](DEVELOPMENT.en.md).

## Documentation policy

Simplified Chinese documents at their established paths are the canonical product and design records. English documents provide a maintained current-state translation. When a change affects documented behavior:

1. update the relevant Chinese source and append the next decision/change record where required;
2. update its English counterpart in the same commit;
3. preserve the bidirectional language links; and
4. run `npm run check:docs`.

Public user-facing and developer-facing English must read naturally and match actual behavior. Avoid placeholders and untranslated normative sections.

## Versioning and commits

Every complete increment updates the repository version:

- Features: increment the minor version and reset patch to zero.
- Fixes, documentation, and small refinements: increment the patch version.

Keep `package.json`, the root and top-level versions in `package-lock.json`, the release tag, and artifact names consistent. Commit subjects use a conventional prefix (`feat`, `fix`, `docs`, `refactor`, `test`, or `chore`) followed by a Simplified Chinese description.

## Packaging and releases

`.github/workflows/release.yml` builds and validates:

- Windows 7 SP1+ x64 and ia32: NSIS and portable executables;
- Debian 10 / UOS 20 x64 and arm64: deb and AppImage;
- macOS Apple Silicon: dmg and zip.

A `v*` tag triggers a GitHub Release after every platform job succeeds. Platform packages still require smoke tests on the target operating systems before a production rollout.

## Troubleshooting

If `npm install` on macOS reports `Electron failed to install correctly`, npm may have mishandled symlinks in the Electron archive. Extract the cached Electron 22.3.27 arm64 zip with `ditto` inside `node_modules/electron`, then write the executable path without a trailing newline:

```bash
ditto -xk ~/Library/Caches/electron/<cache-directory>/electron-v22.3.27-darwin-arm64.zip dist/
printf "Electron.app/Contents/MacOS/Electron" > path.txt
```
