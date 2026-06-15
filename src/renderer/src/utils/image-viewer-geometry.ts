export interface ImagePoint {
  x: number
  y: number
}

export interface ImageRect {
  left: number
  top: number
  right: number
  bottom: number
}

export function pointFromImageRect(params: {
  clientX: number
  clientY: number
  rect: ImageRect
  zoom: number
  naturalWidth: number
  naturalHeight: number
}): ImagePoint | null {
  const { clientX, clientY, rect, zoom, naturalWidth, naturalHeight } = params
  if (zoom <= 0) return null
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null
  }
  return {
    x: clamp((clientX - rect.left) / zoom, 0, naturalWidth),
    y: clamp((clientY - rect.top) / zoom, 0, naturalHeight)
  }
}

export function offsetForAnchoredZoom(params: {
  clientPoint: ImagePoint
  imagePoint: ImagePoint
  naturalWidth: number
  naturalHeight: number
  nextZoom: number
  viewportWidth: number
  viewportHeight: number
  minZoom: number
  maxZoom: number
}): { zoom: number; offset: ImagePoint } {
  const zoom = clamp(params.nextZoom, params.minZoom, params.maxZoom)
  const nextWidth = params.naturalWidth * zoom
  const nextHeight = params.naturalHeight * zoom
  return {
    zoom,
    offset: {
      x: params.clientPoint.x - params.viewportWidth / 2 + nextWidth / 2 - params.imagePoint.x * zoom,
      y: params.clientPoint.y - params.viewportHeight / 2 + nextHeight / 2 - params.imagePoint.y * zoom
    }
  }
}

export function imageRectForState(params: {
  naturalWidth: number
  naturalHeight: number
  zoom: number
  offset: ImagePoint
  viewportWidth: number
  viewportHeight: number
}): ImageRect {
  const width = params.naturalWidth * params.zoom
  const height = params.naturalHeight * params.zoom
  const left = params.viewportWidth / 2 + params.offset.x - width / 2
  const top = params.viewportHeight / 2 + params.offset.y - height / 2
  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
