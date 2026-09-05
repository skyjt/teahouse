<script setup lang="ts">
import { computed, watch } from 'vue'
import type { MessageView, TransferView } from '../../../shared/ipc'
import { useTransfersStore } from '../stores/transfers'
import { formatBytes } from '../utils/format'
import { usePeersStore } from '../stores/peers'
import FileTypeIcon from './FileTypeIcon.vue'
import PantryIcon from './PantryIcon.vue'

// 文件消息卡片（ui-design §5，决议 #89「左信息 · 右状态」）：
// 左侧文件名 + 大小/进度；右侧二选一——有操作显示按钮、无操作显示状态徽标，
// 状态文字不再单独占左侧一行。

const props = defineProps<{ msg: MessageView }>()
const transfers = useTransfersStore()
const peersStore = usePeersStore()

interface TransferStats {
  total: number
  done: number
  failed: number
  canceled: number
  expired: number
  active: boolean
  receivedNames: string[]
}

const ref_ = computed(() => props.msg.fileRef)
const transferIds = computed(() => {
  if (!ref_.value) return []
  return ref_.value.transferIds && ref_.value.transferIds.length > 0
    ? ref_.value.transferIds
    : [ref_.value.transferId]
})
const transferList = computed(() =>
  transferIds.value.map((id) => transfers.byId[id]).filter((item): item is TransferView => !!item)
)
const transfer = computed(() => transferList.value[0])
const directFile = computed(() => ref_.value?.direct === true || transfer.value?.direct === true)
const multiOut = computed(
  () => transferIds.value.length > 1 && transferList.value.every((t) => t.direction === 'out')
)
const transferStats = computed<TransferStats>(() => {
  const stats: TransferStats = {
    total: transferList.value.length,
    done: 0,
    failed: 0,
    canceled: 0,
    expired: 0,
    active: false,
    receivedNames: []
  }
  for (const t of transferList.value) {
    if (t.status === 'done') {
      stats.done += 1
      stats.receivedNames.push(peersStore.nameOf(t.peerId))
    } else if (t.status === 'failed' || t.status === 'declined') {
      stats.failed += 1
    } else if (t.status === 'canceled') {
      stats.canceled += 1
    } else if (t.status === 'expired') {
      stats.expired += 1
    } else if (t.status === 'offering' || t.status === 'accepted') {
      stats.active = true
    }
  }
  return stats
})
const multiActive = computed(() => multiOut.value && transferStats.value.active)
// 群聊文件接收名单（决议 #75）：x/x 计数 + 已接收成员名（备注优先）
const totalCount = computed(() => transferIds.value.length)
const doneCount = computed(() => transferStats.value.done)
const receivedNames = computed(() => transferStats.value.receivedNames)
const percent = computed(() => {
  const list = multiOut.value ? transferList.value : transfer.value ? [transfer.value] : []
  const total = list.reduce((sum, t) => sum + t.totalSize, 0)
  const done = list.reduce((sum, t) => sum + t.bytesDone, 0)
  if (total === 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
})
const speed = computed(() =>
  transferIds.value.reduce((sum, id) => sum + (transfers.speed[id] ?? 0), 0)
)

// 单发传输中：左侧显示进度条 + 进度文字（x/y · 速率）
const inProgress = computed(() => !multiOut.value && transfer.value?.status === 'accepted')

// meta 行（决议 #89）：单发传输中显示「已传 / 总量 · 速率」，否则显示大小（+ 文件数）
const metaText = computed(() => {
  const t = transfer.value
  if (inProgress.value && t) {
    // 排队中（决议 #211）：发送方并发预算已满，显示真实状态而不是假 0 速度
    if (t.queued) return `${formatBytes(t.bytesDone)} / ${formatBytes(t.totalSize)} · 排队等待发送方`
    return `${formatBytes(t.bytesDone)} / ${formatBytes(t.totalSize)} · ${formatBytes(speed.value)}/s`
  }
  if (directFile.value && t?.direction === 'in' && t.status === 'done') {
    return '已保存本地'
  }
  const r = ref_.value
  if (!r) return ''
  const base = r.count > 1 ? `${formatBytes(r.size)} · ${r.count} 个文件` : formatBytes(r.size)
  // 群发传输中：大小后附整体速率（群聊用「已接收 x/x」计数代替进度条，决议 #75）
  if (multiActive.value && speed.value > 0) return `${base} · ${formatBytes(speed.value)}/s`
  return base
})

const stateChipText = computed(() => {
  const t = transfer.value
  if (!multiOut.value && t?.direction === 'out' && t.status === 'offering') {
    return directFile.value ? '发送中' : '等待接收'
  }
  return ''
})

// 右侧状态徽标文字（仅在无操作按钮时显示）
const statusText = computed(() => {
  if (multiOut.value) {
    const total = transferIds.value.length
    const { done, failed, canceled, expired, active } = transferStats.value
    if (props.msg.status === 'canceled') return '发送取消'
    if (done === total) return '已全部送达'
    if (expired > 0 && !active) return '发送已到期'
    if (failed === total && total > 0) return '传输失败'
    if (failed + canceled > 0) return `${failed + canceled} 位未完成`
    return `等待 ${total} 位成员接收`
  }
  const t = transfer.value
  if (!t) return ''
  switch (t.status) {
    case 'done':
      return t.direction === 'out' ? '发送成功' : '已完成'
    case 'declined':
      return t.direction === 'out' ? '对方已拒收' : '已拒收'
    case 'canceled':
      return t.direction === 'out' && props.msg.status === 'canceled' ? '发送取消' : '已取消'
    case 'expired':
      return t.direction === 'out' ? '发送已到期' : '文件已过期'
    default:
      return directFile.value ? '直接发送失败' : '传输失败'
  }
})

// 右侧操作判定（决议 #89）：有操作显示按钮，否则显示状态徽标
const showRecvActions = computed(
  () =>
    !directFile.value &&
    !multiOut.value &&
    transfer.value?.status === 'offering' &&
    transfer.value.direction === 'in'
)
const showCancel = computed(
  () =>
    multiActive.value ||
    (!multiOut.value &&
      (transfer.value?.status === 'offering' || transfer.value?.status === 'accepted'))
)
const directPeer = computed(() => (transfer.value ? peersStore.byId(transfer.value.peerId) : undefined))
const showDirectButton = computed(
  () =>
    !multiOut.value &&
    !props.msg.convId.startsWith('group:') &&
    !directFile.value &&
    props.msg.kind === 'file' &&
    transfer.value?.direction === 'out' &&
    transfer.value.status === 'offering'
)
const canRequestDirect = computed(
  () =>
    showDirectButton.value &&
    props.msg.status === 'sent' &&
    directPeer.value?.online === true &&
    (directPeer.value?.caps ?? []).includes('fd1')
)
const directButtonTitle = computed(() => {
  if (!showDirectButton.value) return ''
  if (props.msg.status !== 'sent') return '文件信息送达后可直接发送'
  if (!directPeer.value?.online) return '对方离线，无法直接发送'
  if (!(directPeer.value?.caps ?? []).includes('fd1')) return '对方版本暂不支持直接发送'
  return '让对方免确认保存到发送人目录'
})
const showReveal = computed(
  () => !multiOut.value && transfer.value?.status === 'done' && transfer.value.direction === 'in'
)
// 失败「继续」/ 取消「重新下载」（决议 #211）：仅本会话传输上下文仍可恢复时展示
const showRetry = computed(
  () =>
    !multiOut.value &&
    transfer.value?.direction === 'in' &&
    (transfer.value.status === 'failed' || transfer.value.status === 'canceled') &&
    transfer.value.retryable === true
)
const retryLabel = computed(() =>
  transfer.value?.status === 'canceled' ? '重新下载' : '继续'
)
const showBadge = computed(
  () => !showRecvActions.value && !showCancel.value && !showReveal.value && !showRetry.value
)
// 徽标配色：完成绿（带对勾）、取消灰、拒收/失败红
const badgeTone = computed(() => {
  if (multiOut.value) {
    const { done, failed, total } = transferStats.value
    if (total > 0 && done === total) return 'done'
    return failed > 0 ? 'failed' : 'muted'
  }
  const s = transfer.value?.status
  if (s === 'done') return 'done'
  if (s === 'failed' || s === 'declined') return 'failed'
  return 'muted'
})

watch(transferIds, (ids, _previous, onCleanup) => {
  const releases = ids.map((id) => transfers.retain(id))
  onCleanup(() => releases.forEach((release) => release()))
}, { immediate: true })

function cancelActiveTransfers(): void {
  for (const id of transferIds.value) transfers.cancel(id)
}

function requestDirect(): void {
  const t = transfer.value
  if (!t || !canRequestDirect.value) return
  transfers.direct(t.transferId)
}
</script>

<template>
  <div v-if="ref_" class="card">
    <div class="icon">
      <FileTypeIcon :name="ref_.name" :dir="ref_.dir" :size="36" />
    </div>
    <div class="info">
      <div class="name-line">
        <div class="name" :title="ref_.name">{{ ref_.name }}</div>
        <span v-if="directFile" class="direct-chip">直接</span>
        <span v-if="stateChipText" class="state-chip" :class="{ direct: directFile }">
          {{ stateChipText }}
        </span>
      </div>
      <div class="meta">{{ metaText }}</div>
      <div v-if="inProgress" class="bar">
        <div class="fill" :style="{ width: `${percent}%` }"></div>
      </div>
      <div v-if="multiOut" class="recv">
        <span class="recv-count">已接收 {{ doneCount }}/{{ totalCount }}</span>
        <span class="recv-pop" role="tooltip">
          <template v-if="receivedNames.length">{{ receivedNames.join('、') }}</template>
          <template v-else>还没有人接收</template>
        </span>
      </div>
    </div>
    <div class="tail">
      <template v-if="showRecvActions">
        <div class="action-row recv-action-row">
          <button class="act primary recv-primary" @click="transfers.accept(ref_.transferId)">
            接收
          </button>
          <button
            class="icon-act"
            aria-label="另存为"
            title="另存为"
            @click="transfers.accept(ref_.transferId, true)"
          >
            <PantryIcon name="folder" :size="14" />
          </button>
          <button
            class="icon-act danger"
            aria-label="拒绝接收"
            title="拒绝接收"
            @click="transfers.decline(ref_.transferId)"
          >
            <PantryIcon name="x" :size="14" />
          </button>
        </div>
      </template>
      <template v-else-if="showCancel">
        <div class="action-row">
          <button
            v-if="showDirectButton"
            class="act primary direct-act"
            :disabled="!canRequestDirect"
            :title="directButtonTitle"
            @click="requestDirect"
          >
            直接发送
          </button>
          <button
            :class="showDirectButton ? 'icon-act danger' : 'act danger'"
            :aria-label="showDirectButton ? '取消发送' : undefined"
            :title="showDirectButton ? '取消发送' : undefined"
            @click="cancelActiveTransfers"
          >
            <PantryIcon v-if="showDirectButton" name="x" :size="14" />
            <template v-else>取消</template>
          </button>
        </div>
      </template>
      <button v-else-if="showReveal" class="act" @click="transfers.reveal(ref_.transferId)">
        打开所在文件夹
      </button>
      <button v-else-if="showRetry" class="act primary" @click="transfers.accept(ref_.transferId)">
        {{ retryLabel }}
      </button>
      <span v-else-if="showBadge" class="badge" :class="badgeTone">
        <PantryIcon v-if="badgeTone === 'done'" name="check" :size="13" />
        {{ statusText }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.card {
  width: 276px;
  min-height: 58px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 9px 10px;
  display: flex;
  /* 三栏共享同一垂直中心线（决议 #129）：图标、文件名/大小、右侧操作/状态高低一致，
     无论右侧是单徽标还是 3 个堆叠按钮都不再出现左上右中的错位 */
  align-items: center;
  gap: 10px;
}
.icon {
  color: var(--primary);
  flex-shrink: 0;
  /* 与 FileTypeIcon 的 36px 字形等宽，避免图标溢出小盒子、挤占与文件名的间距 */
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
}
.info {
  flex: 1;
  min-width: 0;
}
.name-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.name {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.direct-chip {
  flex: 0 0 auto;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 10px;
  font-weight: 600;
  line-height: 18px;
}
.state-chip {
  flex: 0 0 auto;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-list);
  color: var(--text-2);
  font-size: 10px;
  font-weight: 600;
  line-height: 18px;
}
.state-chip.direct {
  background: var(--primary-weak);
  color: var(--primary);
}
.meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  height: 4px;
  background: var(--line);
  border-radius: 2px;
  margin-top: 6px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--primary);
  transition: width 0.2s;
}
.recv {
  position: relative;
  display: inline-block;
  margin-top: 6px;
}
.recv-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
  border-bottom: 1px dashed currentColor;
  cursor: default;
}
.recv-pop {
  display: none;
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  min-width: 120px;
  max-width: 220px;
  padding: 7px 10px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-1);
  white-space: normal;
  z-index: 8;
}
.recv:hover .recv-pop {
  display: block;
}
/* 右侧操作 / 状态区（决议 #89/#176）：垂直居中；直接发送双动作保持单行 */
.tail {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.action-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.act {
  border: 1px solid var(--line);
  background: transparent;
  border-radius: 6px;
  min-height: 26px;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 24px;
  cursor: pointer;
  color: var(--text-2);
  white-space: nowrap;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s,
    transform 0.15s;
}
.act.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  font-weight: 600;
}
.act.danger {
  color: var(--danger);
}
.direct-act {
  padding: 0 10px;
}
.recv-primary {
  padding: 0 11px;
}
.icon-act {
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--text-2);
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s,
    transform 0.15s;
}
.icon-act.danger {
  color: var(--danger);
}
.act:not(.primary):hover,
.icon-act:hover {
  background: var(--primary-weak);
}
.act:active:not(:disabled),
.icon-act:active {
  transform: translateY(1px);
}
.act:disabled {
  opacity: 0.45;
  cursor: default;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--text-3);
}
.badge.done {
  color: var(--online);
}
.badge.failed {
  color: var(--danger);
}
.badge.muted {
  color: var(--text-3);
}
</style>
