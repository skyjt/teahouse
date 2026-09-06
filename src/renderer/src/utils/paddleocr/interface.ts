import type { RecognitionResult } from "./processor/recognition";

export interface ImageInput {
    width: number;
    height: number;
    data: Uint8Array;
}

/**
 * Runtime parameters for text detection.
 * 字段在内部统一由 DEFAULT_DETECTION_OPTIONS 兜底为必填；外部传参一律用 Partial 包装。
 */
export interface DetectionRuntimeOptions {
    padding: number;

    /**
     * Per-channel mean values used to normalize input pixels [R, G, B].
     * @default [123.675, 116.28, 103.53]
     */
    mean: [number, number, number];

    /**
     * Per-channel standard deviation values used to normalize input pixels [R, G, B].
     * @default [0.017124753831663668, 0.01750700280112045, 0.015378700499807768]
     */
    stdDeviation: [number, number, number];

    /**
     * Maximum dimension (longest side) for input images, in pixels.
     * Images above this size will be scaled down, maintaining aspect ratio.
     * @default 960
     */
    maxSideLength: number;

    /**
     * Padding applied to each detected box vertically as a fraction of its height.
     * @default 0.4
     */
    paddingBoxVertical: number;

    /**
     * Padding applied to each detected box horizontally as a fraction of its height.
     * @default 0.6
     */
    paddingBoxHorizontal: number;

    /**
     * Remove detected boxes with area below this threshold, in pixels.
     * @default 20
     */
    minimumAreaThreshold: number;

    textPixelThreshold: number;

    /**
     * Kernel size used in detection dilation post-processing.
     * @default 1
     */
    dilationKernelSize: number;
}

/**
 * Parameters for the text detection service.
 */
export interface DetectionServiceOptions extends DetectionRuntimeOptions {
    /**
     * ArrayBuffer containing the ONNX model for text detection.
     */
    modelBuffer?: ArrayBuffer;
}

/**
 * Runtime parameters for text recognition.
 * 字段在内部统一由 DEFAULT_RECOGNITION_OPTIONS 兜底为必填；外部传参一律用 Partial 包装。
 */
export interface RecognitionRuntimeOptions {
    /**
     * Fixed height for input images, in pixels.
     * Models will resize width proportionally.
     * @default 48
     */
    imageHeight: number;

    /**
     * Per-channel mean values used to normalize input pixels [R, G, B].
     * @default [127.5, 127.5, 127.5]
     */
    mean: [number, number, number];

    /**
     * Per-channel standard deviation values used to normalize input pixels [R, G, B].
     * @default [0.00784313725490196, 0.00784313725490196, 0.00784313725490196]
     */
    stdDeviation: [number, number, number];

    /**
     * A list of loaded character dictionary (string) for
     * recognition result decoding.
     */
    charactersDictionary: string[];
}

/**
 * Parameters for the text recognition service.
 */
export interface RecognitionServiceOptions extends RecognitionRuntimeOptions {
    /**
     * ArrayBuffer containing the ONNX model for text recognition.
     */
    modelBuffer?: ArrayBuffer;
}

/**
 * Parameters for sorting detection boxes into reading order.
 */
export interface RecognitionOrderingOptions {
    /**
     * Whether recognition results should be sorted in reading order.
     * @default true
     */
    sortByReadingOrder: boolean;

    /**
     * Threshold ratio used to decide whether two boxes are on the same line.
     * The threshold is `(boxA.height + boxB.height) * sameLineThresholdRatio`.
     * @default 0.25
     */
    sameLineThresholdRatio: number;
}

/**
 * Parameters for post-processing recognition results into lines.
 */
export interface ProcessRecognitionOptions {
    /**
     * Threshold ratio used to merge results into the same line.
     * The threshold is `averageLineHeight * lineMergeThresholdRatio`.
     * @default 0.5
     */
    lineMergeThresholdRatio: number;
}

export interface OrtTensor {
    data: unknown;
    dims: readonly number[];
}

export interface OrtInferenceSession {
    outputNames: readonly string[];
    run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
    release?(): Promise<void>;
}

export interface OrtTensorConstructor {
    new (type: string, data: Float32Array, dims: readonly number[]): OrtTensor;
}

export interface OrtInferenceSessionConstructor {
    create(modelBuffer: ArrayBuffer): Promise<OrtInferenceSession>;
}

export interface OrtModule {
    Tensor: OrtTensorConstructor;
    InferenceSession: OrtInferenceSessionConstructor;
}

/**
 * Full configuration for the PaddleOCR service.
 * Combines model file paths with detection, recognition, and debugging parameters.
 */
export interface PaddleOptions {
    /**
     * onnxruntime module
     */
    ort?: OrtModule;

    /**
     * Controls parameters for text detection.
     */
    detection?: Partial<DetectionServiceOptions>;

    /**
     * Controls parameters for text recognition.
     */
    recognition?: Partial<RecognitionServiceOptions>;
}

/**
 * Options for each recognition task.
 */
export interface RecognitionOptions {
    charWhiteList?: string[];
    onProgress?: (event: PaddleOcrProgressEvent) => void;
    detection?: Partial<DetectionRuntimeOptions>;
    recognition?: Partial<RecognitionRuntimeOptions>;
    ordering?: Partial<RecognitionOrderingOptions>;
}

export interface OcrProgress {
    current: number;
    remain: number;
    total: number;
}

export type PaddleOcrProgressEvent =
    | {
          type: "det";
          stage: "preprocess" | "infer" | "postprocess";
          progress: OcrProgress;
          detectedCount?: number;
      }
    | {
          type: "rec";
          stage: "start" | "item" | "complete";
          progress: OcrProgress;
          index?: number;
          box?: Box;
          result?: RecognitionResult;
      };

/**
 * Simple rectangle representation.
 */
export interface Box {
    /** X-coordinate of the top-left corner. */
    x: number;
    /** Y-coordinate of the top-left corner. */
    y: number;
    /** Width of the box in pixels. */
    width: number;
    /** Height of the box in pixels. */
    height: number;
}
