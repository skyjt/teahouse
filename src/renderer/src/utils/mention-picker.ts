/** @ 成员面板的纯逻辑：过滤、键盘高亮步进、令牌范围判定（决议 #308）。 */

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
  if (text[at] !== '@') return null
  if (!Number.isInteger(caret) || caret <= at) return null
  const query = text.slice(at + 1, Math.min(caret, text.length))
  if (/\s/.test(query)) return null
  return query
}
