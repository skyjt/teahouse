<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'icon' | 'color' | 'mono'
    size?: number
  }>(),
  {
    variant: 'color',
    size: 64
  }
)
</script>

<template>
  <svg
    class="pantry-brand-logo"
    :class="`is-${variant}`"
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    role="img"
    aria-label="茶话间 logo"
  >
    <rect v-if="variant === 'icon'" class="logo-bg" x="4" y="4" width="56" height="56" rx="14" />
    <path
      class="logo-body"
      d="M25 22h18c3.9 0 7 3.1 7 7v7c0 7.7-6.3 14-14 14h-8.4L20 55v-7.1c-3.7-2.4-6-6.5-6-11V29c0-3.9 3.1-7 7-7h4Z"
    />
    <path class="logo-handle" d="M50 31h1.8a7.2 7.2 0 0 1 0 14.4H48" />
    <path class="logo-tea" d="M24 31.5h20" />
    <path class="logo-steam" d="M27.5 15.5c-2-2.1-1.2-4.8 1-6.5" />
    <path class="logo-steam" d="M37.5 15.5c2-2.1 1.2-4.8-1-6.5" />
  </svg>
</template>

<style scoped>
.pantry-brand-logo {
  display: block;
  flex-shrink: 0;
}
.logo-bg {
  fill: var(--bg-window);
  stroke: var(--line);
  stroke-width: 1;
}
.logo-body {
  fill: var(--primary-weak);
  stroke: var(--primary);
  stroke-width: 3.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.logo-handle,
.logo-tea,
.logo-steam {
  fill: none;
  stroke-width: 3.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.logo-handle,
.logo-steam {
  stroke: var(--primary);
}
.logo-tea {
  stroke: #c49745;
}
.is-mono .logo-body {
  fill: none;
  stroke: currentColor;
}
.is-mono .logo-handle,
.is-mono .logo-tea,
.is-mono .logo-steam {
  stroke: currentColor;
}
</style>
