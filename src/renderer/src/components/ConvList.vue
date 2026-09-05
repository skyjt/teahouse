<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ConversationView } from '../../../shared/ipc'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import { listTime } from '../utils/time'
import { splitEmojiText } from '../utils/compat-emoji'
import AvatarMark from './AvatarMark.vue'
import CompatEmoji from './CompatEmoji.vue'
import GroupAvatar from './GroupAvatar.vue'
import { isPlainEscape } from '../utils/escape'
import { clampMenuPosition } from '../utils/menu-position'

const peersStore = usePeersStore()
const chatStore = useChatStore()
const groupsStore = useGroupsStore()
const menu = ref<{ x: number; y: number; conv: ConversationView } | null>(null)
const menuEl = ref<HTMLDivElement | null>(null)

const nickOf = computed(() => peersStore.nameOf) // 备注优先（F-DISC-9）

function convName(conv: ConversationView): string {
  return conv.type === 'group' ? groupsStore.nameOf(conv.peerId) : nickOf.value(conv.peerId)
}

function openMenu(event: MouseEvent, conv: ConversationView): void {
  menu.value = { x: event.clientX, y: event.clientY, conv }
}

function closeMenu(): void {
  menu.value = null
}

function positionMenu(): void {
  if (!menu.value || !menuEl.value) return
  const { width, height } = menuEl.value.getBoundingClientRect()
  Object.assign(menu.value, clampMenuPosition(
    menu.value.x, menu.value.y, width, height, window.innerWidth, window.innerHeight
  ))
}

// 修复（决议 #128）：右键菜单原来只靠 .pane 的 @click 关闭，点到聊天栏那一侧（另一个组件）
// 时不会触发，菜单关不掉。改为菜单打开期间挂全局监听——点窗口任意处、再次右键、窗口失焦
// 都关闭；菜单本体的 @click.stop 保证点菜单项不会被这里误关。
watch(menu, (open) => {
  if (open) {
    positionMenu()
    document.addEventListener('click', closeMenu)
    document.addEventListener('contextmenu', closeMenu)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('resize', positionMenu)
  } else {
    document.removeEventListener('click', closeMenu)
    document.removeEventListener('contextmenu', closeMenu)
    window.removeEventListener('blur', closeMenu)
    window.removeEventListener('resize', positionMenu)
  }
}, { flush: 'post' })

onUnmounted(() => {
  document.removeEventListener('keydown', onEscape)
  document.removeEventListener('click', closeMenu)
  document.removeEventListener('contextmenu', closeMenu)
  window.removeEventListener('blur', closeMenu)
  window.removeEventListener('resize', positionMenu)
})

async function togglePin(): Promise<void> {
  const conv = menu.value?.conv
  menu.value = null
  if (conv) await chatStore.pinConversation(conv.id, !conv.pinned)
}

async function toggleMute(): Promise<void> {
  const conv = menu.value?.conv
  menu.value = null
  if (conv) await chatStore.muteConversation(conv.id, !conv.muted)
}

const confirmConv = ref<ConversationView | null>(null)

function onEscape(event: KeyboardEvent): void {
  if (!isPlainEscape(event) || (!confirmConv.value && !menu.value)) return
  event.preventDefault()
  if (confirmConv.value) confirmConv.value = null
  else closeMenu()
}
onMounted(() => document.addEventListener('keydown', onEscape))

const confirmName = computed(() => (confirmConv.value ? convName(confirmConv.value) : ''))

// 移除聊天（决议 #125）：右键菜单先弹二次确认，确认后才进入 10 秒撤回窗口
function askRemoveConv(): void {
  const conv = menu.value?.conv
  menu.value = null
  if (conv) confirmConv.value = conv
}

function confirmRemove(): void {
  const conv = confirmConv.value
  confirmConv.value = null
  if (conv) chatStore.requestRemoveConversation(conv.id, convName(conv))
}
</script>

<template>
  <div class="pane" @click="menu = null">
    <div class="list-summary">
      <span>最近会话</span>
      <span>{{ chatStore.visibleConvs.length }}</span>
    </div>
    <div v-if="chatStore.visibleConvs.length === 0" class="placeholder">
      还没有会话<br />去「通讯录」找个人开聊
    </div>
    <ul v-else class="conv-list">
      <li v-for="conv in chatStore.visibleConvs" :key="conv.id">
        <button
          type="button"
          class="conv"
          :class="{ active: conv.id === chatStore.activeConvId, pinned: conv.pinned }"
          @click="chatStore.openConv(conv.id)"
          @contextmenu.prevent.stop="openMenu($event, conv)"
          :aria-current="conv.id === chatStore.activeConvId ? 'true' : undefined"
        >
          <GroupAvatar
            v-if="conv.type === 'group'"
            class="conv-avatar grp"
            :avatar-hash="groupsStore.byId[conv.peerId]?.avatarHash"
          />
          <AvatarMark
            v-else
            class="conv-avatar"
            :avatar="peersStore.byId(conv.peerId)?.avatar ?? -1"
            :avatar-hash="peersStore.byId(conv.peerId)?.avatarHash"
            :name="nickOf(conv.peerId)"
            :presence="(peersStore.byId(conv.peerId)?.online ?? false) ? 'online' : 'offline'"
          />
          <span class="conv-main">
            <span class="row1">
              <span class="conv-name">
                <em v-if="conv.pinned" class="flag">置顶</em>
                <em v-if="conv.muted" class="flag muted">静音</em>
                {{ convName(conv) }}
              </span>
              <span class="conv-time">{{ listTime(conv.lastTs) }}</span>
            </span>
            <span class="row2">
              <span v-if="conv.mentioned" class="mention">[有人@我]</span>
              <span class="conv-preview">
                <template v-for="(part, index) in splitEmojiText(conv.preview)" :key="index">
                  <CompatEmoji v-if="part.emoji" :emoji="part.text" />
                  <span v-else>{{ part.text }}</span>
                </template>
              </span>
              <span v-if="conv.unread > 0" class="badge" :class="{ muted: conv.muted }">{{
                conv.unread > 99 ? '99+' : conv.unread
              }}</span>
            </span>
          </span>
        </button>
      </li>
    </ul>
    <div
      v-if="menu"
      ref="menuEl"
      class="conv-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <button @click="togglePin">{{ menu.conv.pinned ? '取消置顶' : '置顶' }}</button>
      <button @click="toggleMute">{{ menu.conv.muted ? '取消免打扰' : '免打扰' }}</button>
      <button class="danger" @click="askRemoveConv">移除会话</button>
    </div>

    <!-- 移除聊天二次确认（决议 #125）：确认后删除聊天记录，仍有 10 秒撤回窗口 -->
    <div v-if="confirmConv" class="confirm-mask" @click.self="confirmConv = null">
      <div class="confirm-card" role="dialog" aria-modal="true" aria-label="移除聊天">
        <h3>移除聊天</h3>
        <p>移除后，与「{{ confirmName }}」的聊天记录将被删除。删除后 10 秒内可撤回。</p>
        <div class="confirm-actions">
          <button class="cancel" @click="confirmConv = null">取消</button>
          <button class="danger-btn" @click="confirmRemove">移除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
  padding-bottom: 8px;
}
.list-summary {
  height: 38px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.list-summary span:last-child {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 500;
}
.placeholder {
  color: var(--text-2);
  font-size: 13px;
  text-align: center;
  margin-top: 24px;
  line-height: 1.8;
}
.conv-list {
  list-style: none;
  overflow-y: auto;
  flex: 1;
  padding: 0 8px 10px;
}
.conv {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 60px;
  margin: 2px 0;
  padding: 10px;
  border-radius: 12px;
  cursor: pointer;
  transition:
    background 150ms ease,
    box-shadow 150ms ease,
    transform 90ms ease-out;
}
/* 置顶会话淡灰底（决议 #126）：与普通会话区分；hover / 选中态在其后定义，仍能覆盖 */
.conv.pinned {
  background: var(--bg-pinned);
}
.conv:hover {
  background: var(--surface-hover);
}
/* 决议 #216：弱茶青材质 + 左侧强调线，保留文字层级。 */
.conv.active,
.conv.active:hover {
  background: var(--surface-selected);
  box-shadow: inset 3px 0 0 var(--primary), var(--highlight-edge);
}
.conv.active .conv-name {
  color: var(--text-1);
  font-weight: 650;
}
.conv.active .conv-time,
.conv.active .conv-preview {
  color: var(--text-2);
}
.conv.active .mention {
  color: var(--badge);
}
.conv.active .flag {
  color: var(--primary);
  border-color: rgba(61, 139, 107, 0.35);
}
.conv.active .flag.muted {
  color: var(--text-2);
  border-color: var(--line);
}
.conv:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.conv:active {
  transform: scale(0.985);
}
.conv-avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 15px;
  flex-shrink: 0;
}
.conv-avatar.grp {
  background: var(--primary-weak);
  color: var(--primary);
  box-shadow: inset 0 0 0 1px rgba(61, 139, 107, 0.14);
}
.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row1,
.row2 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.conv-name {
  font-size: 14px;
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.flag {
  font-style: normal;
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 5px;
  font-size: 10px;
  padding: 0 3px;
  margin-right: 3px;
}
.flag.muted {
  color: var(--text-3);
  border-color: var(--text-3);
}
.conv-time {
  font-size: 11px;
  color: var(--text-2);
  flex-shrink: 0;
}
.conv-preview {
  flex: 1;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--badge);
}
.badge {
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--badge);
  color: #fff;
  font-size: 11px;
  display: grid;
  place-items: center;
  padding: 0 5px;
  flex-shrink: 0;
}
.badge.muted {
  background: var(--offline);
  color: #fff;
}
.conv-menu {
  position: fixed;
  min-width: 110px;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--highlight-edge), var(--shadow-float);
  padding: 5px;
  backdrop-filter: blur(18px) saturate(135%);
  -webkit-backdrop-filter: blur(18px) saturate(135%);
  z-index: 20;
}
.conv-menu button {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 7px;
  cursor: pointer;
}
.conv-menu button:hover {
  background: var(--surface-hover);
}
.conv-menu button.danger {
  color: var(--danger);
}

/* 移除聊天二次确认弹窗（决议 #125）：沿用设计语言——8px 圆角、茶青取消 hover、危险红主按钮 */
.confirm-mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 28, 24, 0.26);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: grid;
  place-items: center;
  z-index: 40;
}
.confirm-card {
  width: 320px;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--highlight-edge), var(--shadow-float);
  padding: 20px 20px 16px;
}
.confirm-card h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}
.confirm-card p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
  margin-bottom: 18px;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.confirm-actions button {
  height: 32px;
  padding: 0 16px;
  border-radius: 9px;
  font-size: 13px;
  cursor: pointer;
  transition:
    color 150ms ease,
    background 150ms ease,
    border-color 150ms ease,
    transform 90ms ease-out;
}
.confirm-actions button:active {
  transform: scale(0.97);
}
.confirm-actions .cancel {
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-2);
}
.confirm-actions .cancel:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.confirm-actions .danger-btn {
  border: none;
  background: var(--danger);
  color: #fff;
}
.confirm-actions .danger-btn:hover {
  filter: brightness(0.96);
}
@media (prefers-reduced-motion: reduce) {
  .conv,
  .confirm-actions button {
    transition: none;
  }
  .conv:active,
  .confirm-actions button:active {
    transform: none;
  }
}
</style>
