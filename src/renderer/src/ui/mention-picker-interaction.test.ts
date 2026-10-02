import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { computed, nextTick, ref, watch } from 'vue'
import { describe, expect, it } from 'vitest'
import * as picker from '../utils/mention-picker'
import { isImeCompositionKey } from '../utils/ime'

// 执行真实组件的事件函数和 watcher；显式模拟 keydown 之后才发生的原生光标移动。
// 旧实现会在下面的 Enter / 鼠标确认用例中覆盖正文，源码字符串断言无法发现此问题。
const source = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
  .split('<script setup lang="ts">')[1].split('</script>')[0]
const ast = ts.createSourceFile('ChatPane.ts', source, ts.ScriptTarget.Latest, true)
const functions = new Set([
  'inputSelectionRange', 'focusInput', 'setInputSelection', 'mentionLabel', 'send',
  'openMentionFromInsertion', 'closeMentionPicker', 'syncMentionQuery',
  'scrollMentionActiveIntoView', 'moveMentionActive', 'confirmMention',
  'onKeydown', 'onInputCompositionStart', 'onInputCompositionEnd', 'insertMention'
])
const actual = ast.statements.filter(statement =>
  (ts.isFunctionDeclaration(statement) && functions.has(statement.name?.text ?? '')) ||
  statement.getText(ast).startsWith('watch(draft,') ||
  statement.getText(ast).startsWith('const mentionCandidates =')
).map(statement => statement.getText(ast)).join('\n')

function harness() {
  const compiled = ts.transpileModule(`
    const { ref, computed, watch, nextTick, isImeCompositionKey, ...helpers } = deps;
    const { filterMentionCandidates, detectMentionInsertion, hasMentionAllToken,
      matchesMentionAll, parseMentionQuery, stepMentionIndex } = helpers;
    const MENTION_ALL = '@all', props = { win7ImeCompat: false };
    const draft = ref(''), inputEl = ref({ selectionStart: 0, selectionEnd: 0, focus() {} });
    const showMentionPicker = ref(false), pendingMentionAt = ref(null), mentionQuery = ref('');
    const mentionActiveIndex = ref(0), mentionPickerEl = ref(null), mentionIds = ref([]);
    const inputComposing = ref(false), isGroup = ref(true), canSend = ref(true), overLimit = ref(false);
    const replyToId = ref(null), tablePasteHint = ref(null), settings = ref({ sendKey: 'enter' });
    const mentionMembers = ref(['alice', 'bob']);
    const names = { alice: 'Alice', bob: 'Bob' };
    const peersStore = { nameOf: id => names[id], byId: id => ({ nick: names[id], remark: '' }) };
    const tr = text => text, syncInputMirrorScroll = () => {}, tablePasteHintIntact = () => true;
    const clearTablePasteHint = () => {}, insertNewline = () => { draft.value += '\\n' };
    const sent = [], chatStore = { send: async (...args) => { sent.push(args) } };
    ${actual}
    return { draft, inputEl, showMentionPicker, mentionCandidates, mentionIds, mentionActiveIndex,
      settings, sent, onKeydown, insertMention, syncMentionQuery, send,
      onInputCompositionStart, onInputCompositionEnd, setInputSelection };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  const h = new Function('deps', compiled)({ ref, computed, watch, nextTick, isImeCompositionKey, ...picker })
  h.edit = async (text: string, start = text.length, end = start) => {
    h.draft.value = text
    h.setInputSelection(start, end)
    await nextTick()
    await nextTick()
  }
  h.key = (key: string, extra = {}) => {
    const event = { key, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0,
      prevented: false, preventDefault() { this.prevented = true }, ...extra }
    h.onKeydown(event)
    return event
  }
  return h
}

describe('提及真实事件函数回归', () => {
  it('keydown 之后左移出令牌，下一次 Enter 不使用旧候选', async () => {
    const h = harness()
    await h.edit('@')
    h.key('ArrowLeft')
    await nextTick() // 原实现会在此读到旧 caret=1
    h.setInputSelection(0) // 原生默认动作晚于 keydown listener/microtask
    h.key('Enter')
    expect(h.sent[0]).toEqual(['@', [], undefined])
    expect(h.mentionIds.value).toEqual([])
  })

  it('鼠标移到后续正文后，Enter 保留并发送完整正文', async () => {
    const h = harness()
    await h.edit(' suffix', 0)
    await h.edit('@ suffix', 1)
    h.setInputSelection(8)
    h.key('Enter')
    expect(h.sent[0]).toEqual(['@ suffix', [], undefined])
  })

  it('鼠标确认与非折叠选区也不能覆盖已失效的正文范围', async () => {
    const h = harness()
    await h.edit(' suffix', 0)
    await h.edit('@ suffix', 1)
    h.setInputSelection(8)
    h.insertMention('alice')
    expect(h.draft.value).toBe('@ suffix')
    expect(h.showMentionPicker.value).toBe(false)
    await h.edit('')
    await h.edit('@')
    h.setInputSelection(0, 1)
    h.insertMention('alice')
    expect(h.draft.value).toBe('@')
  })

  it('选区同步关闭失效面板，令牌内部选择替换整个查询串', async () => {
    const h = harness()
    await h.edit('@')
    await h.edit('@alice')
    h.setInputSelection(3)
    h.insertMention('alice')
    expect(h.draft.value).toBe('@Alice ')
    await h.edit('')
    await h.edit('@')
    h.setInputSelection(0)
    h.syncMentionQuery()
    expect(h.showMentionPicker.value).toBe(false)
  })

  it('方向键循环选择，短查询不抢占单人候选，明确输入才能选择全员', async () => {
    const h = harness()
    await h.edit('@')
    h.key('ArrowUp')
    expect(h.mentionActiveIndex.value).toBe(1)
    h.key('ArrowDown')
    expect(h.mentionActiveIndex.value).toBe(0)
    await h.edit('@a')
    h.key('Enter')
    expect(h.draft.value).toBe('@Alice ')
    await h.edit('')
    await h.edit('@')
    await h.edit('@all')
    h.key('Enter')
    expect(h.draft.value).toBe('@所有人 ')
    h.key('Enter')
    expect(h.sent[0]).toEqual(['@所有人', ['@all'], undefined])
  })

  it('编辑全员标签后发送不再附带广播标记', async () => {
    const h = harness()
    await h.edit('@')
    await h.edit('@所有人')
    h.key('Enter')
    await nextTick()
    await h.edit('@所有人Else')
    h.key('Enter')
    expect(h.sent[0]).toEqual(['@所有人Else', [], undefined])
  })

  it('组合输入及 229 不消费 Enter；全角上屏打开面板', async () => {
    const h = harness()
    await h.edit('＠')
    h.onInputCompositionStart()
    expect(h.key('Enter').prevented).toBe(false)
    h.insertMention('alice')
    expect(h.draft.value).toBe('＠')
    h.onInputCompositionEnd()
    expect(h.key('Enter', { keyCode: 229 }).prevented).toBe(false)
    expect(h.sent).toEqual([])
    h.key('Enter')
    expect(h.draft.value).toBe('@Alice ')
  })

  it('无匹配时遵守 Ctrl+Enter 发送设置', async () => {
    const h = harness()
    h.settings.value.sendKey = 'ctrlEnter'
    await h.edit('@')
    await h.edit('@zzz')
    expect(h.key('Enter').prevented).toBe(false)
    expect(h.sent).toEqual([])
    h.key('Enter', { ctrlKey: true })
    expect(h.sent[0]).toEqual(['@zzz', [], undefined])
  })
})
