# Teahouse UI and interaction design

> [简体中文](../ui-design.md) · **English**

| Field | Value |
|---|---|
| Current design | v1.80 for v0.54.1 |
| Main-window model | Three columns with Chat, Contacts, and File Cabinet tabs |
| Authority | [ui-design.md](../ui-design.md) is the canonical UI and interaction record |

## 1. Design direction

Teahouse uses the familiar structure of a stable desktop messenger, with restrained material, spacing, and feedback principles inspired by Apple platform design.

- **One accent:** tea green `#3D8B6B` for primary actions, selected states, and local-message tint. Other surfaces use neutral gray/green values.
- **System typography:** PingFang SC, Microsoft YaHei, and Noto Sans CJK fallbacks; 14px body text.
- **Project-owned line icons:** 1.6px rounded strokes, current-color inheritance, and no emoji as system controls.
- **Local cross-platform emoji:** bundled Twemoji SVG subsets support Windows 7 and UOS without a color emoji font. Clipboard and protocol retain original UTF-8 characters.
- **Unified brand:** the teacup speech-bubble image family supplies package, window, app, and tray assets. macOS menu bar uses a monochrome template.
- **Restrained motion:** 150–220ms easing, immediate pointer-down scale around 0.97–0.98, no decorative loops, and a reduced-motion path.
- **Purposeful material:** structural panes use lightweight surfaces and borders. Blur is reserved for actual overlays and is disabled in software-rendered Windows/Linux profiles.
- **Consistent shape scale:** 8–10px controls, 12–16px cards/panels, and 999px pills.
- **Token discipline:** every color, type size, radius, shadow, and motion value comes from `styles/tokens.css`.

Naive UI 2.43.2 provides standard form, search, and common action primitives through centralized Teahouse theme overrides. Navigation, chat bubbles, media/file/game cards, capture, image viewing, brand, and specialized cabinet interactions remain project components.

## 2. Main window

```text
┌────────┬────────────────────────┬──────────────────────────────────┐
│ Rail   │ List                   │ Content                          │
│ 68 px  │ 272 px                 │ flexible, at least 560 px        │
│        │                        │                                  │
│ avatar │ search / section       │ chat / contact / cabinet         │
│ chat   │ conversations/contacts │ header and primary content       │
│ people │                        │                                  │
│        │                        │                                  │
│ cabinet / refresh / settings    │ composer or cabinet action bar   │
└────────┴────────────────────────┴──────────────────────────────────┘
```

The minimum window is 960×640 and restores its previous size and position. The main Naive UI provider uses abstract mode so `.shell` retains a complete 100% height chain at default, minimum, maximized, and restored sizes.

### 2.1 Navigation rail

- Fixed 68px neutral surface with a subtle divider.
- Top identity avatar opens profile editing; main entries switch Chat and Contacts.
- Bottom tools, top to bottom: File Cabinet, global peer refresh, Settings.
- Main icons are 25px and lower tools 21px. Selected/hover state uses tea green.
- File Cabinet switches the existing main window to its third tab and remains available before a shared directory is configured.
- Global refresh is enabled only when a scan range exists. Every activation opens a centered confirmation with an amber warning icon, range count/list, Cancel, and Start scan. During scanning, the action is disabled and shows a conic progress ring.
- Icon tooltips appear only after real pointer movement and a short delay. They do not use native `title`, arrows, or translation motion.
- Hovering the local avatar for 120ms opens one profile card connected through an invisible pointer bridge. The card prioritizes avatar/nickname, local IPv4, organization/device rows, and a low-emphasis Node ID footer.

### 2.2 Frameless desktop behavior

Main and Settings windows use an immersive frameless layout. macOS keeps native traffic-light controls; Windows/Linux draw minimize, maximize/restore, and close controls. A 32px top drag region supports dragging and double-click maximize/restore. Linux uses a JavaScript drag implementation where CSS drag regions are unreliable.

Global overlays sit above the drag region. Settings is modal relative to the main window on Windows/Linux, with a static dim scrim and a visible 1px window inset for weak compositor shadows. macOS uses its native shadow without the main-window scrim.

## 3. Conversation list

Each row shows avatar and online dot, display name, latest-message summary, timestamp, and unread badge. Muted unread badges are gray. Pinned conversations appear first on a separate subtle background; remaining rows sort by latest message time.

The selected row uses a weak tea-green material and a 3px inset accent line. Preview text stays secondary. Summaries avoid revealing game outcomes and use semantic labels such as `[Image]`, `[File]`, or `[PK]`.

The context menu includes Pin, Mute, and Remove conversation. Removal opens a confirmation that explains history deletion. Confirmation removes the row immediately and displays a bottom-centered ten-second Undo capsule; expiry commits deletion of messages, FTS entries, and the conversation record.

The list `+` opens discussion-group creation with searchable multi-selection.

## 4. Contacts

```text
Discussion groups
Company (online/total)
  Department
    Team
      ● Online peer
      ○ Offline peer
Ungrouped
```

- Company, department, and team are collapsible; empty levels are skipped.
- Online peers sort first. Offline peers retain their row, use gray avatar/text, and show a gray status dot.
- A persistent search filters notes, nickname, organization, IP, and other contexts defined by requirements.
- A single click opens the complete contact profile in the content pane. It includes avatar, note/display name, status, organization, IP, hostname, platform, last-seen time, local-note editing, and a Send message action.
- A double click opens the private chat and triggers the secondary liveness probe.
- Discussion groups occupy a fixed section above organization trees.
- The paused compatibility mode reserves a separate Neiwangtong section and simplified profile; it does not mix compatibility peers into the Teahouse organization tree.

## 5. Chat content

### 5.1 Header

Private chat shows avatar/status dot, display name, and a complete single-line `status · IP` subtitle. Clicking the identity area opens a compact profile popover and note editor. Hover changes only the name color; the full hit target and keyboard focus ring remain.

Group chat shows a circular group avatar, name, and member count. The 84px chat header aligns with the list header: 32px drag space plus 52px content.

The right side contains conversation options. A group member count opens an overlay panel that covers the right side without resizing the message column. Private chat adds a File Cabinet button before the options menu. It is disabled with a specific tooltip when the peer is offline, unsupported, unshared, or denies access.

### 5.2 Messages

- Peer and local text bubbles use 14px corners and token colors. Local bubbles use a light tea-green tint.
- Images load bounded thumbnails near the viewport and open a validated original in Image Viewer.
- File cards show name, size, state, expiry, progress, and relevant receive/save/direct/cancel/resume actions.
- System rows remain low-emphasis and support the explicit cabinet-upload open-directory action.
- Emoji and stickers use local assets and lazy asynchronous decoding. The sticker tab offers a native multi-image import action, keeps square rows non-overlapping with vertical overflow, and enables sending in group conversations when at least one other member is online.
- Game bubbles reveal results only after local animation; notifications, list summaries, and search do not expose a hidden result early.
- Right-click menus provide context-appropriate copy, forward, recall, save, sticker, and other actions. Recall stays one row with a right-aligned monospaced countdown/reason; danger color intensifies during the final ten seconds.

The message area preserves a conversation's scroll position. Entry from notification, tray, nudge, or a newly opened conversation loads the latest page and scrolls to the bottom. A visible, focused current conversation may immediately mark an incoming message read; background, minimized, tray-hidden, or unfocused states retain unread status until focus returns.

### 5.3 Composer

The composer provides emoji, capture, image, file, and folder actions. It supports paste/drag/drop, draft persistence, Enter or Ctrl/Cmd+Enter sending, IME composition protection, dynamic height, and disabled/offline feedback.

Capture startup failures are never silent. When the main window was visible, it returns with a dismissible seven-second top-center status containing a warning icon, an explicit reason/fallback, `role=status`, and `aria-live=assertive`. A shortcut invoked from an already hidden window uses a system notification when available and reveals the app only as a fallback. Empty sources/images, hide failures, and exceptions all direct users to system capture plus chat-box `Ctrl+V` when built-in capture remains unavailable.

On ARM64 Wayland, Electron 22 screen enumeration is bypassed before the main window hides, so capture immediately uses that visible system-capture + `Ctrl+V` fallback instead of risking a native process crash. x64 Wayland, ARM64 X11, and other platforms retain the existing flow.

Table paste inserts text into the draft and shows a compact hint with Send as image and Ignore. Pressing the configured send key sends plain text. The hint disappears after draft or conversation changes. Oversized drafts keep a persistent explanatory error.

Windows 7 uses a system-font `contenteditable` composer with non-editable 1.3em Twemoji atoms to preserve Sogou IME candidate positioning. Other platforms use the textarea plus `PantryEmojiBlank` mirror path. Both routes preserve UTF-16 selection mapping and ignore send-key behavior while composition is active.

### 5.4 In-chat file cabinet panel

The private-chat cabinet panel overlays a 320px right column and can coexist with the conversation. It contains:

1. peer avatar/name, current permission badge, Open in File Cabinet, and Close;
2. parent/back, breadcrumb, and refresh controls;
3. compact 36px list rows with single-click selection and double-click folder navigation;
4. in-place progress and permission-specific download/upload actions;
5. persistent destination guidance.

It uses the same keyboard and context-menu semantics as the full cabinet tab. Opening one right-side panel closes any conflicting group/profile panel.

## 6. Search

Global search groups results into contacts, discussion groups, chat messages, and files. Results prefer local notes, show circular avatars and offline state, and jump to the relevant chat/message/file location.

Conversation history search opens a large focused panel from the composer toolbar. It defaults to recent records and supports text, image, file, and continuous date-range filters. Image results show thumbnails. Selecting a result restores the conversation and highlights the target message.

Search inputs debounce requests by 200ms and preserve keyboard focus/escape behavior.

## 7. Key flows

### 7.1 Create or manage a discussion group

Open the creation flow from the conversation list or add members from a private/group context. Search and select contacts, enter a name, optionally set management credentials, then submit once. Submission locks dismissal; a failed IPC restores controls and shows an inline error. The member panel exposes role-specific invite, remove, rename, owner/admin, avatar, and leave actions.

Group descriptions and announcements appear below the avatar in the member panel and take no space while empty. Owners, administrators, and password-authorized members edit either field through one shared Teleport modal. Description length is capped at 200 characters and announcement length at 1,024; saving an empty value clears existing content. Password members reuse the panel password input and inline error. The modal supports backdrop, Cancel, Escape, initial textarea focus, focus restoration, and a locked busy state.

### 7.2 Receive a file

An ordinary offer creates a file card with Receive and Save as. Default receive and private direct-send use `save directory/contact name/`; Save as uses the selected directory directly. Transfer progress remains on the card. A receiver cancellation keeps resume state when supported. Expiry removes receive/resume actions and gives each side an explicit terminal label.

### 7.3 Tray and notifications

Clicking a notification opens the exact conversation. Tray unread attention uses platform-appropriate icons/badges. Notifications respect focus/visibility, mute, content privacy, mentions, and nudge rules. Linux/Windows use a local app icon.

### 7.4 First launch

The setup flow collects the minimum required local identity and makes device-as-identity semantics clear. It uses the same brand and form tokens as Settings and never requests an Internet account.

### 7.5 Offline messages

Sending to an offline peer creates a waiting state. Automatic retry preserves ordering when presence returns. The UI never shows delivered until ACK succeeds.

### 7.6 Peer update

About shows a compact LAN Update row with status, help tooltip, and action. It searches online peers only, requests a package only after explicit action, and does not claim installation completion. Explanatory text stays in the accessible custom tooltip to keep the card compact.

### 7.7 Shared file cabinet

Open your cabinet from the navigation rail, or another peer's cabinet from the peer list/private chat. Permission, offline state, failures, selection, transfer progress, and destination guidance remain in the current cabinet surface without adding chat media entries.

## 8. Settings and file cabinet

### 8.1 Settings

Settings is a 640×480 frameless window with a direct left navigation: Profile, General, Notifications, Chat & Files, Network, Shortcuts, and About. Each row has an 18px project line icon. The sidebar does not repeat avatar/nickname summary content.

| Section | Current controls |
|---|---|
| Profile | Avatar mode/crop, nickname, company, department, team |
| General | Auto-start, close behavior, light/dark segmented control, 100/110/125% font zoom |
| Notifications | System notification, message-content privacy, optional sound |
| Chat & Files | Save directory, allow direct private files, Open File Cabinet guidance, send-key control, export/import, transfer records |
| Network | Manual peers, CIDR ranges, per-range refresh/remove, confirmed UDP/TCP port editing, paused compatibility placeholders |
| Shortcuts | Record-style capture and show/hide bindings, conflict error, restore defaults, hide app during capture |
| About | Brand/trust statement, version, GPL license, source link, LAN update status/action, expandable runtime and attribution details |

Profile, theme, and send-key choices share one segmented-control structure. Avatar cropping uses a global circular preview, drag, multiplicative zoom, reset, bounded high-quality 192×192 WebP output, validation errors, focus restoration, and reduced-motion behavior.

Port inputs stay read-only until a modal explains that discovery, messaging, and file transfer require matching configurations and firewall policy. Confirmation unlocks one field, focuses/selects it, validates 1–65535 on blur, then relocks it.

### 8.2 File Cabinet tab

The third main-window tab replaces the list and content columns while preserving the rail.

**List column:** a My File Cabinet summary card plus searchable colleagues whose profiles advertise `shr1`. Peers sort online first; offline and old/unsupported entries remain selectable and show an explanatory content state.

**Browser content:**

- 52px peer header under a 32px drag strip, permission badge, list/grid control, refresh;
- 40px breadcrumb row;
- 28px details header;
- 40px list rows or an adaptive five-column grid;
- bottom selection summary, Save as, Upload, Download, destination explanation, and in-place progress.

Desktop file-manager semantics apply: single-click select, double-click enter, Ctrl/Cmd toggle, Shift range, arrows, Space, Enter, Backspace/Cmd+Up, F5/Cmd+R, Ctrl/Cmd+A for loaded entries, and Escape clear. The context menu contains Download, Save as, and Copy filename. Delete, rename, remote overwrite, thumbnails, and client-side sorting are intentionally absent.

**My File Cabinet:** configure/open/change/stop the shared root, choose default Off/Read/Read+Upload, manage per-peer exceptions, and review the ten most recent completed incoming uploads. All changes save immediately. Invalid roots show a local inline reason.

**States:** setup guidance, empty folder, offline/unsupported/denied, first-page retry, load-more row retry that preserves loaded entries, a 5,000-entry truncation note, drag upload guidance, and explicit permission/destination explanations.

## 9. Visual tokens

| Token | Value or role |
|---|---|
| `--primary` | `#3D8B6B` tea green |
| `--text-1/2/3` | `#17211C` / `#58645E` / `#87918C` |
| `--text-placeholder` | `#B8B8B8` |
| `--bg-window/list/chat` | `#F9FBFA` / `#F1F5F3` / `#EDF2EF` |
| `--bubble-peer/mine` | white / 12% primary |
| `--line` | `rgba(40, 66, 53, 0.10)` |
| `--material-bar/panel/strong` | theme-specific structural surfaces |
| `--scrim` | theme-specific translucent modal backdrop |
| `--surface-hover/selected` | neutral 5% / tea green 12% |
| `--online/offline` | `#2BA245` / `#C2C2C2` |
| `--danger/badge` | `#E5484D` / `#FA5151` |
| `--font-xs/sm/md/lg` | 12 / 13 / 14 / 16px |
| Spacing | multiples of 4px |
| `--radius-control/panel/pill` | 8 / 12 / 999px |

Circular avatars, local line icons, file-type artwork, tray graphics, and brand art remain consistent across light/dark surfaces and supported operating systems.

## 10. Change record

- **2026-08-10, v1.75, decision #285:** added the maintained English current-state UI and interaction reference plus bidirectional language navigation. Product UI language and runtime behavior remain unchanged. Repository version 0.51.0 → 0.51.1.
- **2026-08-26, v1.76, decision #286:** made capture startup failures visible through a dismissible, accessible in-app status or a system notification when the app was already hidden; Linux capture now waits for window hiding and compositor settling to avoid including the app. Repository version 0.51.1 → 0.51.2.
- **2026-08-27, v1.77, decision #287:** added an accessible sticker-import action with progress/result feedback, sized four-column sticker rows to their square items inside the fixed 200px scrolling region, and enabled saved stickers in groups when another member is online. Repository version 0.51.2 → 0.52.0.
- **2026-08-29, v1.78, decision #289:** ARM64 Wayland capture now uses the existing visible system-capture paste fallback before Electron 22 native screen enumeration and before hiding the main window. Other platform flows are unchanged. Repository version 0.53.0 → 0.53.1.
- **2026-08-31, v1.79, decision #290:** added member-panel display, edit, and clear flows for group descriptions and announcements. Both fields share one accessible Teleport text modal and the existing password-aware management path; successful saves refresh the group view immediately, while failures preserve input and show inline feedback. Repository version 0.53.1 → **0.54.0**.
- **2026-09-05, v1.80, decision #291:** PR #39 review fixes use one `GroupTextDialog`. Ordinary members reuse the group panel's existing management password when saving either field; success refreshes the group view, failure preserves input, and switching dialogs clears stale feedback. Typography, radii, and the scrim use existing tokens. Repository version 0.54.0 → **0.54.1**.
