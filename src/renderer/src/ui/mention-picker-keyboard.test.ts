import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8').replace(
  /\r\n?/g,
  '\n'
)

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `缺少函数 ${name}`).toBeGreaterThanOrEqual(0)
  const next = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

describe('@ 成员面板键盘导航与实时过滤（决议 #308）', () => {
  it('面板打开时方向键受门控，Enter 插入候选先于发送', () => {
    const body = functionBody('onKeydown')
    expect(body).toMatch(/if \(showMentionPicker\.value\) \{/)
    expect(body).toMatch(/event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/)
    expect(body).toMatch(/event\.key === 'Enter' && mentionCandidates\.value\.length > 0/)
    expect(body).toMatch(/confirmMention\(\)/)
    expect(body.indexOf('confirmMention()')).toBeLessThan(body.indexOf('void send()'))
  })

  it('候选列表带高亮态、悬停同步与无匹配空态', () => {
    expect(source).toMatch(/v-for="\(id, index\) in mentionCandidates"/)
    expect(source).toMatch(/:class="\{ active: index === mentionActiveIndex \}"/)
    expect(source).toMatch(/@mouseenter="mentionActiveIndex = index"/)
    expect(source).toMatch(/mentionCandidates\.length === 0/)
    expect(source).toContain("tr('没有匹配的成员')")
  })

  it('过滤、令牌复核与高亮样式接入纯函数实现', () => {
    expect(source).toContain('filterMentionCandidates(')
    expect(source).toContain('parseMentionQuery(')
    expect(source).toContain('stepMentionIndex(')
    expect(source).toMatch(/\.mention-picker button\.active/)
  })

  it('中文输入法上屏的 @ 由草稿变化兜底识别并打开面板（决议 #309）', () => {
    const body = functionBody('openMentionFromInsertion')
    expect(source).toContain('detectMentionInsertion(')
    expect(body).toMatch(/isGroup\.value/)
    expect(body).toMatch(/canSend\.value/)
    expect(body).toMatch(/mentionMembers\.value\.length === 0/)
    expect(body).toMatch(/pendingMentionAt\.value = at/)
    expect(body).toMatch(/showMentionPicker\.value = true/)
    const watchBlock = source.slice(source.indexOf('watch(draft, (next, prev)'), source.indexOf('watch(\n  () => [peer.value'))
    expect(watchBlock.indexOf('openMentionFromInsertion(prev, next)')).toBeGreaterThan(-1)
    expect(watchBlock.indexOf('openMentionFromInsertion(prev, next)')).toBeLessThan(
      watchBlock.indexOf('syncMentionQuery')
    )
    expect(source.indexOf('isImeCompositionKey(event, inputComposing.value)')).toBeLessThan(
      source.indexOf("if (event.key === '@'")
    )
  })
})

describe('@所有人（决议 #310）', () => {
  it('保留值来自协议常量，候选仅查询命中时出现', () => {
    expect(source).toContain('MENTION_ALL')
    expect(source).toMatch(/from '\.\.\/\.\.\/\.\.\/shared\/protocol'/)
    expect(source).toContain('matchesMentionAll(mentionQuery.value)')
    expect(source).toMatch(/\[MENTION_ALL, \.\.\.members\]/)
  })

  it('展示名、插入文本与发送识别共用一套标签逻辑', () => {
    const body = functionBody('mentionLabel')
    expect(body).toMatch(/id === MENTION_ALL/)
    expect(body).toContain("tr('所有人')")
    expect(source).toContain('mentionLabel(id)')
    expect(source).toMatch(/id === MENTION_ALL\s*\n\s*\? hasMentionAllToken\(text\)/)
    expect(functionBody('insertMention')).toContain('mentionLabel(nodeId)')
  })
})
