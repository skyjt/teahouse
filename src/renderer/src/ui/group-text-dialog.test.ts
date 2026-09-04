import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(new URL('../components/GroupPanel.vue', import.meta.url), 'utf8')
const dialogSource = readFileSync(
  new URL('../components/GroupTextDialog.vue', import.meta.url),
  'utf8'
)

describe('群简介与公告文本弹窗', () => {
  it('两个入口复用同一个文本弹窗并走群管理更新路径', () => {
    expect(panelSource).toContain("@click=\"openTextDialog('description')\"")
    expect(panelSource).toContain("@click=\"openTextDialog('announce')\"")
    expect(panelSource).toContain('<GroupTextDialog')
    expect(panelSource).toContain('@save="saveText"')
    expect(panelSource).toContain('prepareGroupAdminPatch')
    expect(panelSource).toContain("'adminPassword' in prepared.patch")
    expect(panelSource).toContain('groupsStore.byId[updated.groupId] = updated')
    expect(panelSource).not.toContain('GroupDescDialog')
    expect(panelSource).not.toContain('GroupAnnounceDialog')
    expect(dialogSource).not.toContain('window.pantry')
  })

  it('支持清空、密码成员提示和群信息面板文案', () => {
    expect(dialogSource).toContain("emit('save', normalizedValue.value)")
    expect(dialogSource).toContain('const initialValue = ref(\'\')')
    expect(dialogSource).toContain('normalizedValue.value !== initialValue.value')
    expect(dialogSource).toContain('留空可清空')
    expect(dialogSource).toContain('群信息面板中展示')
    expect(dialogSource).toContain(':disabled="busy"')
    expect(dialogSource).not.toMatch(/(?:font-size|border-radius): \d/)
    expect(panelSource).not.toContain('.meta-value::-webkit-scrollbar')
  })

  it('具备 Teleport、无障碍标题、Escape、初始焦点和关闭焦点恢复', () => {
    expect(dialogSource).toContain('<Teleport to="body">')
    expect(dialogSource).toContain('role="dialog"')
    expect(dialogSource).toContain('aria-modal="true"')
    expect(dialogSource).toContain('aria-labelledby="group-text-dialog-title"')
    expect(dialogSource).toContain("event.key !== 'Escape' || props.busy")
    expect(dialogSource).toContain("window.addEventListener('keydown', onWindowKeydown)")
    expect(dialogSource).toContain("window.removeEventListener('keydown', onWindowKeydown)")
    expect(dialogSource).toContain('previousFocus?.isConnected')
    expect(dialogSource).toContain('previousFocus.focus()')
    expect(dialogSource).toContain('focusInput()')
  })
})
