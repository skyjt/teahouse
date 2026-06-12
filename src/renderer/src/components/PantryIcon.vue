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
