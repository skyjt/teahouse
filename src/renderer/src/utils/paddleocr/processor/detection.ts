import { DEFAULT_DETECTION_OPTIONS } from "../constants";
import type {
    Box,
    DetectionRuntimeOptions,
    OcrProgress,
    OrtInferenceSession,
    OrtModule,
    PaddleOcrProgressEvent,
} from "../interface";
import { Image } from "../utils/image";

export interface ResizeParams {
    srcWidth: number;
    srcHeight: number;
    dstWidth: number;
    dstHeight: number;
    scaleWidth: number;
    scaleHeight: number;
}

/**
 * Result of preprocessing an image for text detection
 */
export interface PreprocessDetectionResult {
    tensor: Float32Array;
    resizeParams: ResizeParams;
}

export interface DetectionRunOptions extends Partial<DetectionRuntimeOptions> {
    onProgress?: (event: PaddleOcrProgressEvent) => void;
}

/**
 * Service for detecting text regions in images
 */
export class DetectionService {
    private static readonly TOTAL_PROGRESS_STEPS = 3;
    private readonly options: DetectionRuntimeOptions;
    private readonly session: OrtInferenceSession;
    private readonly ortModule: OrtModule;

    constructor(
        ortModule: OrtModule,
        session: OrtInferenceSession,
        options: Partial<DetectionRuntimeOptions> = {}
    ) {
        this.session = session;
        this.ortModule = ortModule;

        this.options = {
            ...DEFAULT_DETECTION_OPTIONS,
            ...options,
        };
    }

    /**
     * Main method to run text detection on an image
     * @param image ArrayBuffer of the image or Canvas
     */
    async run(image: Image, options: DetectionRunOptions = {}): Promise<Box[]> {
        const { onProgress, ...runtimeOverrides } = options;
        const runtimeOptions = this.resolveRuntimeOptions(runtimeOverrides);
        const input = await this.preprocessDetection(image, runtimeOptions);
        onProgress?.({
            type: "det",
            stage: "preprocess",
            progress: this.createProgress(1),
        });

        const detection = await this.runInference(input.tensor, input.resizeParams);
        onProgress?.({
            type: "det",
            stage: "infer",
            progress: this.createProgress(2),
        });

        const detectedBoxes = detection
            ? this.postprocessDetection(detection, input, runtimeOptions)
            : [];
        onProgress?.({
            type: "det",
            stage: "postprocess",
            progress: this.createProgress(3),
            detectedCount: detectedBoxes.length,
        });

        return detectedBoxes;
    }

    private resolveRuntimeOptions(
        options: Partial<DetectionRuntimeOptions> = {}
    ): DetectionRuntimeOptions {
        return {
            ...this.options,
            ...options,
        };
    }

    private createProgress(current: number): OcrProgress {
        return {
            current,
            remain: DetectionService.TOTAL_PROGRESS_STEPS - current,
            total: DetectionService.TOTAL_PROGRESS_STEPS,
        };
    }

    /**
     * Preprocess an image for text detection
     */
    private async preprocessDetection(
        image: Image,
        runtimeOptions: DetectionRuntimeOptions
    ): Promise<PreprocessDetectionResult> {
        const resizeParams = this.calculateResizeDimensions(image, runtimeOptions);

        const resizedImage = image.resize({
            width: resizeParams.dstWidth,
            height: resizeParams.dstHeight,
        });
        const tensor = resizedImage.tensor({
            mean_values: runtimeOptions.mean,
            norm_values: runtimeOptions.stdDeviation,
        });

        return {
            tensor,
            resizeParams,
        };
    }

    /**
     * Calculate dimensions for resizing the image
     */
    private calculateResizeDimensions(image: Image, runtimeOptions: DetectionRuntimeOptions) {
        const MAX_SIDE_LEN = runtimeOptions.maxSideLength;
        const { width: srcWidth, height: srcHeight } = image;
        const ratio = srcWidth > srcHeight ? MAX_SIDE_LEN / srcWidth : MAX_SIDE_LEN / srcHeight;
        let dstWidth = Math.floor(srcWidth * ratio);
        let dstHeight = Math.floor(srcHeight * ratio);
        // Ensure dimensions are multiples of 32 for model compatibility
        if (dstWidth % 32 !== 0) dstWidth = Math.max(Math.floor(dstWidth / 32) * 32, 32);
        if (dstHeight % 32 !== 0) dstHeight = Math.max(Math.floor(dstHeight / 32) * 32, 32);
        const scaleWidth = dstWidth / srcWidth;
        const scaleHeight = dstHeight / srcHeight;

        return {
            srcHeight,
            srcWidth,
            dstHeight,
            dstWidth,
            scaleWidth,
            scaleHeight,
        };
    }

    /**
     * Run the detection model inference
     */
    private async runInference(
        tensor: Float32Array,
        resizeParams: ResizeParams
    ): Promise<Float32Array | null> {
        const inputTensor = new this.ortModule.Tensor("float32", tensor, [
            1,
            3,
            resizeParams.dstHeight,
            resizeParams.dstWidth,
        ]);

        const feeds = { x: inputTensor };
        const results = await this.session.run(feeds);
        const outputTensor = results[this.session.outputNames[0] || "fetch_name_0"];
        if (!outputTensor) {
            return null;
        }

        return outputTensor.data as Float32Array;
    }

    /**
     * Process detection results to extract bounding boxes
     */
    private postprocessDetection(
        detection: Float32Array,
        input: PreprocessDetectionResult,
        runtimeOptions: DetectionRuntimeOptions
    ): Box[] {
        const { dstWidth, dstHeight } = input.resizeParams;
        const greyImage = new Image(
            dstWidth,
            dstHeight,
            1,
            new Uint8Array(detection.map((v) => Math.round(v * 255)))
        );
        const thresholdedImage = greyImage.threshold({
            threshold: 255 * runtimeOptions.textPixelThreshold,
        });
        const dilateImage = thresholdedImage.dilate({
            norm: "LInf",
            k: runtimeOptions.dilationKernelSize,
        });
        const boxes = dilateImage.contours({
            minArea: runtimeOptions.minimumAreaThreshold,
        });
        const finalBoxes = boxes.map((box) => {
            const paddedBox = this.applyPaddingToRect(box, dstWidth, dstHeight, runtimeOptions);
            const finalBox = this.convertToOriginalCoordinates(paddedBox, input.resizeParams);
            return finalBox;
        });
        return finalBoxes;
    }

    /**
     * Apply padding to a rectangle
     */
    private applyPaddingToRect(
        rect: { x: number; y: number; width: number; height: number },
        maxWidth: number,
        maxHeight: number,
        runtimeOptions: DetectionRuntimeOptions
    ) {
        const paddingVertical = runtimeOptions.paddingBoxVertical;
        const paddingHorizontal = runtimeOptions.paddingBoxHorizontal;
        const verticalPadding = Math.round(rect.height * paddingVertical);
        const horizontalPadding = Math.round(rect.height * paddingHorizontal);

        let x = rect.x - horizontalPadding;
        let y = rect.y - verticalPadding;
        let width = rect.width + 2 * horizontalPadding;
        let height = rect.height + 2 * verticalPadding;

        x = Math.max(0, x);
        y = Math.max(0, y);

        const rightEdge = Math.min(maxWidth, rect.x + rect.width + horizontalPadding);
        const bottomEdge = Math.min(maxHeight, rect.y + rect.height + verticalPadding);
        width = rightEdge - x;
        height = bottomEdge - y;

        return { x, y, width, height };
    }

    /**
     * Convert coordinates from resized image back to original image
     */
    private convertToOriginalCoordinates(
        rect: { x: number; y: number; width: number; height: number },
        resizeParams: ResizeParams
    ): Box {
        const scaledX = rect.x / resizeParams.scaleWidth;
        const scaledY = rect.y / resizeParams.scaleHeight;
        const scaledWidth = rect.width / resizeParams.scaleWidth;
        const scaledHeight = rect.height / resizeParams.scaleHeight;

        const x = Math.max(0, Math.round(scaledX));
        const y = Math.max(0, Math.round(scaledY));
        const width = Math.min(resizeParams.srcWidth - x, Math.round(scaledWidth));
        const height = Math.min(resizeParams.srcHeight - y, Math.round(scaledHeight));

        return { x, y, width, height };
    }
}
