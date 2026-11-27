import { tr } from './i18n'

// 展示用的数值格式化（决议 #281）。
// 收在一处的原因：文件卡、传输记录、设置页与文件柜面板原先各写一份，
// 同一个字节数在不同界面上会显示成「12 MB」和「12.3 MB」两种样子。

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * 字节数转人类可读文本。
 * 字节没有小数可言；其余单位下 ≥10 取整、<10 保留一位——
 * 既不让「1 MB」丢掉精度，也不让「1234.6 MB」这种长数字撑爆行宽。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${UNITS[unit]}`
}

export function formatCabinetTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${mm}-${dd}`
  const sameDay = d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? tr('今天 {0}:{1}', { 0: hh, 1: mi }) : `${mm}-${dd} ${hh}:${mi}`
}
