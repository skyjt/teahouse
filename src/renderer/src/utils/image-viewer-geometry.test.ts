import { describe, expect, it } from 'vitest'
import {
  imageRectForState,
  offsetForAnchoredZoom,
  pointFromImageRect
} from './image-viewer-geometry'

describe('image viewer geometry', () => {
  it('围绕鼠标所在图片坐标从适应窗口放大到原始大小', () => {
    const naturalWidth = 2400
    const naturalHeight = 1200
    const viewportWidth = 1200
    const viewportHeight = 800
    const fitZoom = 0.35
    const clientPoint = { x: 310, y: 260 }
    const initialRect = imageRectForState({
      naturalWidth,
      naturalHeight,
      zoom: fitZoom,
      offset: { x: 0, y: 0 },
      viewportWidth,
      viewportHeight
    })
    const imagePoint = pointFromImageRect({
      clientX: clientPoint.x,
      clientY: clientPoint.y,
      rect: initialRect,
      zoom: fitZoom,
      naturalWidth,
      naturalHeight
    })

    expect(imagePoint).not.toBeNull()
    const next = offsetForAnchoredZoom({
      clientPoint,
      imagePoint: imagePoint!,
      naturalWidth,
      naturalHeight,
      nextZoom: 1,
      viewportWidth,
      viewportHeight,
      minZoom: 0.005,
      maxZoom: 6
    })
    const finalRect = imageRectForState({
      naturalWidth,
      naturalHeight,
      zoom: next.zoom,
      offset: next.offset,
      viewportWidth,
      viewportHeight
    })

    expect(finalRect.left + imagePoint!.x * next.zoom).toBeCloseTo(clientPoint.x, 5)
    expect(finalRect.top + imagePoint!.y * next.zoom).toBeCloseTo(clientPoint.y, 5)
  })

  it('图片外的鼠标点不参与锚点放大', () => {
    const rect = { left: 100, top: 100, right: 500, bottom: 400 }

    expect(pointFromImageRect({
      clientX: 80,
      clientY: 180,
      rect,
      zoom: 0.5,
      naturalWidth: 800,
      naturalHeight: 600
    })).toBeNull()
  })
})
