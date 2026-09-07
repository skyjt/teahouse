import { isImeCompositionKey } from './ime'

const navigationKeys = [
  'Insert', 'End', 'ArrowDown', 'PageDown', 'ArrowLeft',
  'Clear', 'ArrowRight', 'Home', 'ArrowUp', 'PageUp'
]
const textInputTypes = ['text', 'search', 'tel', 'url', 'email', 'password', 'number']

export function linuxNumpadDigit(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'isComposing' | 'ctrlKey' |
    'metaKey' | 'altKey' | 'shiftKey' | 'defaultPrevented' | 'getModifierState'>,
  composing = false
): string | null {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
    isImeCompositionKey(event, composing) || !event.getModifierState('NumLock')) return null
  const digit = /^Numpad([0-9])$/.exec(event.code)?.[1]
  if (digit === undefined) return null
  return event.key === digit || event.key === navigationKeys[Number(digit)] ? digit : null
}

/** GTK 编辑命令与 DOM key 可能不一致；仅恢复明确开启 NumLock 的文本输入。 */
export function installLinuxNumpad(): void {
  let composing = false
  document.addEventListener('compositionstart', () => { composing = true }, true)
  document.addEventListener('compositionend', () => { composing = false }, true)
  window.addEventListener('blur', () => { composing = false })
  document.addEventListener('keydown', (event) => {
    const digit = linuxNumpadDigit(event, composing)
    if (digit === null) return
    const target = event.target
    if (!(target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && textInputTypes.includes(target.type))) ||
      target !== document.activeElement || target.readOnly || target.disabled) return
    try {
      // 原生编辑事务保留 input、撤销、选区替换和 maxlength；失败时继续原事件。
      if (!document.execCommand('insertText', false, digit)) return
    } catch {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }, true)
}
