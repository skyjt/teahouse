<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useStickersStore } from '../stores/stickers'
import { COMPAT_EMOJIS } from '../utils/compat-emoji'
import CompatEmoji from './CompatEmoji.vue'
import PantryIcon from './PantryIcon.vue'

// 表情面板双页签（ui-design §5）：emoji / 我的表情包。
// Win7 / UOS 缺字平台：emoji 页使用本地 SVG 展示，点击仍插入原始 UTF-8 字符。

const emit = defineEmits<{ select: [emoji: string]; sticker: [id: string] }>()
const props = defineProps<{ stickerEnabled: boolean }>()

const tab = ref<'emoji' | 'sticker'>('emoji')
const stickers = useStickersStore()
const importLabel = ref('导入')
let importLabelTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => void stickers.init())
onBeforeUnmount(() => {
  if (importLabelTimer) clearTimeout(importLabelTimer)
})

async function importStickers(): Promise<void> {
  tab.value = 'sticker'
  const result = await stickers.importFiles()
  if (!result) return
  importLabel.value = result.added === 0 ? '导入失败' : result.added < result.selected ? '部分失败' : '已导入'
  if (importLabelTimer) clearTimeout(importLabelTimer)
  importLabelTimer = setTimeout(() => {
    importLabel.value = '导入'
    importLabelTimer = null
  }, 2000)
}
</script>

<template>
  <div class="panel">
    <div class="tabs">
      <button :class="{ on: tab === 'emoji' }" @click="tab = 'emoji'">
        <PantryIcon name="smile" :size="15" />表情
      </button>
      <button :class="{ on: tab === 'sticker' }" @click="tab = 'sticker'">
        <PantryIcon name="sticker" :size="15" />表情包
      </button>
      <button
        class="import-button"
        type="button"
        :disabled="stickers.importing"
        :aria-label="stickers.importing ? '正在导入表情包' : '导入表情包'"
        @click="importStickers"
      >
        <PantryIcon name="plus" :size="14" />{{ stickers.importing ? '导入中…' : importLabel }}
      </button>
    </div>

    <div v-if="tab === 'emoji'" class="grid emoji-grid">
      <button
        v-for="item in COMPAT_EMOJIS"
        :key="item.char"
        class="emo"
        :title="item.label"
        @click="emit('select', item.char)"
      >
        <CompatEmoji :emoji="item.char" />
      </button>
    </div>

    <div v-else class="grid sticker-grid" :class="{ 'is-empty': stickers.list.length === 0 }">
      <div
        v-for="(s, index) in stickers.list"
        :key="s.id"
        class="stk"
        :class="{ disabled: !props.stickerEnabled }"
        :title="props.stickerEnabled ? '点击发送，右键删除' : '当前会话不可发表情包'"
        @click="props.stickerEnabled && emit('sticker', s.id)"
        @contextmenu.prevent="stickers.remove(s.id)"
      >
        <img
          :src="`pantry-sticker://${s.id}`"
          alt="表情"
          loading="lazy"
          decoding="async"
        />
        <span class="stk-actions" @click.stop>
          <button
            type="button"
            aria-label="上移表情"
            :disabled="index === 0"
            @click="stickers.move(s.id, -1)"
          >
            <PantryIcon name="chevron-up" :size="12" />
          </button>
          <button
            type="button"
            aria-label="下移表情"
            :disabled="index === stickers.list.length - 1"
            @click="stickers.move(s.id, 1)"
          >
            <PantryIcon name="chevron-down" :size="12" />
          </button>
        </span>
      </div>
      <p v-if="stickers.list.length === 0" class="empty">
        还没有收藏的表情<br />在聊天图片上右键「添加到表情」
      </p>
    </div>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 6px;
  width: 324px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.1);
  z-index: 8;
}
.tabs {
  display: flex;
  border-bottom: 1px solid var(--line);
}
.tabs button {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 12px;
  padding: 8px 0;
  cursor: pointer;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.tabs button.on {
  color: var(--primary);
  font-weight: 600;
}
.tabs .import-button {
  flex: 0 0 auto;
  min-width: 78px;
  padding-inline: 9px;
  border-left: 1px solid var(--line);
  color: var(--primary);
}
.tabs .import-button:hover:not(:disabled) {
  background: var(--bg-list);
}
.tabs .import-button:disabled {
  cursor: default;
  opacity: 0.55;
}
.grid {
  height: 200px;
  overflow-y: auto;
  padding: 8px;
  display: grid;
  gap: 2px;
  box-sizing: border-box;
}
.emoji-grid {
  grid-template-columns: repeat(8, 1fr);
}
.sticker-grid {
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: max-content;
  gap: 6px;
}
.sticker-grid.is-empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
.emo {
  border: none;
  background: transparent;
  /* 16px × CompatEmoji 1.3em ≈ 21px 图标：比正文（1.3em ≈ 18px）略大便于点选，
     不再用 22px 字号（≈ 29px 图标，与消息/输入框尺度脱节，ui-design §9） */
  font-size: 16px;
  padding: 6px 4px;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1.2;
  display: grid;
  place-items: center;
}
.emo:hover {
  background: var(--line);
}
.stk {
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  display: grid;
  place-items: center;
  background: var(--bg-list);
  position: relative;
}
.stk:hover {
  outline: 2px solid var(--primary);
}
.stk.disabled {
  opacity: 0.45;
  cursor: default;
}
.stk img {
  max-width: 100%;
  max-height: 100%;
}
.stk-actions {
  position: absolute;
  right: 3px;
  bottom: 3px;
  display: none;
  gap: 2px;
}
.stk:hover .stk-actions {
  display: flex;
}
.stk-actions button {
  border: none;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
}
.stk-actions button:disabled {
  opacity: 0.35;
  cursor: default;
}
.empty {
  grid-column: 1 / -1;
  text-align: center;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
  padding: 20px 8px;
}
</style>
