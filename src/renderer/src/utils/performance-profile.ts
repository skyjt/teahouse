import type { AppInfo } from '../../../shared/ipc'

type PerformanceProfile = Pick<AppInfo, 'softwareRendering'>

export function applyPerformanceProfile(
  profile: PerformanceProfile,
  root: HTMLElement = document.documentElement
): void {
  root.dataset.rendering = profile.softwareRendering ? 'software' : 'hardware'
}
