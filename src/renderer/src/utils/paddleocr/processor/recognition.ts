import { DEFAULT_RECOGNITION_OPTIONS, DEFAULT_RECOGNITION_ORDERING_OPTIONS } from "../constants";
import type {
    Box,
    OcrProgress,
    OrtInferenceSession,
    OrtModule,
    OrtTensor,
    RecognitionOptions,
    RecognitionOrderingOptions,
    RecognitionRuntimeOptions,
} from "../interface";
import type { Image } from "../utils/image";

export interface RecognitionResult {
    text: string;
    box: Box;
    confidence: number;
}

export interface SingleRecognitionTask {
    index: number;
    image: Image;
    box: Box;
    charWhiteSet?: Set<string>;
}

/**
 * Service for detecting and recognizing text in images
 */
export class RecognitionService {
    private readonly options: RecognitionRuntimeOptions;
    private readonly session: OrtInferenceSession;
    private readonly ortModule: OrtModule;

    constructor(
        ortModule: OrtModule,
        session: OrtInferenceSession,
        options: Partial<RecognitionRuntimeOptions> = {}
    ) {
        this.session = session;
        this.ortModule = ortModule;

        this.options = {
            ...DEFAULT_RECOGNITION_OPTIONS,
            ...options,
        };
    }

    /**
     * Main method to run text recognition on an image with detected regions
     * @param image The original image buffer or image in Canvas
     * @param detection Array of bounding boxes from text detection
     * @returns Array of recognition results with text and bounding box, sorted in reading order
     */
    async run(
        image: Image,
        detection: Box[],
        options?: RecognitionOptions
    ): Promise<RecognitionResult[]> {
        const recognitionOptions = this.resolveRuntimeOptions(options?.recognition);
        const orderingOptions = this.resolveOrderingOptions(options?.ordering);
        const validBoxes = this.sortBoxesByReadingOrder(
            detection.filter((box) => box.width > 0 && box.height > 0),
            orderingOptions
        );
        const results: RecognitionResult[] = [];
        const charWhiteListSet = options?.charWhiteList?.length
            ? new Set(options.charWhiteList)
            : undefined;
        const total = validBoxes.length;
        const onProgress = options?.onProgress;

        onProgress?.({
            type: "rec",
            stage: "start",
            progress: this.createProgress(0, total),
        });

        for (const [i, box] of validBoxes.entries()) {
            const result = await this.processBox(
                {
                    image: image,
                    index: i,
                    box: box,
                    charWhiteSet: charWhiteListSet,
                },
                recognitionOptions
            );
            if (result) {
                results.push(result);
            }
            onProgress?.({
                type: "rec",
                stage: "item",
                progress: this.createProgress(i + 1, total),
                index: i,
                box,
                result: result ?? undefined,
            });
        }

        onProgress?.({
            type: "rec",
            stage: "complete",
            progress: this.createProgress(total, total),
        });

        return results;
    }

    private resolveRuntimeOptions(
        options: Partial<RecognitionRuntimeOptions> = {}
    ): RecognitionRuntimeOptions {
        return {
            ...this.options,
            ...options,
        };
    }

    private resolveOrderingOptions(
        options: Partial<RecognitionOrderingOptions> = {}
    ): RecognitionOrderingOptions {
        return {
            ...DEFAULT_RECOGNITION_ORDERING_OPTIONS,
            ...options,
        };
    }

    /**
     * Process a single text box
     */
    private async processBox(
        task: SingleRecognitionTask,
        runtimeOptions: RecognitionRuntimeOptions
    ): Promise<RecognitionResult | null> {
        const { image, box } = task;

        const crop = image.crop(box);
        const resizedCrop = crop.resize({
            height: runtimeOptions.imageHeight,
        });
        const tensor = resizedCrop.tensor({
            mean_values: runtimeOptions.mean,
            norm_values: runtimeOptions.stdDeviation,
        });

        const inputTensor = new this.ortModule.Tensor("float32", tensor, [
            1,
            3,
            resizedCrop.height,
            resizedCrop.width,
        ]);
        const { data: outputData, dims: shape } = await this.runInference(inputTensor);

        const [, sequenceLength, numClasses] = shape;
        const { text: recognizedText, confidence } = this.ctcLabelDecode(
            outputData as Float32Array,
            sequenceLength,
            numClasses,
            runtimeOptions,
            task.charWhiteSet
        );

        return { text: recognizedText, box, confidence };
    }

    /**
     * Sort recognition results by reading order (top to bottom, left to right)
     */
    private sortBoxesByReadingOrder(
        boxes: Box[],
        orderingOptions: RecognitionOrderingOptions
    ): Box[] {
        if (!orderingOptions.sortByReadingOrder) {
            return [...boxes];
        }

        return [...boxes].sort((boxA, boxB) => {
            if (
                Math.abs(boxA.y - boxB.y) <
                (boxA.height + boxB.height) * orderingOptions.sameLineThresholdRatio
            ) {
                return boxA.x - boxB.x;
            }
            return boxA.y - boxB.y;
        });
    }

    private createProgress(current: number, total: number): OcrProgress {
        return {
            current,
            remain: total - current,
            total,
        };
    }

    /**
     * Runs the ONNX inference session with the prepared tensor
     */
    private async runInference(inputTensor: OrtTensor): Promise<OrtTensor> {
        const feeds = { x: inputTensor };
        const results = await this.session.run(feeds);

        const outputNodeName = Object.keys(results)[0];
        const outputTensor = results[outputNodeName];

        if (!outputTensor) {
            throw new Error(
                `Recognition output tensor '${outputNodeName}' not found. Available keys: ${Object.keys(results)}`
            );
        }

        return outputTensor;
    }

    private ctcLabelDecode(
        logits: Float32Array,
        sequenceLength: number,
        numClasses: number,
        runtimeOptions: RecognitionRuntimeOptions,
        charWhiteSet?: Set<string>
    ): { text: string; confidence: number } {
        const dict = runtimeOptions.charactersDictionary;
        let text = "";
        const scores: number[] = [];

        let lastIndex = -1;

        for (let t = 0; t < sequenceLength; t++) {
            let maxScore = 0;
            let maxScoreIndex = 0;

            const offset = t * numClasses;
            for (let i = 0; i < numClasses; i++) {
                const val = logits[offset + i];
                if (val > maxScore) {
                    maxScore = val;
                    maxScoreIndex = i;
                }
            }

            if (maxScoreIndex === lastIndex) {
                continue;
            }

            lastIndex = maxScoreIndex;

            if (maxScoreIndex === 0) {
                continue;
            }

            const char = dict[maxScoreIndex] || "";

            if (charWhiteSet && !charWhiteSet.has(char) && char !== " ") {
                continue;
            }

            text += char;
            scores.push(maxScore);
        }

        return {
            text,
            confidence:
                scores.length > 0
                    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
                    : 0,
        };
    }
}
