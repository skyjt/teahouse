<script setup lang="ts">
withDefaults(
  defineProps<{
    name: string
    size?: number
  }>(),
  { size: 18 }
)
</script>

<template>
  <svg
    class="pantry-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <g v-if="name === 'chat'" class="fill-only">
      <path d="M12 5.4c4.4 0 8 2.8 8 6.2s-3.6 6.2-8 6.2c-.8 0-1.6-.1-2.4-.3l-3 2c-.5.3-1-.1-.9-.6l.7-3.1C4.9 14.7 4 13.2 4 11.6c0-3.4 3.6-6.2 8-6.2Z" />
    </g>
    <g v-else-if="name === 'contacts'">
      <circle cx="8.2" cy="8.2" r="2.7" />
      <path d="M3.5 18.7c.5-3.4 2.2-5.1 4.7-5.1s4.2 1.7 4.7 5.1" />
      <path d="M15.2 8h4.4" />
      <path d="M15.2 12h3.7" />
      <path d="M15.2 16h2.6" />
    </g>
    <g v-else-if="name === 'users'">
      <path d="M8.2 11.2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M3.5 19.1c.6-3.1 2.2-4.7 4.7-4.7s4.1 1.6 4.7 4.7" />
      <path d="M15.6 10.8a2.5 2.5 0 1 0 0-5" />
      <path d="M14.6 14.6c2.7.3 4.6 1.7 5.1 4.5" />
    </g>
    <g v-else-if="name === 'settings'">
      <path d="M10.2 4.4h3.6l.5 2.1c.5.2.9.4 1.3.8l2-.7 1.8 3.1-1.5 1.5a6.7 6.7 0 0 1 0 1.6l1.5 1.5-1.8 3.1-2-.7c-.4.3-.8.6-1.3.8l-.5 2.1h-3.6l-.5-2.1c-.5-.2-.9-.4-1.3-.8l-2 .7-1.8-3.1 1.5-1.5a6.7 6.7 0 0 1 0-1.6L4.6 9.7l1.8-3.1 2 .7c.4-.3.8-.6 1.3-.8l.5-2.1Z" />
      <circle cx="12" cy="12" r="3.2" />
    </g>
    <g v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="5.2" />
      <path d="m14.4 14.4 4.1 4.1" />
    </g>
    <g v-else-if="name === 'x'">
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </g>
    <g v-else-if="name === 'plus'">
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </g>
    <g v-else-if="name === 'send-many'">
      <path d="M4.5 17.5 19 5.5l-4.2 13-3.4-5.1-5.8-1.3Z" />
      <path d="m11.4 13.4 3.6-3.6" />
    </g>
    <g v-else-if="name === 'smile'">
      <circle cx="12" cy="12" r="7.2" />
      <path d="M8.8 10h.1" />
      <path d="M15.1 10h.1" />
      <path d="M8.8 14.1c1.8 1.7 4.6 1.7 6.4 0" />
    </g>
    <!-- 窗口震动（决议 #149）：带标题栏的应用窗口 + 左右对称振动弧，表达“抖一抖”；替换原“显示器 + 底座 + 放射线”，后者易被误读为屏幕发光 -->
    <g v-else-if="name === 'nudge'">
      <rect x="8" y="6" width="8" height="12" rx="1.6" />
      <path d="M8 9.2h8" />
      <path d="M5.6 8.9C4.1 10.8 4.1 13.2 5.6 15.1" />
      <path d="M18.4 8.9c1.5 1.9 1.5 4.3 0 6.2" />
    </g>
    <!-- PK 入口：斜体 PK 字标（决议 #144），skewX 右倾营造竞技动感，加粗描边更醒目 -->
    <g v-else-if="name === 'pk'" transform="translate(2.2 0) skewX(-10)">
      <path stroke-width="2" d="M5.6 5v14" />
      <path stroke-width="2" d="M5.6 5h3.4c2.4 0 2.4 6 0 6H5.6" />
      <path stroke-width="2" d="M14 5v14" />
      <path stroke-width="2" d="M14 12 18.6 5" />
      <path stroke-width="2" d="M14 12 18.6 19" />
    </g>
    <g v-else-if="name === 'pk-rps'">
      <circle cx="8.8" cy="16.2" r="2" />
      <circle cx="15.2" cy="16.2" r="2" />
      <path d="M10.4 14.7 16.4 5.2" />
      <path d="M13.6 14.7 7.6 5.2" />
    </g>
    <g v-else-if="name === 'pk-dice'">
      <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2.4" />
      <path d="M9.4 9.4h.1" />
      <path d="M14.5 9.4h.1" />
      <path d="M12 12h.1" />
      <path d="M9.4 14.6h.1" />
      <path d="M14.5 14.6h.1" />
    </g>
    <g v-else-if="name === 'sticker'">
      <path d="M6 5h12v8.4L13.4 18H6V5Z" />
      <path d="M13.4 18v-4.6H18" />
      <path d="M9 9.2h.1" />
      <path d="M14.8 9.2h.1" />
      <path d="M9.3 12.5c1.5 1.1 3.9 1.1 5.4 0" />
    </g>
    <g v-else-if="name === 'scissors'">
      <circle cx="6.6" cy="7.2" r="2.1" />
      <circle cx="6.6" cy="16.8" r="2.1" />
      <path d="M8.5 8.2 18 17" />
      <path d="M8.5 15.8 18 7" />
    </g>
    <g v-else-if="name === 'image'">
      <rect x="4.5" y="5.5" width="15" height="13" rx="2" />
      <path d="m6.8 16 4-4 3 3 2-2 3 3" />
      <circle cx="15.8" cy="9.2" r="1" />
    </g>
    <g v-else-if="name === 'zoom-in'">
      <circle cx="10.6" cy="10.6" r="5.5" />
      <path d="m14.6 14.6 4 4" />
      <path d="M10.6 8.1v5" />
      <path d="M8.1 10.6h5" />
    </g>
    <g v-else-if="name === 'zoom-out'">
      <circle cx="10.6" cy="10.6" r="5.5" />
      <path d="m14.6 14.6 4 4" />
      <path d="M8.1 10.6h5" />
    </g>
    <g v-else-if="name === 'fit-screen'">
      <path d="M5.5 9V5.5H9" />
      <path d="M18.5 9V5.5H15" />
      <path d="M5.5 15v3.5H9" />
      <path d="M18.5 15v3.5H15" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" />
    </g>
    <g v-else-if="name === 'actual-size'">
      <rect x="5.5" y="5.5" width="13" height="13" rx="2" />
      <path d="M8.4 9.2h2.2v5.6" />
      <path d="M8.4 14.8h4.4" />
      <path d="M15.4 9.2h.1" />
      <path d="M15.4 14.8h.1" />
    </g>
    <g v-else-if="name === 'rotate-left'">
      <path d="M7.2 8.2H4.5V5.5" />
      <path d="M4.8 8.1A7.1 7.1 0 1 1 5 16.2" />
    </g>
    <g v-else-if="name === 'rotate-right'">
      <path d="M16.8 8.2h2.7V5.5" />
      <path d="M19.2 8.1A7.1 7.1 0 1 0 19 16.2" />
    </g>
    <g v-else-if="name === 'save'">
      <path d="M12 4.8v8.4" />
      <path d="m8.8 10.2 3.2 3.2 3.2-3.2" />
      <path d="M5.5 14.6v3.9h13v-3.9" />
    </g>
    <g v-else-if="name === 'text-select'">
      <path d="M5.5 5.5h13" />
      <path d="M12 5.5v13" />
      <path d="M9.2 18.5h5.6" />
      <path d="M6.2 9.2h2" />
      <path d="M15.8 9.2h2" />
      <path d="M6.2 14.8h2" />
      <path d="M15.8 14.8h2" />
    </g>
    <g v-else-if="name === 'copy'">
      <rect x="8" y="8" width="10.5" height="10.5" rx="2" />
      <path d="M5.5 14.5V7a1.5 1.5 0 0 1 1.5-1.5h7.5" />
    </g>
    <g v-else-if="name === 'file' || name === 'document'">
      <path d="M7 4.5h6.5L17 8v11.5H7V4.5Z" />
      <path d="M13.5 4.5V8H17" />
      <path d="M9.4 12h5.2" />
      <path d="M9.4 15h4" />
    </g>
    <g v-else-if="name === 'folder'">
      <path d="M4.5 8h6l1.5 2h7.5v8.5h-15V8Z" />
      <path d="M4.5 8V6.5h5.1l1.4 1.5" />
    </g>
    <g v-else-if="name === 'folder-tree'">
      <path d="M4.5 8h6l1.5 2h7.5v7.8h-15V8Z" />
      <path d="M8 12h8" />
      <path d="M8 15h5" />
    </g>
    <g v-else-if="name === 'check'">
      <path d="m5.5 12.4 4.2 4.1 8.8-9" />
    </g>
    <g v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="7.4" />
      <path d="M12 7.8v4.6l3 1.8" />
    </g>
    <g v-else-if="name === 'loader'">
      <path d="M12 4.6a7.4 7.4 0 0 1 7.4 7.4" />
      <path d="M12 19.4a7.4 7.4 0 0 1-7.4-7.4" />
    </g>
    <g v-else-if="name === 'edit'">
      <path d="M5.5 17.8 6.4 14l8-8 3.2 3.2-8 8-4.1.6Z" />
      <path d="m12.9 7.5 3.2 3.2" />
    </g>
    <g v-else-if="name === 'refresh'">
      <path d="M17.8 9.4A6.3 6.3 0 0 0 6.2 8" />
      <path d="M17.8 5.8v3.6h-3.6" />
      <path d="M6.2 14.6A6.3 6.3 0 0 0 17.8 16" />
      <path d="M6.2 18.2v-3.6h3.6" />
    </g>
    <g v-else-if="name === 'chevron-up'">
      <path d="m7 14 5-5 5 5" />
    </g>
    <g v-else-if="name === 'chevron-down'">
      <path d="m7 10 5 5 5-5" />
    </g>
    <g v-else-if="name === 'chevron-left'">
      <path d="m14 7-5 5 5 5" />
    </g>
    <g v-else-if="name === 'chevron-right'">
      <path d="m10 7 5 5-5 5" />
    </g>
    <g v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11.2v4.6" />
      <path d="M12 8.4h.01" />
    </g>
    <g v-else-if="name === 'external'">
      <path d="M13.5 5.5h5v5" />
      <path d="M18.5 5.5 11 13" />
      <path d="M17.5 13.8V17a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 17V8A1.5 1.5 0 0 1 7 6.5h3.2" />
    </g>
    <g v-else-if="name === 'shield'">
      <path d="M12 3.5 18.5 6v5c0 4-2.7 7.3-6.5 8.5C8.2 18.3 5.5 15 5.5 11V6L12 3.5Z" />
      <path d="m9.2 11.7 2 2 3.6-3.8" />
    </g>
    <g v-else>
      <circle cx="12" cy="12" r="7" />
    </g>
  </svg>
</template>

<style scoped>
.pantry-icon {
  display: block;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.fill-only {
  fill: currentColor;
  stroke: none;
}
</style>
