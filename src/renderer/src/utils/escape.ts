import { isImeCompositionKey } from './ime'

/** 只有未被消费的普通 Esc 才关闭浮层或隐藏主窗（决议 #293）。 */
export function isPlainEscape(
  event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing' | 'repeat' | 'defaultPrevented' |
    'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  composing = false
): boolean {
  return event.key === 'Escape' && !event.defaultPrevented && !event.repeat &&
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
    !isImeCompositionKey(event, composing)
}
