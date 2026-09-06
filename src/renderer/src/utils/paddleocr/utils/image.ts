import type { Box } from "../interface";

interface CropOptions {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ResizeOptions {
    width?: number;
    height?: number;
    filter?: "triangle";
}

interface PaddingOptions {
    padding?: number;
    vertical?: number;
    horizontal?: number;
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    color?: number[];
}

interface TensorOptions {
    mean_values: [number, number, number];
    norm_values: [number, number, number];
}

interface DilateOptions {
    norm?: "LInf";
    k?: number;
}

interface ThresholdOptions {
    threshold?: number; // 阈值，默认128
}

interface ContoursOptions {
    minArea?: number;
}

interface RectOptions {
    x: number;
    y: number;
    width: number;
    height: number;
    lineWidth?: number;
    color?: number[];
}

export class Image {
    width: number;
    height: number;
    data: Uint8Array;
    depth: 8;
    channels: number;

    /**
     * 创建一个新的 Image 实例。
     * @param width 图像的宽度
     * @param height 图像的高度
     * @param data 图像数据，Uint8Array
     */
    constructor(width: number, height: number, channels: number, data: Uint8Array) {
        this.width = width;
        this.height = height;
        this.channels = channels;
        this.depth = 8;
        if (data) {
            this.data = data;
        } else {
            const length = width * height * 4;
            this.data = new Uint8Array(length); // Default to RGBA
        }
    }

    /**
     * 裁剪
     */
    crop(options: CropOptions) {
        const { x, y, width, height } = options;
        if (x < 0 || y < 0 || x + width > this.width || y + height > this.height) {
            throw new Error("Crop area is out of bounds");
        }
        const croppedData = new Uint8Array(width * height * this.channels);
        const rowLength = width * this.channels;
        for (let j = 0; j < height; j++) {
            const srcIndex = ((y + j) * this.width + x) * this.channels;
            croppedData.set(this.data.subarray(srcIndex, srcIndex + rowLength), j * rowLength);
        }
        return new Image(width, height, this.channels, croppedData);
    }

    /**
     * 将图片缩放到指定的尺寸w
     * @param options
     */
    resize(options: ResizeOptions) {
        let { width, height } = options;
        if (width === undefined && height === undefined) {
            throw new Error("At least one of width or height must be specified");
        }
        if (width === undefined) {
            width = Math.round(this.width * ((height ?? this.height) / this.height));
        }
        if (height === undefined) {
            height = Math.round(this.height * (width / this.width));
        }

        const srcW = this.width;
        const srcH = this.height;
        const dstW = width;
        const dstH = height;
        const channels = this.channels;
        const srcData = this.data;

        function triangle_kernel(x: number) {
            x = Math.abs(x);
            return x < 1 ? 1 - x : 0;
        }

        function clamp(v: number, min: number, max: number): number {
            return Math.max(min, Math.min(max, v));
        }

        // 1. 纵向采样
        const tmpData = new Float32Array(srcW * dstH * channels);
        const ratioY = srcH / dstH;
        const sratioY = ratioY < 1 ? 1 : ratioY;
        const supportY = 1.0 * sratioY;

        for (let outy = 0; outy < dstH; outy++) {
            const inputy = (outy + 0.5) * ratioY - 0.5;
            const left = Math.max(0, Math.floor(inputy - supportY));
            const right = Math.min(srcH, Math.ceil(inputy + supportY));

            const ws: number[] = [];
            let sum = 0;
            for (let i = left; i < right; i++) {
                const w = triangle_kernel((i - inputy) / sratioY);
                ws.push(w);
                sum += w;
            }
            for (let i = 0; i < ws.length; i++) ws[i] /= sum;

            for (let x = 0; x < srcW; x++) {
                for (let c = 0; c < channels; c++) {
                    let t = 0;
                    for (let i = 0; i < ws.length; i++) {
                        const srcIdx = ((left + i) * srcW + x) * channels + c;
                        t += srcData[srcIdx] * ws[i];
                    }
                    tmpData[(outy * srcW + x) * channels + c] = t;
                }
            }
        }

        // 2. 横向采样
        const dstData = new Uint8Array(dstW * dstH * channels);
        const ratioX = srcW / dstW;
        const sratioX = ratioX < 1 ? 1 : ratioX;
        const supportX = 1.0 * sratioX;

        for (let outx = 0; outx < dstW; outx++) {
            const inputx = (outx + 0.5) * ratioX - 0.5;
            const left = Math.max(0, Math.floor(inputx - supportX));
            const right = Math.min(srcW, Math.ceil(inputx + supportX));

            const ws: number[] = [];
            let sum = 0;
            for (let i = left; i < right; i++) {
                const w = triangle_kernel((i - inputx) / sratioX);
                ws.push(w);
                sum += w;
            }
            for (let i = 0; i < ws.length; i++) ws[i] /= sum;

            for (let y = 0; y < dstH; y++) {
                for (let c = 0; c < channels; c++) {
                    let t = 0;
                    for (let i = 0; i < ws.length; i++) {
                        const srcIdx = (y * srcW + (left + i)) * channels + c;
                        t += tmpData[srcIdx] * ws[i];
                    }
                    dstData[(y * dstW + outx) * channels + c] = Math.round(clamp(t, 0, 255));
                }
            }
        }

        return new Image(dstW, dstH, channels, dstData);
    }

    /**
     * 为图片添加指定颜色的边距，默认为透明的
     * @param options
     */
    padding(options: PaddingOptions) {
        // 解析边距
        let { padding, vertical, horizontal, top, bottom, left, right, color } = options;
        // 优先级：padding > vertical/horizontal > top/bottom/left/right
        if (typeof padding === "number") {
            top = bottom = left = right = padding;
        } else {
            if (typeof vertical === "number") {
                top = bottom = vertical;
            }
            if (typeof horizontal === "number") {
                left = right = horizontal;
            }
        }
        top = top ?? 0;
        bottom = bottom ?? 0;
        left = left ?? 0;
        right = right ?? 0;
        color = color ?? [0, 0, 0, 0];
        const newW = this.width + left + right;
        const newH = this.height + top + bottom;
        const newData = new Uint8Array(newW * newH * 4);
        // 填充背景色
        for (let y = 0; y < newH; y++) {
            for (let x = 0; x < newW; x++) {
                const idx = (y * newW + x) * 4;
                newData[idx] = color[0];
                newData[idx + 1] = color[1];
                newData[idx + 2] = color[2];
                newData[idx + 3] = color[3];
            }
        }
        // 拷贝原图
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const srcIdx = (y * this.width + x) * 4;
                const dstIdx = ((y + top) * newW + (x + left)) * 4;
                newData.set(this.data.subarray(srcIdx, srcIdx + 4), dstIdx);
            }
        }
        return new Image(newW, newH, this.channels, newData);
    }

    /**
     * 将当前图像转换为张量格式，以便输入到onnx模型
     * @param options
     */
    tensor(options: TensorOptions): Float32Array {
        const mean = options.mean_values;
        const norm = options.norm_values;
        const width = this.width;
        const height = this.height;
        const numChannels = 3;
        const rgbaData = this.data;
        const tensor = new Float32Array(width * height * numChannels);
        for (let h = 0; h < height; h++) {
            for (let w = 0; w < width; w++) {
                const pixelIndex = (h * width + w) * this.channels;
                const tensorIndex = h * width + w;
                for (let c = 0; c < numChannels; c++) {
                    const pixelValue = rgbaData[pixelIndex + c];
                    const normalizedValue = pixelValue * norm[c] - mean[c] * norm[c];
                    tensor[c * height * width + tensorIndex] = normalizedValue;
                }
            }
        }
        return tensor;
    }

    /**
     * 灰度图阈值方法，大于阈值的像素点设为255，小于等于阈值的设为0
     * @param options
     */
    threshold(options: ThresholdOptions) {
        const threshold = options.threshold ?? 128;
        const width = this.width;
        const height = this.height;
        // 创建二值化图像
        const binData = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            binData[i] = this.data[i * this.channels] > threshold ? 255 : 0;
        }
        return new Image(width, height, 1, binData);
    }

    /**
     * 膨胀操作，使用指定的范数和核大小
     * 进行处理的图片像素是0和255，膨胀255的像素点
     * 返回一个新的图片
     * @param options
     */
    dilate(options: DilateOptions = {}): Image {
        const { norm = "LInf", k = 1 } = options;
        if (norm !== "LInf") {
            throw new Error("Only LInf norm is supported");
        }
        if (this.channels !== 1) {
            throw new Error("Dilate only supports single channel (grayscale) images");
        }
        const width = this.width;
        const height = this.height;
        const src = this.data;
        // 1. 计算每个像素到最近前景像素(255)的LInf距离
        // 初始化距离图，前景为0，背景为无穷大
        const INF = 999999;
        const dist = new Uint16Array(width * height);
        for (let i = 0; i < width * height; i++) {
            dist[i] = src[i] > 0 ? 0 : INF;
        }
        // 两次扫描，先左上到右下，再右下到左上
        // LInf: 只需看8邻域的最小距离+1
        // 正向
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (dist[idx] === 0) continue;
                let minDist = INF;
                for (let dy = -1; dy <= 0; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx,
                            ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                            const nidx = ny * width + nx;
                            minDist = Math.min(minDist, dist[nidx] + 1);
                        }
                    }
                }
                dist[idx] = Math.min(dist[idx], minDist);
            }
        }
        // 反向
        for (let y = height - 1; y >= 0; y--) {
            for (let x = width - 1; x >= 0; x--) {
                const idx = y * width + x;
                if (dist[idx] === 0) continue;
                let minDist = INF;
                for (let dy = 0; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx,
                            ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                            const nidx = ny * width + nx;
                            minDist = Math.min(minDist, dist[nidx] + 1);
                        }
                    }
                }
                dist[idx] = Math.min(dist[idx], minDist);
            }
        }
        // 2. 距离小于等于k的像素设为255，否则为0
        const out = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            out[i] = dist[i] <= k ? 255 : 0;
        }
        return new Image(width, height, 1, out);
    }

    /**
     * 获取图像中的轮廓
     * @returns
     */
    contours(options: ContoursOptions = {}): Box[] {
        // Suzuki/Abe 边界跟踪算法，输入为灰度图，输出 Box[]
        const minArea = options.minArea ?? 1;
        const width = this.width;
        const height = this.height;
        // 二值化
        const bin = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            bin[i] = this.data[i] > 0 ? 1 : 0;
        }
        // 轮廓提取
        const visited = new Uint8Array(width * height);
        const boxes: Box[] = [];
        const at = (x: number, y: number) => y * width + x;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (bin[at(x, y)] && !visited[at(x, y)]) {
                    // BFS 寻找连通域
                    let minX = x,
                        minY = y,
                        maxX = x,
                        maxY = y,
                        area = 0;
                    const queue = [[x, y]];
                    visited[at(x, y)] = 1;
                    while (queue.length) {
                        const current = queue.shift();
                        if (!current) {
                            break;
                        }
                        const [cx, cy] = current;
                        area++;
                        minX = Math.min(minX, cx);
                        minY = Math.min(minY, cy);
                        maxX = Math.max(maxX, cx);
                        maxY = Math.max(maxY, cy);
                        for (const [dx, dy] of [
                            [-1, 0],
                            [1, 0],
                            [0, -1],
                            [0, 1],
                            [-1, -1],
                            [1, -1],
                            [-1, 1],
                            [1, 1],
                        ]) {
                            const nx = cx + dx,
                                ny = cy + dy;
                            if (
                                nx >= 0 &&
                                nx < width &&
                                ny >= 0 &&
                                ny < height &&
                                bin[at(nx, ny)] &&
                                !visited[at(nx, ny)]
                            ) {
                                visited[at(nx, ny)] = 1;
                                queue.push([nx, ny]);
                            }
                        }
                    }
                    if (area >= minArea) {
                        boxes.push({
                            x: minX,
                            y: minY,
                            width: maxX - minX + 1,
                            height: maxY - minY + 1,
                        });
                    }
                }
            }
        }
        return boxes;
    }

    /**
     * 在图像上绘制矩形，支持线宽
     * @param x 左上角x
     * @param y 左上角y
     * @param width 矩形宽度
     * @param height 矩形高度
     * @param color 颜色 [r,g,b,a]
     * @param lineWidth 线宽
     */
    rect(options: RectOptions) {
        const { x, y, width, height, color = [], lineWidth = 1 } = options;
        if (!color.length) {
            color.push(...Array(this.channels).fill(255));
        }
        if (this.channels !== color.length) {
            throw new Error(
                `Color length ${color.length} does not match image channels ${this.channels}`
            );
        }
        // 上下边
        for (let dy = 0; dy < lineWidth; dy++) {
            for (let i = 0; i < width; i++) {
                // 上边
                const yy = y + dy;
                const xx = x + i;
                if (yy >= 0 && yy < this.height && xx >= 0 && xx < this.width) {
                    const idx = (yy * this.width + xx) * this.channels;
                    this.data.set(color, idx);
                }
                // 下边
                const by = y + height - 1 - dy;
                if (by >= 0 && by < this.height && xx >= 0 && xx < this.width) {
                    const idx = (by * this.width + xx) * this.channels;
                    this.data.set(color, idx);
                }
            }
        }
        // 左右边
        for (let dx = 0; dx < lineWidth; dx++) {
            for (let j = 0; j < height; j++) {
                // 左边
                const xx = x + dx;
                const yy = y + j;
                if (xx >= 0 && xx < this.width && yy >= 0 && yy < this.height) {
                    const idx = (yy * this.width + xx) * this.channels;
                    this.data.set(color, idx);
                }
                // 右边
                const rx = x + width - 1 - dx;
                if (rx >= 0 && rx < this.width && yy >= 0 && yy < this.height) {
                    const idx = (yy * this.width + rx) * this.channels;
                    this.data.set(color, idx);
                }
            }
        }
    }

    /**
     * 以png格式输出到指定位置
     * @param path 输出路径
     */
    // async saveAsPng(path: string) {
    //     try {
    //         const { encode } = await import("fast-png");
    //         const pngData = encode({
    //             width: this.width,
    //             height: this.height,
    //             depth: this.depth,
    //             channels: this.channels,
    //             data: this.data,
    //         });
    //         const { writeFile } = await import("fs/promises");
    //         await writeFile(path, pngData);
    //     } catch (e) {
    //         console.error(`Failed to save image as PNG: ${e}`);
    //         throw e;
    //     }
    // }
}
