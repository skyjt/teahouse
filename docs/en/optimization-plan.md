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
| OPT-24 | P2 | Clean up global-search debounce and stale requests | Complete (#295), v0.54.5 |
| OPT-25 | P2 | Reuse reactive message indexes and coalesce in-flight message/transfer reads | Complete (#296), v0.54.6 |
| OPT-26 | P1 | Single FTS aggregation with indexed summary lookup | Complete (#297), v0.54.7 |

| OPT-27 | P1 | Bound inactive conversation and unused terminal transfer caches | Complete (#298), v0.54.8 |

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
- **2026-09-05, decision #295:** OPT-24 preserves 200ms debounce and query semantics, invalidates stale callbacks on query change/unmount, and adds loading/failure placeholders with retry on new input. Planned version **0.54.5**.
- **2026-09-05, OPT-24 complete:** 662 tests and all five local checks passed with loopback smoke. Native macOS checks cover loading feedback, offline contact results, query changes, and message-hit navigation.
- **2026-09-05, decision #296:** OPT-25 reuses conversation-scoped reactive ID indexes and coalesces only in-flight historical-message/transfer reads. Success, missing values, and failures release requests; realtime transfer projections take precedence over earlier reads. Planned version **0.54.6**.
- **2026-09-05, OPT-25 complete:** 674 tests and all five local checks passed with loopback smoke. The real Electron window issued one message read when opening 50 same-source quotes; navigation, recalled/missing/cross-conversation hints, and ordinary input passed. Common startup is 80,252 bytes; App JS/CSS are 796,078/115,605 bytes, within all existing four-window budgets. OPT-23–25 are complete; Windows 7/UOS hands-on validation remains target-platform work.
- **2026-09-05, decision #297:** start the user-approved second September batch. OPT-26 preserves text/PK counts and ordering, all-type latest summaries, tokenizer/LIKE behavior, and existing limits. Use one MATCH plus indexed seq lookups, with the legacy lookup for non-unique seq values. Probe at 100k rows: common text 358.94 → 50.27ms; no-hit 2.75 → 2.74ms; high-match filenames 9.31 → 10.84ms. Planned version **0.54.7**.
- **2026-09-05, OPT-26 complete:** 674 tests and all five local checks passed, including v9 migration and field-by-field comparisons against the legacy queries. Real Electron Node 16.17.1 / ABI 110 / SQLite 3.45.3, eight alternating measured runs per implementation at 100k rows: common text **366.56 → 51.63ms (86% lower)**, no-hit **2.69 → 2.73ms**, high-match filenames **9.27 → 10.83ms**. Results are identical; aggregating all matching types adds about 1.6ms in the filename sample while preserving existing summary semantics.
- **2026-09-05, decision #298:** OPT-27 bounds inactive snapshots (10 conversations / 3000 messages) and unused terminal transfers (200), preserving active reading, undo, live transfers, displayed states, forwarding/retry, and late-result guards. Baseline: 100 conversations and two 50k-message/5k-terminal waves retained 104250 messages and 10000 transfer/sample entries; post-GC JS heap grew from 6.71 to 44.32MiB. Planned version **0.54.8**.
- **2026-09-05, OPT-27 complete:** 680 tests and all five local checks passed. The same 100-conversation/two-wave synthetic scenario reduced retained messages **104250 → 2400**, transfers **10000 → 200**, terminal samples **10000 → 0**, and post-GC JS heap **44.32 → 7.76MiB**. Tests preserve a 5000-message active history, undo, forwarding references, unread handling, and late page/push safety. Native macOS opened 15 conversations/300 file states and returned to the evicted first conversation with all 20 cards correctly restored. App JS is 797589 bytes; all four window budgets passed.
