// 生成托盘图标（32x32）并直接写入 src/main/windows/tray-icon.ts —— 内嵌 base64，
// 不走文件路径，开发/打包/asar 场景行为一致。改图标：替换彩色母版后重新运行。
// 两个版本（决议 #58/#107/#226）：
//   mono  —— macOS 菜单栏 template，由 build/icons/pantry-logo-mono.svg 渲染
//   color —— Windows / Linux 彩色版，由 build/icons/pantry-logo-icon.png 缩放
// 依赖系统 rsvg-convert 与 macOS sips；运行态仍只使用内嵌 Data URL，不依赖外部文件。
// 用法：node scripts/gen-tray-icon.mjs
import { execFileSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 32
const PNG_SIGNATURE = '89504e470d0a1a0a'

function readUint32(buffer, offset) {
  return buffer.readUInt32BE(offset)
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilterScanline(filter, line, prev, bpp) {
  const out = Buffer.from(line)
  for (let i = 0; i < out.length; i++) {
    const left = i >= bpp ? out[i - bpp] : 0
    const up = prev ? prev[i] : 0
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0
    if (filter === 1) out[i] = (out[i] + left) & 0xff
    else if (filter === 2) out[i] = (out[i] + up) & 0xff
    else if (filter === 3) out[i] = (out[i] + Math.floor((left + up) / 2)) & 0xff
    else if (filter === 4) out[i] = (out[i] + paethPredictor(left, up, upLeft)) & 0xff
    else if (filter !== 0) throw new Error(`不支持的 PNG filter: ${filter}`)
  }
  return out
}

function decodePngRgba(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('rsvg-convert 输出不是 PNG')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []

  while (offset < buffer.length) {
    const length = readUint32(buffer, offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      width = readUint32(data, 0)
      height = readUint32(data, 4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`不支持的 PNG 格式: bitDepth=${bitDepth} colorType=${colorType}`)
  }

  const channels = colorType === 6 ? 4 : 3
  const bpp = channels
  const stride = width * channels
  const inflated = inflateSync(Buffer.concat(idat))
  const rgba = Buffer.alloc(width * height * 4)
  let src = 0
  let prev = null

  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]
    const line = unfilterScanline(filter, inflated.subarray(src, src + stride), prev, bpp)
    src += stride
    prev = line
    for (let x = 0; x < width; x++) {
      const inOffset = x * channels
      const outOffset = (y * width + x) * 4
      rgba[outOffset] = line[inOffset]
      rgba[outOffset + 1] = line[inOffset + 1]
      rgba[outOffset + 2] = line[inOffset + 2]
      rgba[outOffset + 3] = channels === 4 ? line[inOffset + 3] : 255
    }
  }

  return { width, height, rgba }
}

function renderSvg(svgPath, workDir) {
  const out = join(workDir, `${basename(svgPath)}.png`)
  execFileSync('rsvg-convert', ['-w', String(SIZE), '-h', String(SIZE), svgPath, '-o', out], { stdio: 'pipe' })
  const png = readFileSync(out)
  const decoded = decodePngRgba(png)
  if (decoded.width !== SIZE || decoded.height !== SIZE) {
    throw new Error(`${basename(svgPath)} 渲染尺寸异常: ${decoded.width}x${decoded.height}`)
  }
  return { png, rgba: decoded.rgba }
}

function renderPng(pngPath, workDir) {
  const out = join(workDir, `${basename(pngPath)}-${SIZE}.png`)
  execFileSync('sips', ['-z', String(SIZE), String(SIZE), pngPath, '--out', out], { stdio: 'pipe' })
  const png = readFileSync(out)
  const decoded = decodePngRgba(png)
  if (decoded.width !== SIZE || decoded.height !== SIZE) {
    throw new Error(`${basename(pngPath)} 缩放尺寸异常: ${decoded.width}x${decoded.height}`)
  }
  return { png, rgba: decoded.rgba }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'build/icons')
const tmp = mkdtempSync(join(tmpdir(), 'pantry-tray-icon-'))

try {
  const mono = renderSvg(join(iconDir, 'pantry-logo-mono.svg'), tmp)
  // 模板图按 alpha 着色；轮廓缩小后必须保留实心像素，否则浅色菜单栏上会发虚。
  let opaquePixels = 0
  for (let i = 3; i < mono.rgba.length; i += 4) {
    if (mono.rgba[i] >= 240) opaquePixels++
  }
  if (opaquePixels < SIZE * SIZE * 0.05) {
    throw new Error('macOS 托盘图标轮廓过细：缩小后缺少足够的不透明像素')
  }
  const color = renderPng(join(iconDir, 'pantry-logo-icon.png'), tmp)
  const monoUrl = `data:image/png;base64,${mono.png.toString('base64')}`
  const colorUrl = `data:image/png;base64,${color.png.toString('base64')}`
  const colorRgba = color.rgba.toString('base64')

  const outFile = join(root, 'src/main/windows/tray-icon.ts')
  writeFileSync(
    outFile,
    `// 托盘图标（32x32，决议 #58/#107/#226）。由 scripts/gen-tray-icon.mjs 从单色 SVG / 彩色 PNG 生成后内嵌。
// 开发/打包/asar 场景行为一致。改图标：替换源资源后重新生成，不要手改本文件。
/** macOS 菜单栏单色 template（按 alpha 自动着色） */
export const TRAY_ICON_MONO_DATAURL =
  '${monoUrl}'
/** Windows / Linux 彩色填充版 */
export const TRAY_ICON_COLOR_DATAURL =
  '${colorUrl}'
/** Windows / Linux 未读闪烁帧叠角标用的 32x32 RGBA 底图 */
export const TRAY_ICON_COLOR_RGBA_BASE64 =
  '${colorRgba}'
`
  )
  console.log(`已写入 ${outFile}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
