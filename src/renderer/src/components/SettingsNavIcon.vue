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
  <!-- 设置侧栏专用图标（决议 #239）：同一 24px 网格与 1.8px 圆角线条。 -->
  <svg
    class="settings-nav-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <g v-if="name === 'settings-profile'">
      <rect x="2.8" y="4.6" width="18.4" height="14.8" rx="2.4" />
      <circle cx="8.4" cy="10" r="2.1" />
      <path d="M5 16c.5-1.7 1.6-2.5 3.4-2.5s3 .8 3.4 2.5M14.6 9.4h3.3m-3.3 4.3h2.5" />
    </g>
    <g v-else-if="name === 'settings-general'">
      <path d="M3.5 7.3h3.6m5 0h8.4m-17 9.4h8.4m5 0h3.6" />
      <circle cx="9.6" cy="7.3" r="2.5" />
      <circle cx="14.4" cy="16.7" r="2.5" />
    </g>
    <g v-else-if="name === 'settings-notify'">
      <path d="M4.3 16.9c2-1.8 2-4.1 2-6.6a5.7 5.7 0 0 1 11.4 0c0 2.5 0 4.8 2 6.6Zm5.2 2.3a2.9 2.9 0 0 0 5 0M12 3v1.4" />
    </g>
    <g v-else-if="name === 'settings-storage'">
      <path d="M9.8 15.3H8l-3.8 2.5.6-3a2 2 0 0 1-1.6-2V5.9c0-1.2.9-2.1 2.1-2.1h10c1.2 0 2.1.9 2.1 2.1v.9" />
      <path d="M13 9.1h4.6l3.2 3.3v7.5c0 .5-.4.9-.9.9H13a.9.9 0 0 1-.9-.9V10c0-.5.4-.9.9-.9Z" />
    </g>
    <g v-else-if="name === 'settings-network'">
      <rect x="8.8" y="3.6" width="6.4" height="5.3" rx="1.3" />
      <rect x="3" y="15.1" width="6.4" height="5.3" rx="1.3" />
      <rect x="14.6" y="15.1" width="6.4" height="5.3" rx="1.3" />
      <path d="M12 9v3.1m-5.8 2.7v-2.7h11.6v2.7" />
    </g>
    <g v-else-if="name === 'settings-shortcuts'">
      <rect x="2.6" y="5" width="18.8" height="14" rx="2.5" />
      <path d="M6.6 9.6h.1m3.4 0h.1m3.5 0h.1m3.4 0h.1M7 14.3h.1m3.5 0H17" />
    </g>
    <g v-else-if="name === 'settings-about'">
      <circle cx="12" cy="12" r="8.7" />
      <path d="M12 11.2V16m0-8h.01" />
    </g>
  </svg>
</template>

<style scoped>
.settings-nav-icon {
  display: block;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
