import type {
  ImageOcrBox,
  ImageOcrLine,
  ImageOcrResult,
  ImageOcrToken
} from '../../shared/ipc'

const DEFAULT_MAX_ENTRIES = 128
const MAX_CACHE_KEY_LENGTH = 180
const MAX_TEXT_LENGTH = 500_000
const MAX_TOKENS = 20_000
const MAX_LINES = 5_000
const MAX_TOKEN_TEXT_LENGTH = 2_000
const MAX_LINE_TEXT_LENGTH = 2_000

export class ImageOcrResultCache {
  private readonly entries = new Map<string, ImageOcrResult>()

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  get(transferId: string, cacheKey: string): ImageOcrResult | null {
    const key = makeCacheKey(transferId, cacheKey)
    if (!key) return null
    const cached = this.entries.get(key)
    if (!cached) return null
    this.entries.delete(key)
    this.entries.set(key, cached)
    return cloneResult(cached)
  }

  set(transferId: string, cacheKey: string, input: unknown): boolean {
    const key = makeCacheKey(transferId, cacheKey)
    if (!key) return false
    const result = normalizeImageOcrResult(input)
    if (!result) return false
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, result)
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (!oldestKey) break
      this.entries.delete(oldestKey)
    }
    return true
  }
}

export function normalizeImageOcrResult(input: unknown): ImageOcrResult | null {
  if (!isObject(input)) return null
  const text = readLimitedString(input['text'], MAX_TEXT_LENGTH)
  const tokens = Array.isArray(input['tokens']) ? input['tokens'] : null
  const lines = Array.isArray(input['lines']) ? input['lines'] : null
  const scale = readFiniteNumber(input['scale'])
  if (text === null || !tokens || !lines || scale === null || tokens.length > MAX_TOKENS || lines.length > MAX_LINES) {
    return null
  }

  const normalizedTokens: ImageOcrToken[] = []
  for (const item of tokens) {
    const token = normalizeToken(item)
    if (!token) return null
    normalizedTokens.push(token)
  }

  const normalizedLines: ImageOcrLine[] = []
  for (const item of lines) {
    const line = normalizeLine(item)
    if (!line) return null
    normalizedLines.push(line)
  }

  return {
    text,
    tokens: normalizedTokens,
    lines: normalizedLines,
    scale
  }
}

function normalizeToken(input: unknown): ImageOcrToken | null {
  if (!isObject(input)) return null
  const id = readLimitedString(input['id'], 80)
  const text = readLimitedString(input['text'], MAX_TOKEN_TEXT_LENGTH)
  const confidence = readFiniteNumber(input['confidence'])
  const bbox = normalizeBox(input['bbox'])
  const lineIndex = readSafeInteger(input['lineIndex'])
  const wordIndex = readSafeInteger(input['wordIndex'])
  const tokenIndex = readSafeInteger(input['tokenIndex'])
  if (
    id === null ||
    text === null ||
    confidence === null ||
    !bbox ||
    lineIndex === null ||
    wordIndex === null ||
    tokenIndex === null
  ) {
    return null
  }
  return { id, text, confidence, bbox, lineIndex, wordIndex, tokenIndex }
}

function normalizeLine(input: unknown): ImageOcrLine | null {
  if (!isObject(input)) return null
  const id = readLimitedString(input['id'], 80)
  const text = readLimitedString(input['text'], MAX_LINE_TEXT_LENGTH)
  const bbox = normalizeBox(input['bbox'])
  const tokenIds = Array.isArray(input['tokenIds'])
    ? input['tokenIds'].map((value) => readLimitedString(value, 80))
    : null
  const lineIndex = readSafeInteger(input['lineIndex'])
  if (!id || text === null || !bbox || !tokenIds || tokenIds.some((value) => value === null) || lineIndex === null) {
    return null
  }
  return { id, text, bbox, tokenIds: tokenIds as string[], lineIndex }
}

function normalizeBox(input: unknown): ImageOcrBox | null {
  if (!isObject(input)) return null
  const x0 = readFiniteNumber(input['x0'])
  const y0 = readFiniteNumber(input['y0'])
  const x1 = readFiniteNumber(input['x1'])
  const y1 = readFiniteNumber(input['y1'])
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null
  return { x0, y0, x1, y1 }
}

function makeCacheKey(transferId: string, cacheKey: string): string | null {
  if (!isValidKeyPart(transferId, 64) || !isValidKeyPart(cacheKey, MAX_CACHE_KEY_LENGTH)) return null
  return `${transferId}:${cacheKey}`
}

function isValidKeyPart(value: string, maxLength: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function cloneResult(result: ImageOcrResult): ImageOcrResult {
  return {
    text: result.text,
    scale: result.scale,
    tokens: result.tokens.map((token) => ({
      ...token,
      bbox: { ...token.bbox }
    })),
    lines: result.lines.map((line) => ({
      ...line,
      bbox: { ...line.bbox },
      tokenIds: [...line.tokenIds]
    }))
  }
}

function readLimitedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length > maxLength) return null
  return value
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
