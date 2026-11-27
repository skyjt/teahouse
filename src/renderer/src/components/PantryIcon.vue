<script setup lang="ts">
import { computed } from 'vue'

const iconSizes = { action: 22, compact: 18, inline: 16 } as const
const props = withDefaults(
  defineProps<{
    name: string
    size?: number | keyof typeof iconSizes
  }>(),
  { size: 'compact' }
)
const pixels = computed(() => typeof props.size === 'number' ? props.size : iconSizes[props.size])
</script>

<template>
  <svg
    class="pantry-icon"
    :width="pixels"
    :height="pixels"
    :stroke-width="pixels <= 16 ? 2 : 1.8"
    focusable="false"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <g v-if="name === 'screen'">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M12 17v4M8 21h8" />
    </g>
    <g v-else-if="name === 'chat'">
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
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.8 20v-1.2c0-3.1 2.5-5 6.2-5s6.2 1.9 6.2 5V20m.4-15.1a3.4 3.4 0 0 1 0 6.5m2.1 2.6c2.3.7 3.5 2.3 3.5 4.7V20" />
    </g>
    <g v-else-if="name === 'settings'">
      <path d="M10.2 4.4h3.6l.5 2.1c.5.2.9.4 1.3.8l2-.7 1.8 3.1-1.5 1.5a6.7 6.7 0 0 1 0 1.6l1.5 1.5-1.8 3.1-2-.7c-.4.3-.8.6-1.3.8l-.5 2.1h-3.6l-.5-2.1c-.5-.2-.9-.4-1.3-.8l-2 .7-1.8-3.1 1.5-1.5a6.7 6.7 0 0 1 0-1.6L4.6 9.7l1.8-3.1 2 .7c.4-.3.8-.6 1.3-.8l.5-2.1Z" />
      <circle cx="12" cy="12" r="3.2" />
    </g>
    <g v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.8v2" />
      <path d="M12 18.2v2" />
      <path d="M3.8 12h2" />
      <path d="M18.2 12h2" />
      <path d="m6.2 6.2 1.4 1.4" />
      <path d="m16.4 16.4 1.4 1.4" />
      <path d="m17.8 6.2-1.4 1.4" />
      <path d="m7.6 16.4-1.4 1.4" />
    </g>
    <g v-else-if="name === 'moon'">
      <path d="M18.6 15.2A7.4 7.4 0 0 1 8.8 5.4 7.4 7.4 0 1 0 18.6 15.2Z" />
    </g>
    <g v-else-if="name === 'key-enter'">
      <path d="M18.5 6.5v5.2H6.2" />
      <path d="m9 8.9-3 2.8 3 2.8" />
    </g>
    <g v-else-if="name === 'key-control'">
      <path d="m6.8 14.8 5.2-5.2 5.2 5.2" />
    </g>
    <g v-else-if="name === 'key-command'">
      <path d="M9 9H6.8a2.8 2.8 0 1 1 2.8-2.8V17.8a2.8 2.8 0 1 1-2.8-2.8h10.4a2.8 2.8 0 1 1-2.8 2.8V6.2A2.8 2.8 0 1 1 17.2 9H9v6h6V9Z" />
    </g>
    <g v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="6.6" />
      <path d="m15.3 15.3 5.2 5.2" />
    </g>
    <g v-else-if="name === 'x'">
      <path d="m6 6 12 12M18 6 6 18" />
    </g>
    <g v-else-if="name === 'plus'">
      <path d="M12 4.5v15m-7.5-7.5h15" />
    </g>
    <g v-else-if="name === 'minus'">
      <path d="M4.5 12h15" />
    </g>
    <g v-else-if="name === 'send-many' || name === 'send'">
      <path d="m3 10.6 17.6-7-6.5 17-3.4-7.1L3 10.6Zm7.7 2.9 6-6" />
    </g>
    <g v-else-if="name === 'smile'">
      <circle cx="12" cy="12" r="8.8" />
      <path d="M8.1 14c.9 1.6 2.1 2.4 3.9 2.4s3-.8 3.9-2.4m-6.8-4.5h.1m5.8 0h.1" />
    </g>
    <!-- 窗口震动（决议 #149）：带标题栏的应用窗口 + 左右对称振动弧，表达“抖一抖”；替换原“显示器 + 底座 + 放射线”，后者易被误读为屏幕发光 -->
    <g v-else-if="name === 'nudge'">
      <rect x="6.9" y="5" width="10.2" height="14" rx="2" />
      <path d="M7 9h10M3.8 8.5a6.9 6.9 0 0 0 0 7m16.4-7a6.9 6.9 0 0 1 0 7" />
    </g>
    <!-- PK 入口：斜体 PK 字标（决议 #144），保留右倾字形 -->
    <g v-else-if="name === 'pk'" transform="translate(1.5 0) skewX(-7)">
      <path d="M4 18.5v-13h4a3.5 3.5 0 0 1 0 7H4m10-7v13m6-13-6 7 6 6" />
    </g>
    <g v-else-if="name === 'pk-rps'">
      <path d="m8.5 12.8-2.4-7a1.5 1.5 0 0 1 2.8-1l2.8 7.1 1-7.7a1.5 1.5 0 0 1 3 .4l-.8 7 .6-1a1.6 1.6 0 0 1 2.9.9v1.2a1.5 1.5 0 0 1 2.5 1.2l-.5 2.6c-.5 3-2.8 4.8-6.3 4.8-2.8 0-4.7-1.4-6.3-3.5l-3-3.9a1.6 1.6 0 0 1 2.4-2.1l2.9 2.7" />
    </g>
    <g v-else-if="name === 'pk-dice'">
      <rect x="4.4" y="4.4" width="15.2" height="15.2" rx="3.2" />
      <path d="M8.6 8.6h.1m6.6 0h.1M12 12h.1m-3.5 3.4h.1m6.6 0h.1" />
    </g>
    <g v-else-if="name === 'sticker'">
      <path d="M6 5h12v8.4L13.4 18H6V5Z" />
      <path d="M13.4 18v-4.6H18" />
      <path d="M9 9.2h.1" />
      <path d="M14.8 9.2h.1" />
      <path d="M9.3 12.5c1.5 1.1 3.9 1.1 5.4 0" />
    </g>
    <g v-else-if="name === 'scissors'">
      <circle cx="6.1" cy="7" r="2.6" />
      <circle cx="6.1" cy="17" r="2.6" />
      <path d="m8.3 8.4 12 11m-12-3.8 12-11" />
    </g>
    <g v-else-if="name === 'capture-select'">
      <path d="m5.3 3.5 14 9.6-6.5 1.1-3.4 5.8Z" />
    </g>
    <g v-else-if="name === 'capture-rect'">
      <rect x="3.7" y="4.6" width="16.6" height="14.8" rx="1.7" />
    </g>
    <g v-else-if="name === 'capture-arrow'">
      <path d="M4.4 19.6 19.6 4.4m-8.4 0h8.4v8.4" />
    </g>
    <g v-else-if="name === 'capture-mosaic'">
      <rect x="4.8" y="4.8" width="5.8" height="5.8" rx=".7" />
      <rect x="13.4" y="4.8" width="5.8" height="5.8" rx=".7" />
      <rect x="4.8" y="13.4" width="5.8" height="5.8" rx=".7" />
      <rect x="13.4" y="13.4" width="5.8" height="5.8" rx=".7" />
    </g>
    <!-- 表格：外框 + 一横一竖分格，用于表格粘贴提示 -->
    <g v-else-if="name === 'table'">
      <rect x="4.5" y="5.5" width="15" height="13" rx="1.6" />
      <path d="M4.5 10h15" />
      <path d="M10.2 10v8.5" />
    </g>
    <g v-else-if="name === 'image'">
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <path d="m3.4 16.6 5.4-5.4 5 5 2.8-2.8 4.3 4.3" />
      <circle cx="15.8" cy="8.8" r="1.25" />
    </g>
    <g v-else-if="name === 'zoom-in'">
      <circle cx="10.5" cy="10.5" r="6.6" />
      <path d="m15.3 15.3 5.2 5.2" />
      <path d="M10.5 7.5v6m-3-3h6" />
    </g>
    <g v-else-if="name === 'zoom-out'">
      <circle cx="10.5" cy="10.5" r="6.6" />
      <path d="m15.3 15.3 5.2 5.2" />
      <path d="M7.5 10.5h6" />
    </g>
    <g v-else-if="name === 'fit-screen'">
      <path d="M3.5 9V4h5m7 0h5v5m-17 6v5h5m7 0h5v-5" />
      <rect x="7.3" y="8.3" width="9.4" height="7.4" rx="1.2" />
    </g>
    <g v-else-if="name === 'actual-size'">
      <path d="M3.5 8V4.5H7m10 0h3.5V8M3.5 16v3.5H7m10 0h3.5V16" />
      <path d="m5.9 10.2 2-1.6v6.8m7.2-5.2 2-1.6v6.8M12 10.2h.01M12 14h.01" />
    </g>
    <g v-else-if="name === 'rotate-left'">
      <path d="M4 4.5v5h5M4.5 9a8 8 0 1 1 .3 7.3" />
    </g>
    <g v-else-if="name === 'rotate-right'">
      <path d="M20 4.5v5h-5m4.5-.5a8 8 0 1 0-.3 7.3" />
    </g>
    <g v-else-if="name === 'save' || name === 'download'">
      <path d="M12 3.5v11m-4.3-4.1L12 14.7l4.3-4.3M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </g>
    <g v-else-if="name === 'text-select'">
      <path d="M4.5 8.4V5.3h15v3.1M12 5.4v13.3m-3.5 0h7" />
    </g>
    <g v-else-if="name === 'text-scan'">
      <path d="M3.5 8V4.5H7m10 0h3.5V8M3.5 16v3.5H7m10 0h3.5V16M8 9V7.8h8V9m-4-1.2v8.4m-2.2 0h4.4" />
    </g>
    <g v-else-if="name === 'copy'">
      <rect x="8" y="8" width="10.5" height="10.5" rx="2" />
      <path d="M5.5 14.5V7a1.5 1.5 0 0 1 1.5-1.5h7.5" />
    </g>
    <g v-else-if="name === 'file' || name === 'document'">
      <path d="M6.4 3.2h7.2l4.9 5v11a1.6 1.6 0 0 1-1.6 1.6H6.4a1.6 1.6 0 0 1-1.6-1.6V4.8a1.6 1.6 0 0 1 1.6-1.6Z" />
      <path d="M13 3.5v5.2h5.1M8.6 13h6.8m-6.8 3.3h4.6" />
    </g>
    <g v-else-if="name === 'folder'">
      <path d="M3 7a2 2 0 0 1 2-2h4.6l2.1 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </g>
    <g v-else-if="name === 'folder-tree'">
      <path d="M4.5 8h6l1.5 2h7.5v7.8h-15V8Z" />
      <path d="M8 12h8" />
      <path d="M8 15h5" />
    </g>
    <g v-else-if="name === 'check'">
      <path d="m4 12.1 5.2 5.1L20 6.6" />
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
      <path d="M20 4v5.2h-5.2m5-.2A8 8 0 0 0 5.1 7.2M4 20v-5.2h5.2m-5 .2a8 8 0 0 0 14.7 1.8" />
    </g>
    <g v-else-if="name === 'chevron-up'">
      <path d="m5.8 15.1 6.2-6.2 6.2 6.2" />
    </g>
    <g v-else-if="name === 'chevron-down'">
      <path d="m5.8 8.9 6.2 6.2 6.2-6.2" />
    </g>
    <g v-else-if="name === 'chevron-left'">
      <path d="m15.1 5.8-6.2 6.2 6.2 6.2" />
    </g>
    <g v-else-if="name === 'chevron-right'">
      <path d="m8.9 5.8 6.2 6.2-6.2 6.2" />
    </g>
    <g v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5m0-8.2h.01" />
    </g>
    <!-- 注意 / 需确认：三角形 + 叹号，用于非删除但代价较高的操作提示 -->
    <g v-else-if="name === 'warning'">
      <path d="M12 4.8 20.2 18.6H3.8L12 4.8Z" />
      <path d="M12 10.2v4" />
      <path d="M12 16.4h.01" />
    </g>
    <g v-else-if="name === 'external'">
      <path d="M14 4h6v6m0-6-9 9m-.8-7.5H6a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2v-4.2" />
    </g>
    <!-- 文件柜（决议 #283）：带提手的收纳箱，与主导航使用同一轮廓 -->
    <g v-else-if="name === 'cabinet'">
      <path d="m3.1 8 2.6-4.2h12.6L20.9 8v10.3a1.9 1.9 0 0 1-1.9 1.9H5a1.9 1.9 0 0 1-1.9-1.9Z" />
      <path d="M3.4 8.6h17.2m-11.2 4.8h5.2" />
    </g>
    <g v-else-if="name === 'list'">
      <path d="M4 5.5h.1m4 0H20M4 12h.1m4 0H20M4 18.5h.1m4 0H20" />
    </g>
    <g v-else-if="name === 'grid'">
      <rect x="3.5" y="3.5" width="6.6" height="6.6" rx="1.2" />
      <rect x="13.9" y="3.5" width="6.6" height="6.6" rx="1.2" />
      <rect x="3.5" y="13.9" width="6.6" height="6.6" rx="1.2" />
      <rect x="13.9" y="13.9" width="6.6" height="6.6" rx="1.2" />
    </g>
    <g v-else-if="name === 'upload'">
      <path d="M12 15V3.8m-4.4 4.4L12 3.8l4.4 4.4M4 15.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3.5" />
    </g>
    <g v-else-if="name === 'shield'">
      <path d="M12 3.5 18.5 6v5c0 4-2.7 7.3-6.5 8.5C8.2 18.3 5.5 15 5.5 11V6L12 3.5Z" />
      <path d="m9.2 11.7 2 2 3.6-3.8" />
    </g>
    <g v-else-if="name === 'bullhorn'">
      <path d="M4.5 9h5.6l9.2-4v13l-9.2-3.6H4.5a1.5 1.5 0 0 1-1.5-1.5v-2.4A1.5 1.5 0 0 1 4.5 9Z" />
      <path d="M6 14.5 7.4 20h3.2l-1.5-5.5M19.3 9.2a2.5 2.5 0 0 1 0 4.6" />
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
  stroke-linecap: round;
  stroke-linejoin: round;
}
.fill-only {
  fill: currentColor;
  stroke: none;
}
</style>
