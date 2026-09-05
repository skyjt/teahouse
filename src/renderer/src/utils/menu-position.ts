/** 指针、实测菜单尺寸和视口均使用 CSS 像素，兼容既有页面缩放。 */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - height - 8))
  }
}
