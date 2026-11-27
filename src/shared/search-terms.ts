/** Each whitespace-separated term must occur in the message or displayed attachment name. */
export function searchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/u).filter(Boolean))]
}
