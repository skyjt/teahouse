<script setup lang="ts">
import { computed } from 'vue'
import { compatEmojiItem } from '../utils/compat-emoji'
import { emojiToTwemojiCode, twemojiUrl } from '../utils/twemoji-assets'

const props = defineProps<{ emoji: string }>()

const item = computed(() => compatEmojiItem(props.emoji))
const label = computed(() => item.value?.label ?? props.emoji)
const src = computed(() => twemojiUrl(emojiToTwemojiCode(props.emoji)))
</script>

<template>
  <span class="compat-emoji" :title="label" :aria-label="label">
    <span :class="{ 'compat-emoji-text': src }" aria-hidden="true">{{ emoji }}</span>
    <img v-if="src" :src="src" alt="" aria-hidden="true" draggable="false" />
  </span>
</template>

<style scoped>
.compat-emoji {
  width: 1.3em;
  height: 1.3em;
  display: inline-block;
  position: relative;
  overflow: hidden;
  text-align: center;
  vertical-align: -0.24em;
  line-height: 1;
}
.compat-emoji-text {
  /* 保留原生可选文字；行内排版避免 grid 子项在复制时夹入换行。 */
  opacity: 0;
}
.compat-emoji img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  pointer-events: none;
}
</style>
