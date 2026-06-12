<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PeerView } from '../../../shared/ipc'
import { avatarStyle, avatarText } from '../utils/avatar'

// 联系人资料卡（ui-design §4）：信息 + 本地备注（F-DISC-9）+ 发消息入口

const props = defineProps<{ peer: PeerView }>()
const emit = defineEmits<{ chat: [nodeId: string] }>()

const remark = ref(props.peer.remark)
const saved = ref(false)

watch(
  () => props.peer.nodeId,
  () => {
    remark.value = props.peer.remark
    saved.value = false
  }
)

async function saveRemark(): Promise<void> {
  await window.pantry.setPeerRemark(props.peer.nodeId, remark.value.trim())
  saved.value = true
  setTimeout(() => (saved.value = false), 1500)
}

function orgPath(p: PeerView): string {
  return [p.company, p.dept, p.team].filter(Boolean).join(' / ') || '未分组'
}

function profileAvatarStyle(peer: PeerView): { backgroundColor: string; color: string } {
  return peer.online
    ? avatarStyle(peer.avatar, peer.remark || peer.nick)
    : { backgroundColor: 'var(--offline)', color: '#fff' }
}
</script>

<template>
  <div class="card-wrap">
    <div class="card">
      <div class="head">
        <span class="avatar" :class="{ off: !peer.online }" :style="profileAvatarStyle(peer)">
          {{ avatarText(peer.avatar, peer.remark || peer.nick) }}
        </span>
        <div class="who">
          <div class="name">
            {{ peer.remark || peer.nick }}
            <span v-if="peer.remark" class="raw-nick">（昵称：{{ peer.nick }}）</span>
          </div>
          <div class="state" :class="{ on: peer.online }">
            {{ peer.online ? '● 在线' : '离线' }}
          </div>
        </div>
      </div>

      <div class="info">
        <div class="row"><span>组织</span>{{ orgPath(peer) }}</div>
        <div class="row"><span>IP</span>{{ peer.ip }}</div>
        <div class="row"><span>主机</span>{{ peer.host }}</div>
        <div class="row">
          <span>平台</span
          >{{ peer.platform === 'win' ? 'Windows' : peer.platform === 'mac' ? 'macOS' : 'Linux' }}
        </div>
        <div class="row remark-row">
          <span>备注</span>
          <input
            v-model="remark"
            maxlength="32"
            placeholder="仅自己可见，重名时好认"
            @keydown.enter="saveRemark"
          />
          <button class="ghost" @click="saveRemark">{{ saved ? '已保存' : '保存' }}</button>
        </div>
      </div>

      <button class="primary" @click="emit('chat', peer.nodeId)">发消息</button>
    </div>
  </div>
</template>

<style scoped>
.card-wrap {
  display: grid;
  place-items: center;
  height: 100%;
}
.card {
  width: 340px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 24px;
}
.head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 18px;
}
.avatar {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 22px;
}
.avatar.off {
  background: var(--offline);
}
.name {
  font-size: 16px;
  font-weight: 600;
}
.raw-nick {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}
.state {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.state.on {
  color: var(--online);
}
.info {
  border-top: 1px solid var(--line);
  padding-top: 12px;
  margin-bottom: 18px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 8px;
  color: var(--text-1);
}
.row > span:first-child {
  width: 44px;
  color: var(--text-3);
  flex-shrink: 0;
}
.remark-row input {
  flex: 1;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 8px;
  font-size: 12px;
  outline: none;
  user-select: text;
}
.remark-row input:focus {
  border-color: var(--primary);
}
.ghost {
  border: 1px solid var(--line);
  background: transparent;
  border-radius: 4px;
  font-size: 11px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-2);
}
.primary {
  width: 100%;
  border: none;
  background: var(--primary);
  color: #fff;
  font-size: 14px;
  padding: 9px 0;
  border-radius: 4px;
  cursor: pointer;
}
</style>
