import { Menu, Tray, nativeImage } from 'electron'
import { TRAY_ICON_DATAURL } from './tray-icon'

export interface TrayDeps {
  showWindow: () => void
  quit: () => void
}

/**
 * 托盘常驻（F-SYS-1）。个别 Linux 桌面环境没有托盘协议 —— 创建失败不致命，
 * 返回 null，关窗行为由调用方降级为直接退出。
 */
export function setupTray(deps: TrayDeps): Tray | null {
  try {
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATAURL)
    if (process.platform === 'darwin') icon.setTemplateImage(true)
    const tray = new Tray(icon)
    tray.setToolTip('茶话间')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开茶话间', click: deps.showWindow },
        { type: 'separator' },
        { label: '退出', click: deps.quit }
      ])
    )
    // Windows/Linux 习惯：单击托盘直接唤起主窗
    tray.on('click', deps.showWindow)
    return tray
  } catch (err) {
    console.warn('[tray] 托盘不可用（桌面环境不支持），关窗将直接退出：', err)
    return null
  }
}
