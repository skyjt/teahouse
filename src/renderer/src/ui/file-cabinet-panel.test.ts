import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(
  new URL('../components/FileCabinetPanel.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

const chatSource = readFileSync(
  new URL('../components/ChatPane.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

describe('文件柜翻页失败不清空列表（决议 #278）', () => {
  it('翻页失败后停止自动续拉，交给用户点重试', () => {
    const body = panelSource.slice(
      panelSource.indexOf('function onScroll('),
      panelSource.indexOf('function onRowClick(')
    )
    expect(body).toContain('if (moreFailReason.value) return')
  })

  it('失败提示挂在列表末尾并带重试按钮', () => {
    expect(panelSource).toMatch(
      /v-else-if="moreFailReason"[\s\S]{0,200}\{\{ moreFailText \}\}[\s\S]{0,200}@click="loadMore"/
    )
  })
})

describe('切换会话重置文件柜面板（决议 #278）', () => {
  it('会话切换的 watch 里与群成员面板一起收起', () => {
    const watchBody = chatSource.slice(
      chatSource.indexOf('  () => chatStore.activeConv?.peerId,'),
      chatSource.indexOf('{ immediate: true }')
    )
    expect(watchBody.length).toBeGreaterThan(0)
    expect(watchBody).toContain('showMembers.value = false')
    expect(watchBody).toContain('showCabinet.value = false')
  })
})

describe('文件柜面板细节一致性（决议 #281）', () => {
  it('体积走统一的 formatBytes，不再自带一份实现', () => {
    expect(panelSource).toContain("import { formatBytes } from '../utils/format'")
    expect(panelSource).toContain('formatBytes(entry.size)')
    expect(panelSource).not.toContain('function formatSize(')
  })

  it('截断提示用常量插值，改常量文案不会说谎', () => {
    expect(panelSource).toContain('import { SHARE_DIR_MAX_ENTRIES')
    expect(panelSource).toContain("tr('目录内容过多，仅显示前 {0} 项', { 0: SHARE_DIR_MAX_ENTRIES })")
    expect(panelSource).not.toContain('仅显示前 5000 项')
  })

  it('还有下一页时不说「全选」，避免让人以为选中了 total 项', () => {
    expect(panelSource).toContain('{{ pickAllLabel }}')
  })

  it('长文件名截断后可用原生提示看到全称', () => {
    expect(panelSource).toContain('class="row-name" :title="entry.name"')
  })

  it('拖拽高亮只在真正离开面板时熄灭', () => {
    expect(panelSource).toContain('@dragleave="onDragLeave"')
    expect(panelSource).toContain('function onDragLeave(')
    expect(panelSource).toContain('.contains(next)) return')
  })
})

describe('面板与文件柜页签对齐（决议 #283/#284）', () => {
  it('头部有权限徽标与「在文件柜里打开」，后者带上当前对端', () => {
    expect(panelSource).toContain(":title=\"tr('在文件柜里打开')\"")
    expect(panelSource).toContain('window.pantry.openCabinet(props.peerId)')
    // 徽标上移到头部后，底栏留给选中摘要与按钮
    expect(panelSource).toMatch(/class="panel-head"[\s\S]{0,400}class="perm"/)
  })

  it('行事件分别绑定单击选择与双击打开', () => {
    expect(panelSource).toContain('@click="onRowClick(index, $event)"')
    expect(panelSource).toContain('@dblclick="onRowOpen(index)"')
    // 多选与扩选行为由 share-browser.test.ts 验证，此处只检查模板接线。
  })

  it('行高收到 36px 且不再挤修改时间列', () => {
    expect(panelSource).toMatch(/\.row \{[\s\S]{0,200}height: 36px;/)
    expect(panelSource).not.toContain('class="row-time"')
  })

  it('导航栏入口切页签而不是开新窗口（决议 #284）', () => {
    const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    expect(appSource).toContain("data-label=\"tr('文件柜')\"")
    expect(appSource).toContain('name="cabinet"')
    // 文件柜是主窗第三个页签：列表栏与内容区各占一格，不再有独立窗口
    expect(appSource).toContain("type Tab = 'chat' | 'contacts' | 'cabinet'")
    expect(appSource).toContain("tab.value = 'cabinet'")
    expect(appSource).toContain('<CabinetList v-else-if="tab === \'cabinet\'" />')
    expect(appSource).toContain('<CabinetPane v-if="tab === \'cabinet\'" @chat="chatWith" />')
    // 设置窗等非主窗调用方仍走 IPC，由主进程把主窗切过去
    expect(appSource).toContain('window.pantry.onCabinetFocusPeer')
  })

  it('文件柜不再有独立窗口与第五个渲染入口', () => {
    const entrySource = readFileSync(new URL('../renderer-entry.ts', import.meta.url), 'utf8')
    expect(entrySource).not.toContain('CabinetApp')
    expect(entrySource).not.toContain("'#/cabinet'")
  })
})
