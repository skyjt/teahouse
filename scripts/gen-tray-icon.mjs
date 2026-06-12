// 生成托盘图标（32×32 单色 logo）并输出 base64 —— 产物内嵌到 src/main/windows/tray-icon.ts。
// 纯 Node 实现 PNG 编码（IHDR/IDAT/IEND + zlib），不引依赖。用法：node scripts/gen-tray-icon.mjs
import { deflateSync } from 'node:zlib'

const SIZE = 32
const VIEWBOX = 64
const COLOR = [0x11, 0x11, 0x11] // 模板图：macOS 菜单栏按 alpha 自动着色

const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v))
const aa = 1.25

function strokeAlpha(distance) {
  return clamp(0.5 - distance / aa)
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : clamp((wx * vx + wy * vy) / len2)
  const dx = px - (ax + vx * t)
  const dy = py - (ay + vy * t)
  return Math.sqrt(dx * dx + dy * dy)
}

function capsule(px, py, ax, ay, bx, by, width) {
  return segmentDistance(px, py, ax, ay, bx, by) - width / 2
}

function roundedRectSdf(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - w / 2 + r
  const qy = Math.abs(py - (y + h / 2)) - h / 2 + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function roundedRectStroke(px, py, x, y, w, h, r, width) {
  return Math.abs(roundedRectSdf(px, py, x, y, w, h, r)) - width / 2
}

function handleStroke(px, py) {
  const dx = (px - 50.5) / 7.3
  const dy = (py - 38) / 7.2
  const angle = Math.atan2(dy, dx)
  if (Math.abs(angle) > 1.65) return 99
  return Math.abs(Math.sqrt(dx * dx + dy * dy) - 1) * 7.2 - 3.8 / 2
}

function markAlpha(px, py) {
  const distances = [
    roundedRectStroke(px, py, 14, 22, 36, 28, 8, 3.8),
    capsule(px, py, 20, 50, 20, 55, 3.8),
    capsule(px, py, 20, 55, 27.5, 50, 3.8),
    handleStroke(px, py),
    capsule(px, py, 24, 31.5, 44, 31.5, 3.8),
    capsule(px, py, 27.5, 15.5, 28.5, 9, 3.8),
    capsule(px, py, 37.5, 15.5, 36.5, 9, 3.8)
  ]
  return Math.max(...distances.map(strokeAlpha))
}

// RGBA 像素：同一 logo 轮廓 + 软边抗锯齿
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0 // filter: None
  for (let x = 0; x < SIZE; x++) {
    const px = ((x + 0.5) / SIZE) * VIEWBOX
    const py = ((y + 0.5) / SIZE) * VIEWBOX
    const alpha = markAlpha(px, py)
    const offset = y * (1 + SIZE * 4) + 1 + x * 4
    raw[offset] = COLOR[0]
    raw[offset + 1] = COLOR[1]
    raw[offset + 2] = COLOR[2]
    raw[offset + 3] = Math.round(alpha * 255)
  }
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])

console.log(png.toString('base64'))
