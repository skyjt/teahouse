# Teahouse protocol design

> [简体中文](../protocol.md) · **English**

| Field | Value |
|---|---|
| Current protocol | v0.50 main protocol, proprietary UTF-8 JSON |
| Transport | IPv4 UDP control/message plane and TCP data/control fallback |
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
  "ver": "0.51.2",
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
  "resend": true
}
```

`kind` may be `text`, `group-text`, `recall`, `nudge`, or `pk`. Fields are valid only for the associated kind and are rejected when they violate the exact allowlist.

- Text at or below 800 bytes prefers UDP. Larger text, up to 4,096 bytes, uses TCP.
- A five-minute recall targets the original message ID. Receivers verify sender ownership and conversation context. Media recall additionally requires `mrec1` and a shared `offer.msgId`.
- Nudges are private, reliable immediate actions with no offline queue. Each peer pair allows at most two per 60 seconds and at least 15 seconds between accepted actions.
- PK messages carry the sender-generated immutable dice or rock-paper-scissors result. They are online-only, not queued, and retries reuse the same ID/result.
- Group mentions contain at most 50 Node IDs and affect notification emphasis without changing recipients.
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

Group metadata includes group ID, name, member IDs, monotonic revision, update timestamp/author, creator, owner, administrator IDs, optional avatar hash, and optional management-password hash/hint. Conflicts use last-writer-wins ordering by `(rev, updatedTs)` as a best-effort peer-to-peer rule.

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

- **2026-08-26, decision #286:** the Linux/Wayland capture fix adds only local desktop capability probing and main-to-renderer feedback. Wire protocol v0.50, capabilities, transfer sequencing, and compatibility behavior remain unchanged. Repository version 0.51.1 → 0.51.2.
