# Teahouse optimization plan

> [简体中文](../optimization-plan.md) · **English**

This document translates the current status and execution boundaries of decisions #200 and #231. The detailed evidence and historical task notes remain in the [canonical Chinese plan](../optimization-plan.md).

## 0. Before starting optimization work

Read [Contributing](../../CONTRIBUTING.en.md), [handoff](handoff.md), [requirements](requirements.md), [protocol](protocol.md), [UI design](ui-design.md), and [technical design](tech-design.md), plus any local automation policy included in the development checkout.

For every item:

1. confirm it is still open in the canonical plan and current code;
2. define scope and acceptance criteria;
3. record a new decision/design update where behavior changes;
4. write or adjust focused tests;
5. implement within module boundaries;
6. run focused checks plus the standard five checks;
7. update item status and repository version.

Do not upgrade Electron, broaden runtime targets, add a native dependency, add an Internet request, relax inbound validation, or start a product-visible tradeoff without user approval.

## 1. Review summary

The original audit found resource handling, SQLite indexing/import complexity, renderer rerender pressure, scan scheduling, event coalescing, duplicated IPC/service code, and missing focused tests. The first 18 items and the second renderer-performance batch were implemented by decisions #200/#210. Later decisions extended low-end platform, media, and UI consistency work.

The codebase currently has bounded transfer streams, backpressure, append-only indexed storage, coalesced projections, split message rows, bounded renderer/media caches, lazy image loading, image pixel gates, and build closure budgets.

## 2. Item status

| Item | Priority | Topic | Status |
|---|---|---|---|
| OPT-1 | P0 | Apply 200-member group limit across IPC/import | Complete |
| OPT-2 | P0 | Catch file-receive filesystem failures | Complete |
| OPT-3 | P0 | Destroy sender read streams on socket termination | Complete |
| OPT-4 | P0 | Apply receive-side disk backpressure | Complete |
| OPT-5 | P1 | Add message sequence index | Complete |
| OPT-6 | P1 | Remove O(n²) backup import behavior | Complete |
| OPT-7 | P1 | Avoid full conversation list for every inbound mute check | Complete |
| OPT-8 | P1 | Isolate recall countdown rerenders | Complete |
| OPT-9 | P1 | Extract message-row rendering boundary | Complete |
| OPT-10 | P2 | Bound in-memory long-conversation messages | Complete |
| OPT-11 | P2 | Bound CIDR scan timers/scheduling | Complete |
| OPT-12 | P2 | Avoid unnecessary sorted peer lists | Complete |
| OPT-13 | P2 | Reuse prepared conversation search statement | Complete |
| OPT-14 | P2 | Network/service cleanup batch | Complete |
| OPT-15 | P2 | Coalesce full conversation projections | Complete |
| OPT-16 | P3 | Correct documentation drift | Complete; ongoing discipline applies |
| OPT-17 | P3 | Consolidate image-send IPC handling | Complete |
| OPT-18 | P3 | Add range-sync and peer-registry tests | Complete |
| OPT-19 | P1 | First Windows 7/UOS rendering, OCR, I/O budgets | Complete (#231) |
| OPT-20 | P1 | Lazy media loading and Naive UI reuse review | Complete (#232) |
| OPT-21 | P2 | Standard controls for group/contact profile surfaces | Complete (#233) |
| OPT-22 | P1 | Image pixel gate and bounded thumbnail cache | Complete (#234) |
| OPT-23 | P2 | Keep the conversation menu inside the viewport using measured dimensions | Complete (#294), v0.54.4 |

## 3. Continuing performance constraints

- Keep contact aggregation under the documented 1,000-peer budget and avoid renderer-side recomputation.
- Keep transfer progress throttled before renderer consumption.
- Keep files streamed and transfer concurrency/connection limits enforced.
- Keep image source dimensions/pixels and derivative cache sizes bounded.
- Preserve lazy decoding for chat images, search thumbnails, and stickers.
- Preserve four renderer entry reachability and bundle closure budgets.
- Keep blur disabled on software-rendering profiles and avoid blur on structural panes.
- Keep database migrations append-only and query plans indexed.
- Coalesce high-frequency full projections where exact per-event delivery has no product meaning.

## 4. Work that requires a new decision

- Message-list virtualization or a new scrolling model.
- A different component library or broad Naive UI migration.
- Encryption, server infrastructure, or protocol identity changes.
- New OCR models or larger packaged dictionaries.
- Replacing synchronous SQLite access with a worker or another database.
- Async redesign of cabinet directory listing contracts.
- Compatibility-mode implementation.

These choices affect product behavior, architecture, or risk and must be scoped in canonical documents before implementation.

## 5. Change record

- **2026-08-10, decision #285:** added an English current-state status and execution guide. Optimization status and runtime behavior are unchanged. Repository version 0.51.0 → 0.51.1.
- **2026-09-05, decision #294:** start the user-approved September review batch with OPT-23. Measure and clamp the conversation menu with an 8px CSS viewport margin, reposition on resize, and preserve actions, confirmation/undo, Escape handling, and page zoom. Planned repository version **0.54.4**.
- **2026-09-05, OPT-23 complete:** 656 tests and all five local checks passed, with loopback-only smoke. Native macOS checks cover bottom-edge menus at 100/110/125%, pin/mute, removal confirmation/undo, and Escape; geometry tests cover all corners and viewport shrink.
