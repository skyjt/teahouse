/** @ 成员面板的纯逻辑：过滤、键盘高亮步进、令牌范围判定（决议 #318）。 */

/** @所有人 的候选匹配词：查询命中其一才在面板出现，避免默认高亮误发全员提醒（决议 #318） */
const MENTION_ALL_QUERIES = ['所有人', '全体', 'all', 'everyone']

/** 当前查询是否应展示「所有人」候选 */
export function matchesMentionAll(query: string): boolean {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return false
  return MENTION_ALL_QUERIES.includes(keyword)
}

/** 正文里是否仍保留 @所有人 文案（用户可能在发送前改语言或改字） */
export function hasMentionAllToken(text: string): boolean {
  // 标签两侧必须有边界；改成 @EveryoneElse / @所有人甲 后不再广播。
  return /(?:^|[^\p{L}\p{N}\p{M}_@])@(?:所有人|Everyone)(?![\p{L}\p{N}\p{M}_])/iu.test(text)
}

/** 中文输入法可能上屏全角 ＠，两种触发符都认，插入时统一写回半角 @。 */
export function isMentionTrigger(char: string | undefined): boolean {
  return char === '@' || char === '＠'
}

/**
 * 识别一次「恰好插入一个 @/＠」的编辑；返回令牌起点，否则 null。
 * 中文输入法激活时 @ 的 keydown 常带 keyCode 229 被 IME 保护拦下（决议 #318 遗留），
 * 这里从输入值变化兜底识别，不参与任何按键分流（决议 #318）。
 */
export function detectMentionInsertion(prev: string, next: string, caret: number): number | null {
  if (!Number.isInteger(caret) || caret < 1 || caret > next.length) return null
  if (!isMentionTrigger(next[caret - 1])) return null
  const removed = next.slice(0, caret - 1) + next.slice(caret)
  return removed === prev ? caret - 1 : null
}

/** 按搜索文本（显示名 + 昵称）过滤成员；空查询返回全量。 */
export function filterMentionCandidates(
  memberIds: readonly string[],
  searchTextOf: (id: string) => string,
  query: string
): string[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return [...memberIds]
  return memberIds.filter((id) => searchTextOf(id).toLowerCase().includes(keyword))
}

/** 高亮项环绕步进；列表为空时固定为 0。 */
export function stepMentionIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return 0
  const base = Number.isFinite(current) ? Math.trunc(current) : 0
  return ((base + delta) % total + total) % total
}

/**
 * 读取 @ 到光标之间的查询串；令牌无效时返回 null（面板应收起）：
 * @ 不存在、光标不在 @ 之后、或查询含空白/换行（@ 令牌已结束）。
 */
export function parseMentionQuery(text: string, at: number, caret: number): string | null {
  if (!Number.isInteger(at) || at < 0 || at >= text.length) return null
  if (!isMentionTrigger(text[at])) return null
  if (!Number.isInteger(caret) || caret <= at) return null
  const query = text.slice(at + 1, Math.min(caret, text.length))
  if (/\s/.test(query)) return null
  return query
}
