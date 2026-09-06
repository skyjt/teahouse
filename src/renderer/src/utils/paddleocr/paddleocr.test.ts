import { describe, expect, it } from 'vitest'
import { DetectionService } from './processor/detection'
import { RecognitionService } from './processor/recognition'
import { Image } from './utils/image'
import type { OrtModule, OrtTensor } from './interface'

class Tensor implements OrtTensor {
  constructor(_type: string, public data: Float32Array, public dims: readonly number[]) {}
}

const ort = { Tensor } as OrtModule

describe('OCR 图像处理', () => {
  it('按行裁剪与逐像素复制在不同通道、边缘及整图区域输出一致', () => {
    for (const channels of [1, 3, 4]) {
      const source = Uint8Array.from({ length: 9 * 7 * channels }, (_, i) => i % 251)
      const image = new Image(9, 7, channels, source)
      for (const box of [{ x: 0, y: 0, width: 9, height: 7 }, { x: 2, y: 1, width: 4, height: 3 }, { x: 8, y: 6, width: 1, height: 1 }]) {
        const expected: number[] = []
        for (let y = box.y; y < box.y + box.height; y++) {
          for (let x = box.x; x < box.x + box.width; x++) {
            for (let c = 0; c < channels; c++) expected.push(source[(y * 9 + x) * channels + c])
          }
        }
        expect(image.crop(box).data).toEqual(new Uint8Array(expected))
      }
      expect(() => image.crop({ x: 8, y: 0, width: 2, height: 1 })).toThrow('out of bounds')
    }
  })

  it('识别继续使用扩边裁剪，返回原始文字框以对齐图片选字层', async () => {
    const width = 96
    const height = 64
    const detection = new Float32Array(width * height)
    for (let y = 20; y < 30; y++) {
      for (let x = 20; x < 50; x++) detection[y * width + x] = 1
    }
    const detector = new DetectionService(ort, {
      outputNames: ['output'],
      run: async () => ({ output: new Tensor('float32', detection, [1, 1, height, width]) })
    }, { maxSideLength: width })
    const image = new Image(width, height, 4, new Uint8Array(width * height * 4))
    const boxes = await detector.run(image)
    expect(boxes).toHaveLength(1)
    const [box] = boxes
    expect(box.textBox).toEqual({ x: 19, y: 19, width: 32, height: 12 })
    expect(box.width).toBeGreaterThan(box.textBox.width)
    expect(box.height).toBeGreaterThan(box.textBox.height)
    let inputShape: readonly number[] = []
    const recognizer = new RecognitionService(ort, {
      outputNames: ['output'],
      run: async (feeds) => {
        inputShape = feeds.x.dims
        return { output: new Tensor('float32', new Float32Array([0, 0.9, 1, 0, 0, 0.8]), [1, 3, 2]) }
      }
    }, { charactersDictionary: ['', '茶'] })
    const results = await recognizer.run(image, boxes)
    expect(inputShape).toEqual([1, 3, 48, Math.round(box.width * 48 / box.height)])
    expect(results[0]).toMatchObject({ text: '茶茶', box: box.textBox })
  })
})
