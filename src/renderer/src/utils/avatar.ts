export const AVATAR_EMOJIS = [
  '🍵',
  '☕',
  '📚',
  '💡',
  '🧭',
  '📌',
  '✏️',
  '💻',
  '🗂️',
  '🎧',
  '🎨',
  '🧩',
  '⭐',
  '🌙',
  '🌿',
  '🍀',
  '🔥',
  '⚡',
  '💎',
  '🚀'
]

export const BUILTIN_AVATARS = AVATAR_EMOJIS

export const AVATAR_COLORS = [
  { name: '茶青', bg: '#3D8B6B', fg: '#FFFFFF' },
  { name: '湖蓝', bg: '#2F80A7', fg: '#FFFFFF' },
  { name: '靛蓝', bg: '#5366B3', fg: '#FFFFFF' },
  { name: '紫藤', bg: '#7B5BA7', fg: '#FFFFFF' },
  { name: '莓红', bg: '#B65072', fg: '#FFFFFF' },
  { name: '枫红', bg: '#B75D4A', fg: '#FFFFFF' },
  { name: '杏黄', bg: '#C88A2D', fg: '#FFFFFF' },
  { name: '橄榄', bg: '#6F7F3F', fg: '#FFFFFF' },
  { name: '石墨', bg: '#55616D', fg: '#FFFFFF' },
  { name: '墨青', bg: '#2F6F73', fg: '#FFFFFF' }
]

const EMOJI_COUNT = AVATAR_EMOJIS.length

export function avatarText(avatar: number, displayName: string): string {
  if (avatar >= 0) return AVATAR_EMOJIS[avatarEmojiIndex(avatar)]
  return displayName.trim().slice(0, 1) || '茶'
}

export function avatarEmojiIndex(avatar: number): number {
  if (!Number.isInteger(avatar) || avatar < 0) return -1
  return avatar % EMOJI_COUNT
}

export function avatarColorIndex(avatar: number, displayName = ''): number {
  if (Number.isInteger(avatar) && avatar >= 0) {
    return Math.floor(avatar / EMOJI_COUNT) % AVATAR_COLORS.length
  }
  return nameHash(displayName || '茶') % AVATAR_COLORS.length
}

export function avatarValue(emojiIndex: number, colorIndex: number): number {
  const emoji = clampIndex(emojiIndex, EMOJI_COUNT)
  const color = clampIndex(colorIndex, AVATAR_COLORS.length)
  return color * EMOJI_COUNT + emoji
}

export function avatarStyle(
  avatar: number,
  displayName = ''
): { backgroundColor: string; color: string } {
  const color = AVATAR_COLORS[avatarColorIndex(avatar, displayName)]
  return { backgroundColor: color.bg, color: color.fg }
}

function clampIndex(value: number, length: number): number {
  return Number.isInteger(value) && value >= 0 && value < length ? value : 0
}

function nameHash(text: string): number {
  let hash = 0
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash
}
