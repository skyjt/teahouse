import { describe, expect, it } from 'vitest'
import {
  detectMentionInsertion,
  filterMentionCandidates,
  hasMentionAllToken,
  matchesMentionAll,
  parseMentionQuery,
  stepMentionIndex
} from './mention-picker'

const names: Record<string, string> = {
  'node-a': '产品明哥 小明',
  'node-b': '设计华姐 小华',
  'node-c': 'Zhang San'
}

function searchTextOf(id: string): string {
  return names[id] ?? ''
}

describe('@ 成员面板纯逻辑', () => {
  it('空查询返回全量，按显示名与昵称做大小写不敏感的包含匹配', () => {
    const ids = ['node-a', 'node-b', 'node-c']
    expect(filterMentionCandidates(ids, searchTextOf, '')).toEqual(ids)
    expect(filterMentionCandidates(ids, searchTextOf, '小明')).toEqual(['node-a'])
    expect(filterMentionCandidates(ids, searchTextOf, 'zhang')).toEqual(['node-c'])
    expect(filterMentionCandidates(ids, searchTextOf, 'ZHANG')).toEqual(['node-c'])
    expect(filterMentionCandidates(ids, searchTextOf, '不存在')).toEqual([])
  })

  it('高亮索引环绕步进，列表为空时固定为 0', () => {
    expect(stepMentionIndex(0, 1, 3)).toBe(1)
    expect(stepMentionIndex(2, 1, 3)).toBe(0)
    expect(stepMentionIndex(0, -1, 3)).toBe(2)
    expect(stepMentionIndex(1, -4, 3)).toBe(0)
    expect(stepMentionIndex(5, 1, 3)).toBe(0)
    expect(stepMentionIndex(0, 1, 0)).toBe(0)
    expect(stepMentionIndex(0, -1, 0)).toBe(0)
  })

  it('只有 @ 后在光标间存在无空白令牌时才是有效查询', () => {
    expect(parseMentionQuery('@zhang', 0, 6)).toBe('zhang')
    expect(parseMentionQuery('你好 @张', 3, 5)).toBe('张')
    expect(parseMentionQuery('＠张', 0, 2)).toBe('张')
    expect(parseMentionQuery('@张 三', 0, 4)).toBeNull()
    expect(parseMentionQuery('@张\n三', 0, 4)).toBeNull()
    expect(parseMentionQuery('@张\u00a0三', 0, 4)).toBeNull()
    expect(parseMentionQuery('hello', 0, 2)).toBeNull()
    expect(parseMentionQuery('@zhang', 0, 0)).toBeNull()
    expect(parseMentionQuery('@zhang', 0, -1)).toBeNull()
    expect(parseMentionQuery('@zhang', 9, 6)).toBeNull()
    expect(parseMentionQuery('@zhang', -1, 6)).toBeNull()
    expect(parseMentionQuery('@zhang', 0, 99)).toBe('zhang')
  })

  it('@所有人 仅在查询命中关键词时作为候选出现（决议 #310）', () => {
    expect(matchesMentionAll('')).toBe(false)
    expect(matchesMentionAll('张')).toBe(false)
    expect(matchesMentionAll('所')).toBe(true)
    expect(matchesMentionAll('所有人')).toBe(true)
    expect(matchesMentionAll('全体')).toBe(true)
    expect(matchesMentionAll('all')).toBe(true)
    expect(matchesMentionAll('ALL')).toBe(true)
    expect(matchesMentionAll('every')).toBe(true)
    expect(matchesMentionAll('everyone')).toBe(true)
    expect(hasMentionAllToken('@所有人 开会')).toBe(true)
    expect(hasMentionAllToken('请 @Everyone 看')).toBe(true)
    expect(hasMentionAllToken('@every')).toBe(false)
    expect(hasMentionAllToken('@张三')).toBe(false)
    expect(hasMentionAllToken('没有 @ 令牌')).toBe(false)
  })

  it('中文输入法上屏：只有恰好插入一个 @/＠ 才识别为提及令牌', () => {
    expect(detectMentionInsertion('', '@', 1)).toBe(0)
    expect(detectMentionInsertion('你好', '你好@', 3)).toBe(2)
    expect(detectMentionInsertion('你好', '你@好', 2)).toBe(1)
    expect(detectMentionInsertion('abc', 'abc@', 4)).toBe(3)
    expect(detectMentionInsertion('', '＠', 1)).toBe(0)
    expect(detectMentionInsertion('abc@', 'abc', 3)).toBeNull()
    expect(detectMentionInsertion('abc', 'ab@c', 2)).toBeNull()
    expect(detectMentionInsertion('', 'abc@', 3)).toBeNull()
    expect(detectMentionInsertion('abc', 'abc', 0)).toBeNull()
    expect(detectMentionInsertion('abc', 'abc@', 0)).toBeNull()
    expect(detectMentionInsertion('abc', '@abc', 10)).toBeNull()
    expect(detectMentionInsertion('abc', '@abc', 1.5)).toBeNull()
  })
})
