# Teahouse protocol design

> [简体中文](../protocol.md) · **English**

| Field | Value                                                               |
|---|---------------------------------------------------------------------|
| Current protocol | Custom JSON with envelope `v:1`; application v0.58.0 adds view-only screen sessions (#310) |
| Updated | 2026-09-16, #310 screen control, capabilities and demand-driven JPEG transport implemented |
| Transport | IPv4 UDP control/message plane and TCP data/control fallback        |
| Authority | [protocol.md](../protocol.md) is the canonical wire-protocol record |

## 1. Principles

1. Use proven LAN patterns: UDP discovery, UDP+ACK reliable messages, and receiver-initiated TCP file transfer.
2. Keep the Teahouse main protocol as bounded UTF-8 JSON. GBK/SJIS and IP Messenger text frames belong only in a separately enabled compatibility adapter.
3. Tolerate packet loss, duplication, reordering, peer restarts, and peers disappearing at any moment.
4. Carry a protocol version and ignore unknown message types or fields for forward compatibility.
5. Apply the trusted-LAN plaintext model while validating every inbound packet as untrusted data.
6. Support IPv4 in v1. IPv6 remains future work.

## 2. Transport overview

| Plane | Transport | Default port | Content |
|---|---|---|---|
| Control and messages | UDP broadcast/unicast | 17878 | Discovery, heartbeat, profile, gossip, short messages, ACK, transfer control |
| Data and fallback control | TCP | 17879 | File/image bytes, avatar responses, long messages, large control frames |

UDP payload is capped at **1,200 bytes** to avoid IP fragmentation. Oversized content uses the framed TCP control path. Both ports are configurable, and all peers on one deployment must agree on them.

The application broadcasts through every non-loopback IPv4 interface and listens on all interfaces by default. An explicit interface binding may be configured on hosts with many virtual adapters.

## 3. Peer identity and capabilities

`nodeId` is generated with `crypto.randomUUID()` on first launch and persisted locally. Nickname, hostname, and IP address may change without changing identity or conversation history.

Profiles carried by `entry`, `alive`, and `profile` include:

```jsonc
{
  "nodeId": "0d1f…",
  "nick": "Alex",
  "company": "Example Corp",
  "dept": "Engineering",
  "team": "Desktop",
  "avatar": 3,
  "profileRev": 7,
  "ver": "0.52.0",
  "host": "alex-pc",
  "platform": "win",
  "tcpPort": 17879,
  "caps": ["grp1", "img1", "shr1"]
}
```

String and array fields are length-bounded by the codec. `avatar` retains a numeric fallback: legacy nickname color, animal/background combinations, or nickname-initial background colors. Custom avatars use a separate SHA-256 declaration.

Known capability tokens:

| Capability | Meaning |
|---|---|
| `grp1` | Discussion groups |
| `img1` | Image messages |
| `av1` | Content-addressed custom avatar fetch |
| `mrec1` | Media recall through `offer.msgId` |
| `tbl1` | TSV metadata and image/text view for pasted tables |
| `fd1` | Private-chat direct file send |
| `tw1` | Transfer `wait` frames and recoverable receiver cancellation |
| `shr1` | Shared file-cabinet control and transfer purposes |
| `upd1` | This installed instance can provide a matching local update package |

Unknown tokens are ignored. `shr1` describes protocol support and does not grant access; the sharing peer evaluates its local permissions for every operation.

## 4. Envelope and compatibility

UDP messages and framed TCP control messages use one envelope:

```jsonc
{
  "v": 1,
  "type": "msg",
  "id": "uuid",
  "from": "nodeId",
  "ts": 1780000000000,
  "payload": {}
}
```

- Peers with the same major protocol version must interoperate.
- Ignore unknown `type` values and unknown fields.
- Drop missing, malformed, oversized, or invalid required fields and count the event locally.
- Do not send protocol errors for malformed UDP input, which avoids amplification.
- For profile-bearing packets, `profile.nodeId` must equal envelope `from`.
- An online Node ID remains bound to its current source IP and UDP port. A historical offline identity may move after a complete `entry`/`alive` handshake.

## 5. Message types

| Type | Direction | Plane | Purpose |
|---|---|---|---|
| `entry` | broadcast/unicast | UDP | Online announcement with profile |
| `alive` | unicast | UDP | Random-delayed entry response with profile |
| `exit` | broadcast | UDP | Graceful shutdown |
| `presence` | broadcast and routed-peer unicast | UDP | Heartbeat with sequence/profile revision |
| `profile` | broadcast/unicast | UDP | Profile change |
| `peers` | unicast | UDP | Known-peer gossip summary |
| `scan-ranges` | unicast | UDP | Low-rate CIDR configuration candidates |
| `msg` | unicast | UDP/TCP | User message kinds |
| `ack` | unicast | UDP/TCP | Reliable-control acknowledgement |
| `file-ctl` | unicast | UDP | Transfer offer/accept/decline/cancel/direct |
| `update` | unicast | UDP/TCP | Reliable peer-update request |
| `share` | unicast | UDP/TCP | File-cabinet list/get/deny control |
| `group` | unicast | UDP | Group metadata info/need |
| `avatar` | unicast | UDP/TCP | Content-addressed avatar request/data/miss |

Reliable control types use the same ACK/retry behavior. Large `msg`, `share`, and other eligible envelopes use the existing TCP control-frame fallback.

## 6. Discovery and presence

### 6.1 Entry sequence

```text
New A → broadcast entry
Online B/C → wait a randomized interval
B/C → unicast alive with complete profile
A → add each validated response to its online registry
A → broadcast exit on graceful shutdown
```

The response jitter begins at 0–2 seconds below 100 known peers and expands by one second per additional 100 peers, capped at 0–8 seconds. Peers suppress repeated entry/alive responses for a recently completed exchange. Inbound bursts may be queued and shed because later presence packets repair missed discovery.

### 6.2 Heartbeat and offline state

- Broadcast `presence` every 30 seconds and send rate-limited unicast presence to known online routed peers.
- If `profileRev` differs, send `entry`; the target responds with full `alive` profile data.
- Mark a peer offline after 90 seconds without any valid packet.
- When opening a conversation, unicast `entry` and mark the peer offline in the UI after about two seconds without `alive`.
- Exhausted message delivery immediately marks the peer offline and enters offline retry.

### 6.3 Routed-subnet discovery

1. Probe manually entered or imported IP addresses with unicast `entry`.
2. Probe configured CIDRs at at most 128 addresses per second after explicit user action.
3. Exchange recent peer summaries when a peer is first learned and every five minutes with two random online peers.

Gossip entries contain Node ID, IP, TCP port, and last-seen time. A receiver probes unknown entries seen within ten minutes and trusts them only after `alive`. Persist recent known peers and probe entries active in the last seven days on startup.

### 6.4 Scan-range sharing

`scan-ranges` carries up to ten valid IPv4 CIDRs, each expanding to no more than 1,024 hosts. It exchanges configuration candidates without causing immediate scans.

- Initial sharing is jittered by 2–10 minutes, then repeated every 60 minutes.
- Learned ranges enter a local queue with a 30–90 minute initial delay and a 12-hour per-range minimum interval.
- Above 50 online peers, a stable Node-ID/CIDR hash selects about 10% of clients to scan at roughly 16 addresses per second.
- Manual scans retain their 128-address-per-second path and bypass background throttling.
- Removing a learned range records a local ignore entry; manually adding it again clears the ignore entry.

## 7. Messaging

### 7.1 Payloads

```jsonc
{
  "kind": "text",
  "text": "Hello",
  "groupId": "uuid",
  "groupRev": 4,
  "mentions": ["nodeA"],
  "targetId": "uuid",
  "game": "dice",
  "result": 6,
  "resend": true,
  "replyTo": "uuid"
}
```

`kind` may be `text`, `group-text`, `recall`, `nudge`, or `pk`. Fields are valid only for the associated kind and are rejected when they violate the exact allowlist.

- Text at or below 800 bytes prefers UDP. Larger text, up to 4,096 bytes, uses TCP.
- A five-minute recall targets the original message ID. Receivers verify sender ownership and conversation context. Media recall additionally requires `mrec1` and a shared `offer.msgId`.
- Nudges are private, reliable immediate actions with no offline queue. Each peer pair allows at most two per 60 seconds and at least 15 seconds between accepted actions.
- PK messages carry the sender-generated immutable dice or rock-paper-scissors result. They are online-only, not queued, and retries reuse the same ID/result.
- Group mentions contain at most 200 Node IDs or the reserved "@all" value and affect notification emphasis without changing recipients.
- Group-text reply-to (decision #288): senders carry only the source message ID in `replyTo`. Receivers look up the source message in the local group conversation, populate `ReplyMeta` with `senderName` (remark preferred, then nick) and a first-line text summary, and store the source ID string in `messages.reply_to`. The codec accepts only bounded non-empty strings; empty strings and objects containing `senderName`/`text` are rejected. If the referenced message does not exist locally, receipt succeeds and the renderer handles the unavailable-target prompt.
- Images and stickers use one `file-ctl offer` as their sole cross-peer record. `purpose:"image"` or the sticker kind auto-accepts into managed media after local size/type checks.
- Table images may include at most 4,096 bytes of `tableText` and a `tableTextTruncated` flag when the recipient advertises `tbl1`.
- Receivers recompute `totalSize` from non-directory file entries and require equality with the declared value.

### 7.2 Reliability, deduplication, and offline retry

1. Send a reliable envelope and wait for an ACK from the actual target IP and UDP port.
2. Retry after 1, 2, and 4 seconds.
3. For eligible short messages, attempt one framed TCP fallback.
4. If delivery still fails, mark the peer offline and persist the original envelope.
5. Retry in original order when `entry`, `alive`, or `presence` returns.

Received envelope IDs remain in a persistent 24-hour deduplication set. Duplicates receive ACK and do not create another stored message. Offline queues retain seven days and at most 200 messages per peer. Retries preserve the original timestamp.

### 7.3 Discussion groups

Group metadata includes group ID, name, member IDs, monotonic revision, update timestamp/author, creator, owner, administrator IDs, optional avatar hash, optional management-password hash/hint, optional description (≤ 200 characters), and optional announce (≤ 1024 characters). Conflicts use last-writer-wins ordering by `(rev, updatedTs)` as a best-effort peer-to-peer rule. The owner, an administrator, or a member who knows the management password may modify `description` and `announce`; an empty string clears the field. A legacy packet that omits either field preserves the local known value and defaults to empty on first receipt. Local IPC and adjacent revisions allow only one operation. A cumulative full snapshot requires a revision gap covering each changed text field plus its recognized structural operation. Text management authorization and the existing structural permission checks must both pass; high revisions cannot bypass either check or allow unknown structural combinations (decision #292).

`group{op:"info"}` distributes complete metadata. `group{op:"need"}` requests it when a message references an unknown or newer revision. Group text and media are sent separately to each member with one logical message ID. Membership is capped at 200.

### 7.4 Custom avatars

Profiles and groups announce a lowercase 64-character SHA-256 hash. Peers advertising `av1` may exchange `avatar` request/data/miss operations. Data is bounded to a validated static 192×192 WebP. Managed storage verifies format, size, and hash before atomic placement. A group avatar may fail over among online group members; `miss` is best-effort to avoid old-client ACK behavior.

## 8. File transfer

`file-ctl offer` declares a transfer ID, purpose, total size, and a bounded file tree. Optional group context and message ID are admitted only for relevant chat-media purposes. The receiver accepts, declines, cancels, or requests direct acceptance according to exact operation schemas.

The data plane uses length-prefixed UTF-8 JSON control frames followed by raw bytes after `pull-ok`:

| Frame | Purpose |
|---|---|
| `msg` / `msg-ack` | Oversized message/control envelope and acknowledgement |
| `pull` | Receiver requests a transfer/file and offset |
| `pull-ok` | Sender authorizes and declares byte length |
| `done` | Sender provides full-file SHA-256 |
| `finish` | Receiver completed all files |
| `err` | Bounded reason such as `not-found` or `busy` |
| `wait` | `tw1` sender queue/hash heartbeat |

Every frame type has an exact field allowlist. IDs are bounded non-empty strings, offsets and lengths are non-negative safe integers, and SHA-256 is lowercase 64-character hexadecimal. A malformed frame terminates parsing and destroys only its socket.

Files stream without base64. The sender and receiver calculate SHA-256 while reading/writing. Resume uses the `.part` size as the next `pull.offset`. The receiver constrains every path to its approved destination and adds a suffix for collisions.

Resource budgets:

- Three active sender data streams; excess authorized pulls queue FIFO.
- At most 256 TCP connections.
- Valid first frame required within 15 seconds.
- 60-second active idle timeout.
- A `tw1` sender emits `wait` immediately and every 20 seconds while an authorized pull is queued or final hashing remains in progress.

Receiver cancellation retains `.part` and authorization when both peers support `tw1`; a later pull resumes. Sender cancellation revokes authorization and is terminal. Ordinary chat-file offers expire 24 hours after sending. A transfer already active at the deadline may finish, while a later failed/restarted attempt becomes expired.

Private-chat `direct` asks the receiver to auto-accept an existing ordinary file offer if local policy allows. Group transfers and unsupported peers ignore it. The default destination derives a sanitized local contact name; the remote peer never controls that directory component.

### 8.1 Peer-to-peer update packages

An update request is reliable and includes platform plus optional architecture. Before requesting, the receiver registers a one-time grant bound to source Node ID, target version, platform, and architecture for 120 seconds.

An incoming `purpose:"update"` offer must contain exactly one root file with a positive size at most 512 MiB and an exact platform/architecture package name. A valid offer consumes the grant, downloads into a temporary managed directory, verifies SHA-256, and checks package version. Cross-platform, unsolicited, oversized, portable/AppImage, or mismatched offers are declined by the current installed-package flow.

All traffic stays on the LAN. Applying and restarting through platform installers remains an incomplete product path.

### 8.2 Shared file cabinet

File cabinet adds no port and no data plane. Reliable `share` control uses UDP/TCP fallback, and bytes reuse the transfer protocol with `purpose:"share-get"` or `purpose:"share-put"`.

Permissions are evaluated only by the owner on every list, get, and put operation. Effective permission is a per-peer exception or the default: `off`, `read`, or `write`. Wire paths are always relative to the shared root.

```jsonc
// Browser → owner
{ "op":"list", "reqId":"uuid", "path":"design/2026", "offset":0, "snapshotId":"…" }

// Owner → browser
{ "op":"list-ok", "reqId":"uuid", "path":"design/2026", "perm":"read",
  "snapshotId":"…", "offset":0, "total":137, "truncated":false,
  "entries":[{"name":"cover.psd","size":10485760,"isDir":false,"mtime":1780000000000}] }

// Browser → owner
{ "op":"get", "reqId":"uuid", "paths":["design/2026/cover.psd"] }

// Owner → browser
{ "op":"deny", "reqId":"uuid", "reason":"off" }
```

The owner sorts directories first and names second, creates a 60-second paginated snapshot, and returns up to 200 entries/32 KiB per page. A directory is capped at 5,000 visible entries and may set `truncated:true`. Paths allow at most 16 segments and 1,024 bytes; selected names allow 255 bytes. Real paths are rechecked inside the resolved shared root and escaping symlinks are skipped or rejected.

A get request registers a 60-second, source-bound, one-time authorization before accepting a corresponding `share-get` offer. Up to 64 selected paths may be requested. Upload requires current `write` permission, at most 2 GiB total measured from entries, a valid shared root, and placement under a sanitized uploader-name directory. Neither purpose creates chat media records, FTS entries, recall actions, or 24-hour offer expiry. Completed uploads create one idempotent local system message.

Per-peer list rate is five requests per ten seconds. Requests time out after eight seconds and permit explicit retry. Transfer traffic shares the normal stream and connection budgets.

<a id="remote-view"></a>

### 8.3 Remote desktop viewing (#310, v0.58.0)

This section is implemented with protocol types, strict codec/frame allowlists and loopback tests. Envelope `v:1` and unknown-message compatibility remain unchanged. See [requirements](requirements.md#remote-view) and [technical design](tech-design.md#remote-view).

#### 8.3.1 Channels and capabilities

Add a `screen` envelope. `request/accept/reject` use existing reliable, non-queued messaging with ACK and TCP fallback. `end` is best effort and never delays local shutdown. No screen envelope enters chat storage or offline retry. Under #312, local services separately persist lifecycle metadata cards without images or credentials. Separate in-memory deduplication uses sender + message ID, capped at 256 entries for 120 seconds, without persistent dedup writes. Stopping aborts request/accept retries and TCP waits; cancellation does not mark the peer offline.

The viewer connects to the sharer's existing `profile.tcpPort` (default 17879). The shared listener routes by first frame; screen data uses a separate connection and bypasses file offers, file stream slots, queues, and disk. Do not add a listener. `rv1` means protocol support and receive/view availability; `rvs1` additionally means eligible local sharing, and requires `rv1`. Advertise after UDP/TCP readiness and a working lock-state detector; ARM64 Wayland advertises only receiving. Never trigger system capture consent at startup to discover a capability. User consent is still required for every session.

JPEG/TCP stays plaintext with no TLS, STUN/TURN, WebRTC media transport, or remote URLs. A random token isolates stale/wrong connections; it provides neither encryption nor authenticated identity.

#### 8.3.2 Control payloads

Each row describes the entire payload, validated by an exact per-operation allowlist. `sessionId` is a new viewer-generated UUID v4. Validate both envelope sender and actual inbound IP against the peer/session; a self-reported `from` alone is insufficient.

| op | Fields | Semantics |
|---|---|---|
| request | `op, sessionId` | Request only when online, role-compatible, and locally idle. |
| accept | `op, sessionId, token` | Sent after explicit local consent, screen selection, and capture readiness. Main generates 16 random bytes encoded as 32 lowercase hex characters; bind to session/viewer/IP and one connection. |
| reject | `op, sessionId, reason` | Reasons: `declined/busy/unsupported/permission-denied/capture-failed/timeout`. |
| end | `op, sessionId, reason` | Reasons: `user/canceled/timeout/locked/suspended/disconnected/capture-ended/protocol-error/app-exit`. No automatic recovery. |

Only a matching pending request may consume accept. Ignore late accepts and send best-effort end; never resurrect a window/connection. Duplicate requests never prompt/capture twice. Simultaneous opposing invitations reject the incoming request as busy instead of changing roles. Local monotonic deadlines avoid comparing wall clocks between machines. Cancel/reject/timeout records bounded `(peerId, sessionId)` tombstones so an end arriving before request cannot resurrect it. Only valid, rate-limited known-peer traffic may populate this cache; replay cannot extend expiry. Every asynchronous callback checks session generation.

#### 8.3.3 Connection and demand-driven frames

Request → consent/select/capture ready → accept → connect existing port → screen-open → screen-ready → screen-next(1) → screen-frame + JPEG → validate/decode/replace → screen-next(2). Keep at most one outstanding frame request. End, EOF, or deadline terminates both sides.

Reuse 4-byte big-endian length-prefixed JSON control frames and raw byte segments; retain the existing **64 KiB JSON limit**. Exact frame fields:

| type | Other fields | Rule |
|---|---|---|
| screen-open | `from, sessionId, token` | First screen frame only. Validate and consume the grant, then bind the socket before ready. |
| screen-ready | `sessionId` | Once only, after authorization. |
| screen-next | `sessionId, seq` | Positive safe integer, starting at 1 and increasing by one. No pipelining before the previous frame is fully consumed. |
| screen-frame | `sessionId, seq, width, height, len` | Echo the outstanding seq; validate metadata, then consume exactly len raw JPEG bytes without base64. |

Only role/state-appropriate frames for the bound session are accepted; no file/message multiplexing inside this connection. A bad handshake may use existing `err` before raw bytes begin. During a partial JPEG, destroy the socket on failure/stop; never insert end/err JSON into raw data. End reason travels separately and best effort; EOF/deadlines work even when it is lost.

Sample only on demand, with one encode/write at a time and bounded backpressure. Receive, validate, decode, and replace the local image before requesting again; DOM application suffices, without waiting for animation frames in minimized windows. Slow consumption lowers frame rate. Bytes already written to TCP cannot be selectively discarded; abort on the absolute frame deadline.

#### 8.3.4 Budgets and validation

| Constant | Value | Purpose |
|---|---|---|
| SCREEN_SESSION_MAX | 1 per node | Pending + active, either role |
| SCREEN_REQUEST_TIMEOUT_MS | 60,000 | From local request creation/receipt; includes picker/system permission time |
| SCREEN_CONNECT_TIMEOUT_MS | 15,000 | Grant deadline after sending accept; viewer connect/ready deadline after receiving it |
| SCREEN_FRAME_TIMEOUT_MS | 5,000 | From next to complete consumption; fragments cannot extend it |
| SCREEN_IDLE_TIMEOUT_MS | 10,000 | Bound socket waiting for next valid next; junk/replay does not renew it |
| SCREEN_MAX_FRAME_BYTES | 524,288 (512 KiB) | Check before allocation |
| SCREEN_MAX_EDGE / SCREEN_MAX_PIXELS | 1920 / 2,073,600 | Positive integer dimensions, each ≤1920; portrait allowed |
| SCREEN_MIN_FRAME_INTERVAL_MS | 100 | Auto initial target and hard ceiling of 10 fps (#310), measured between sampling starts |
| SCREEN_MAX_BYTES_PER_SECOND | 5,242,880 (5 MiB) | JPEG budget matching 512 KiB × 10 frames; at most one frame of credit, consumed on demand |
| SCREEN_REQUEST_INTERVAL_MS | 20,000 per peer | Limit new incoming/outgoing requests; existing global ingress limits remain |
| SCREEN_TERMINAL_TTL_MS / SCREEN_TERMINAL_MAX | 120,000 / 64 | In-memory terminal cache; evict oldest at capacity |

After metadata checks, reuse `shared/image-metadata.ts` `inspectImageMetadata` and require actual JPEG dimensions to match the header and pixel limits. Full decode failure ends the session. Apply the same byte/metadata checks to renderer-to-main output. Keep global TCP connection/first-frame budgets; screen sessions have their own single-session limit and consume no file stream slot. Pass actual `remoteAddress` through TCP control fallback as well as stream authorization; the callback now carries the source and validates it before screen deduplication or peer-address refresh. Address changes/restarts require a new session/grant.

Measure 100ms between sampling starts. After consuming a frame, wait only the remaining interval and byte budget, without adding another fixed 100ms sleep. Keep one outstanding request; slower encoding/network/decoding reduces achieved fps instead of adding parallel frames or catch-up queues. The 5 MiB/s limit counts JPEG payload, with small additional TCP/control overhead; actual links and low-end CPU need measurement.

## 9. Key constants

| Constant | Value |
|---|---|
| UDP/TCP ports | 17878 / 17879 |
| UDP maximum payload | 1,200 B |
| UDP/TCP text thresholds | 800 B / 4,096 B |
| ACK retry | 1s / 2s / 4s |
| Presence/offline | 30s / 90s |
| Scan rates | 128 addresses/s manual; about 16 addresses/s background |
| Peer cache / dedup | 7 days / 24 hours |
| Recall window | 5 minutes |
| Private/group inline image | 20 MiB / 10 MiB |
| Group members | 200 |
| Group description | ≤ 200 characters; clearable and optional on legacy packets |
| Group announce | ≤ 1,024 characters; clearable and optional on legacy packets |
| Avatar source/output | 20 MiB, 8,192px / 32 KiB WebP |
| Active transfer streams | 3 |
| Pull wait/idle | 20s / 60s |
| Ordinary file offer lifetime | 24 hours |
| Update package maximum | 512 MiB |
| Cabinet page/frame/directory | 200 / 32 KiB / 5,000 |
| Cabinet depth/path/name | 16 / 1,024 B / 255 B |
| Cabinet get selections | 64 |
| Cabinet request/auth timeout | 8s / 60s |
| Cabinet upload maximum | 2 GiB |

## 10. Security and evolution checklist

- Update [protocol.md](../protocol.md), then `src/shared/protocol.ts`, then `src/main/net/codec.ts`, then tests.
- Keep each inbound envelope/frame operation on an exact allowlist with bounded nesting and arrays.
- Keep unknown message types forward-compatible by ignoring them without an error reply.
- Keep paths relative and recheck canonical filesystem containment.
- Keep update and cabinet offers bound to short-lived, source-specific authorization.
- Never log message text, file bytes, or sensitive local paths.
- Keep the main protocol independent from the paused Neiwangtong adapter described in [nwt-compat-design.md](nwt-compat-design.md).

## 11. Change record

- **2026-09-16, #308, design only:** reserve §8.3 screen sessions, `rv1/rvs1`, demand-driven JPEG frames on the existing TCP listener, grants, backpressure, and validation/deadlines. Nothing is implemented or advertised; application **v0.57.0** and current wire behavior remain unchanged.

- **2026-09-16, #309, design only:** change the minimum interval to 100ms and JPEG budget to 5,242,880 bytes/s for the default 10 fps target. Retain one-frame backpressure and measure intervals between sampling starts. Current wire behavior and application version are unchanged.
- **2026-08-26, decision #286:** the Linux/Wayland capture fix adds only local desktop capability probing and main-to-renderer feedback. Wire protocol v0.50, capabilities, transfer sequencing, and compatibility behavior remain unchanged. Repository version 0.51.1 → 0.51.2.
- **2026-08-27, decision #287:** local sticker import and grid sizing do not affect the wire. Group stickers reuse the existing `file-ctl offer` fields `purpose:"sticker"`, `groupId/groupRev`, and per-online-member transfer behavior; no field, capability, or port was added. Wire protocol remains v0.50. Repository version 0.51.2 → 0.52.0.
- **2026-08-29, decision #288:** group-text reply-to. The `group-text` payload gains an optional `replyTo` source-message-ID string. The codec accepts only bounded non-empty strings and rejects empty strings or objects with `senderName`/`text`. Receivers look up the source ID in the local group conversation, populate `ReplyMeta` with sender name and first-line text summary, and store the raw ID in `messages.reply_to`. If the target is absent locally, receipt succeeds and the renderer handles the unavailable-target prompt. Protocol advances to v0.51; SQLite advances to v15. Repository version 0.52.0 → **0.53.0**.
- **2026-08-29, decision #289:** the ARM64 Wayland capture crash prevention changes only local `desktopCapturer` gating and existing failure feedback. Wire protocol v0.51, capabilities, ports, and transfer behavior are unchanged. Repository version 0.53.0 → **0.53.1**.
- **2026-08-31, decision #290:** group description and group announcement. `GroupMeta` gains backward-compatible optional `description` (≤ 200 characters) and `announce` (≤ 1024 characters) fields. `GroupPatch` gains `set-description` and `set-announce` operations for owners, administrators, or password-holding members. The codec validates present fields while accepting legacy omission; normalization preserves local known values. Inbound metadata rejects unauthorized or mixed changes. SQLite migration v16 adds both columns, and migration backups preserve them. The renderer uses one shared modal from `GroupPanel`, supports clearing, and routes updates through the existing password-aware admin path. Wire protocol remains v0.51; SQLite advances to v16. Repository version 0.53.1 → **0.54.0**.
- **2026-09-05, decision #291:** PR #39 review fixes add no wire field. The codec continues accepting omitted description and announcement fields; the service accepts only one text change authorized by an owner, administrator, or correct management password and rejects text bundled with an invite, rename, or second text change. Wire protocol remains v0.51; SQLite remains v16. Repository version 0.54.0 → **0.54.1**.
- **2026-09-05, decision #292:** restored `need/info` catch-up when intermediate revisions are missing. Cumulative text changes may accompany a recognized structural operation only with a sufficient revision gap and independent authorization. Adjacent mixed operations, unauthorized text edits, and invalid structure changes remain rejected. No wire fields were added; protocol v0.51 and SQLite v16 remain unchanged. Repository version 0.54.1 → **0.54.2**.

- 2026-09-16, decision #310: v0.58.0 implements view-only remote assistance, independent windows, Auto (10/5/3 fps) and manual Economy/Standard/Smooth modes. Consent, one-frame backpressure, bounded deadlines, lock detection and forced window cleanup are covered by local tests. Physical target-platform permission and performance checks remain pending; this iteration is not a release.

## Assistance interaction refinement (#312)

Decision #312 (2026-09-17, v0.59.0): screen control packets remain transient and are never queued or persisted. Local services separately retain lifecycle metadata as chat system cards, without credentials or images. No wire changes.

## Discovery and scan reliability (decision #317, v0.60.2)

Unknown heartbeats trigger throttled full-profile handshakes. Optional `probeId` in entry/alive and capability `dp1` correlate fresh replies; directed replies bypass discovery jitter with a one-second per-peer limit. Active probes use a two-second deadline with one retry for dp1 peers, or twenty seconds with a retry at ten seconds for legacy peers. Equal profile revisions use sender timestamps to reject delayed data; a matching fresh reply resolves clock rollback/ties. Legacy peers without correlation retain best-effort timestamp ordering.

Global, single-range and background scans share one queue: manual work takes priority while background progress is retained. Minimum address delays remain 8ms/62ms. Completion records the scan time and schedules the next round after twelve hours plus thirty-to-ninety-minute jitter; restart, deletion, eligibility and shutdown are checked. Range advertisements require an online peer and matching source IP/UDP port. Gossip sends at most one packet per target per 50ms and coalesces duplicate requests. Bridges distribute addresses; endpoints still require direct UDP/TCP reachability. No dependencies or database migrations are added.


### PR #42 integration (decision #318, v0.61.0)

Preserves nameGXF's mention keyboard navigation, remark/nickname filtering, committed IME @ detection and mention-everyone support. Only the complete keywords 所有人 / 全体 / all / everyone expose the everyone candidate, so a short name query cannot select everyone by default. Arrow keys wrap; Enter confirms only a currently valid token. Caret/selection changes invalidate the picker, and mouse confirmation also revalidates the range without overwriting following prose. Composition keys and keyCode 229 remain native; both @ and full-width ＠ can open the picker.

Any current group member may mention everyone. Delivery remains per-member unicast excluding the sender; former members cannot send. The reserved mentions value `"@all"` marks the conversation and emphasizes notification titles while preserving mute, notification and focused-window gates. Older clients, including v0.60.3, receive the text without everyone emphasis. No new field, capability, database schema, dependency or external request. Editing the label into a different token removes the outgoing broadcast marker.

Official repository, download, issue and source links remain skyjt/teahouse; fork migration is excluded. This feature increments v0.60.3 to v0.61.0. The original PR's #308–#310 conflict with upstream decision numbers, so this integration uses #318. Twemoji SVGs are packaged as separate local assets loaded on demand, reducing inline graphics parsed by each window without raising JS/CSS budgets or changing Electron 22 / Chrome 108.
