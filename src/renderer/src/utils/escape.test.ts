import { describe, expect, it } from 'vitest'
import { isPlainEscape } from './escape'

const escape = {
  key: 'Escape', keyCode: 27, isComposing: false, repeat: false, defaultPrevented: false,
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false
}

describe('主窗口与浮层共用的 Esc 判定', () => {
  it('普通 Esc 可消费，其他按键不处理', () => {
    expect(isPlainEscape(escape)).toBe(true)
    expect(isPlainEscape({ ...escape, key: 'Enter', keyCode: 13 })).toBe(false)
  })

  it('修饰键、长按与已消费事件不能继续隐藏窗口', () => {
    for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat', 'defaultPrevented']) {
      expect(isPlainEscape({ ...escape, [key]: true })).toBe(false)
    }
  })

  it('输入法状态、浏览器标记和旧输入法 229 都优先', () => {
    expect(isPlainEscape(escape, true)).toBe(false)
    expect(isPlainEscape({ ...escape, isComposing: true })).toBe(false)
    expect(isPlainEscape({ ...escape, keyCode: 229 })).toBe(false)
  })
})
