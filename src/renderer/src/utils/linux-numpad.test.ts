import { describe, expect, it } from 'vitest'
import { linuxNumpadDigit } from './linux-numpad'

const numpad = {
  key: 'ArrowDown', code: 'Numpad2', keyCode: 40, isComposing: false,
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
  getModifierState: (key: string): boolean => key === 'NumLock'
}

describe('Linux NumLock 数字输入恢复', () => {
  it('数字与对应导航值均按物理小键盘恢复 0–9', () => {
    const keys = ['Insert', 'End', 'ArrowDown', 'PageDown', 'ArrowLeft',
      'Clear', 'ArrowRight', 'Home', 'ArrowUp', 'PageUp']
    for (let digit = 0; digit <= 9; digit++) {
      const event = { ...numpad, code: `Numpad${digit}` }
      expect(linuxNumpadDigit({ ...event, key: String(digit) })).toBe(String(digit))
      expect(linuxNumpadDigit({ ...event, key: keys[digit] })).toBe(String(digit))
    }
  })

  it('NumLock 未开启、独立方向键、非数字小键盘与不匹配按键保持原行为', () => {
    expect(linuxNumpadDigit({ ...numpad, getModifierState: () => false })).toBeNull()
    for (const code of ['ArrowDown', 'Digit2', 'NumpadEnter', 'NumpadDecimal', '', 'Numpad22']) {
      expect(linuxNumpadDigit({ ...numpad, code })).toBeNull()
    }
    for (const key of ['ArrowUp', '4', 'Unidentified']) {
      expect(linuxNumpadDigit({ ...numpad, key })).toBeNull()
    }
  })

  it('修饰键、已消费事件与输入法组词不接管', () => {
    for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'defaultPrevented', 'isComposing']) {
      expect(linuxNumpadDigit({ ...numpad, [key]: true })).toBeNull()
    }
    expect(linuxNumpadDigit(numpad, true)).toBeNull()
    expect(linuxNumpadDigit({ ...numpad, keyCode: 229 })).toBeNull()
  })
})
