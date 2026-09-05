import type { ObjectDirective } from 'vue'
import { IMAGE_THUMBNAIL_MAX_EDGE } from '../../../shared/media'
import { imageMimeFromExt } from '../utils/clipboard'
import { BoundedLruCache } from '../utils/bounded-cache'

export interface CachedImageBinding {
  transferId: string
  cache?: boolean
}

interface CachedImageState {
  key: string
  generation: number
  loading: boolean
  loaded: boolean
  onLoad: () => void
  cancel?: () => void
}

interface PreviewJob {
  started: boolean
  listeners: Map<HTMLImageElement, (src: string) => void>
}

const states = new WeakMap<HTMLImageElement, CachedImageState>()
const pendingElements = new Map<Element, () => void>()
const previewJobs = new Map<string, PreviewJob>()
const completedPreviews = new BoundedLruCache<string, string>(512)
let runningPreviews = 0
let nearViewportObserver: IntersectionObserver | null = null

export function thumbnailTargetSize(
  width: number,
  height: number,
  maxEdge = IMAGE_THUMBNAIL_MAX_EDGE
): { width: number; height: number } {
  const ratio = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  }
}

function originalUrl(transferId: string): string {
  return `pantry-img://${transferId}`
}

function thumbnailUrl(transferId: string): string {
  return `pantry-thumb://${transferId}`
}

async function encodeThumbnail(
  bytes: ArrayBuffer,
  ext: string,
  width: number,
  height: number
): Promise<ArrayBuffer | null> {
  const target = thumbnailTargetSize(width, height)
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: imageMimeFromExt(ext) }), {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: 'medium'
    })
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'medium'
    context.drawImage(bitmap, 0, 0, target.width, target.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.82)
    )
    return blob ? blob.arrayBuffer() : null
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

async function resolvePreview(transferId: string): Promise<string> {
  try {
    if (await window.pantry.hasImageThumbnail(transferId)) return thumbnailUrl(transferId)
    const source = await window.pantry.fetchStickerSource(transferId)
    if (!source || source.animated) return originalUrl(transferId)
    if (Math.max(source.width, source.height) <= IMAGE_THUMBNAIL_MAX_EDGE) {
      return originalUrl(transferId)
    }
    const thumbnail = await encodeThumbnail(source.bytes, source.ext, source.width, source.height)
    if (!thumbnail) return originalUrl(transferId)
    const cached = await window.pantry.cacheImageThumbnail(transferId, thumbnail)
    return cached ? thumbnailUrl(transferId) : originalUrl(transferId)
  } catch {
    return originalUrl(transferId)
  }
}

function drainPreviews(): void {
  const limit = document.documentElement.dataset.rendering === 'hardware' ? 4 : 2
  for (const [id, job] of previewJobs) {
    if (runningPreviews >= limit) break
    if (job.started) continue
    job.started = true
    runningPreviews += 1
    void resolvePreview(id).then((src) => {
      completedPreviews.set(id, src)
      for (const apply of job.listeners.values()) apply(src)
    }).finally(() => {
      previewJobs.delete(id)
      runningPreviews -= 1
      drainPreviews()
    })
  }
}

function observer(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (nearViewportObserver) return nearViewportObserver
  nearViewportObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) pendingElements.get(entry.target)?.()
        else states.get(entry.target as HTMLImageElement)?.cancel?.()
      }
    },
    { rootMargin: '480px 0px' }
  )
  return nearViewportObserver
}

function startLoading(element: HTMLImageElement, binding: CachedImageBinding): void {
  const state = states.get(element)
  if (!state || state.loading || state.loaded || !binding.transferId) return
  state.loading = true
  const generation = state.generation
  const apply = (src: string): void => {
    const current = states.get(element)
    if (!current || current.generation !== generation) return
    current.cancel = undefined
    pendingElements.delete(element)
    nearViewportObserver?.unobserve(element)
    element.src = src
  }
  if (!binding.cache) return apply(originalUrl(binding.transferId))
  const cached = completedPreviews.get(binding.transferId)
  if (cached) return apply(cached)
  let job = previewJobs.get(binding.transferId)
  if (!job) {
    job = { started: false, listeners: new Map() }
    previewJobs.set(binding.transferId, job)
  }
  job.listeners.set(element, apply)
  const sharedJob = job
  state.cancel = () => {
    sharedJob.listeners.delete(element)
    if (!sharedJob.started && sharedJob.listeners.size === 0) previewJobs.delete(binding.transferId)
    state.loading = false
    state.cancel = undefined
  }
  drainPreviews()
}

function observe(element: HTMLImageElement, binding: CachedImageBinding): void {
  const load = (): void => startLoading(element, binding)
  const shared = observer()
  if (!shared) {
    load()
    return
  }
  pendingElements.set(element, load)
  shared.observe(element)
}

function reset(element: HTMLImageElement, binding: CachedImageBinding): void {
  const previous = states.get(element)
  previous?.cancel?.()
  if (previous) element.removeEventListener('load', previous.onLoad)
  pendingElements.delete(element)
  nearViewportObserver?.unobserve(element)
  element.removeAttribute('src')
  delete element.dataset.previewOriginalFallback
  element.dataset.previewLoading = 'true'
  element.dataset.previewTransferId = binding.transferId
  const state: CachedImageState = {
    key: `${binding.cache === false ? 'original' : 'thumb'}:${binding.transferId}`,
    generation: (previous?.generation ?? 0) + 1,
    loading: false,
    loaded: false,
    onLoad: () => {
      const current = states.get(element)
      if (!current) return
      current.loaded = true
      element.dataset.previewLoading = 'false'
    }
  }
  states.set(element, state)
  element.addEventListener('load', state.onLoad)
  observe(element, binding)
}

export const vCachedImage: ObjectDirective<HTMLImageElement, CachedImageBinding> = {
  mounted(element, binding) {
    reset(element, binding.value)
  },
  updated(element, binding) {
    const next = binding.value
    const key = `${next.cache === false ? 'original' : 'thumb'}:${next.transferId}`
    if (states.get(element)?.key !== key) reset(element, next)
  },
  unmounted(element) {
    const state = states.get(element)
    state?.cancel?.()
    if (state) element.removeEventListener('load', state.onLoad)
    states.delete(element)
    pendingElements.delete(element)
    nearViewportObserver?.unobserve(element)
  }
}
