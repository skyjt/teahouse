<script setup lang="ts">
import { computed } from 'vue'
import 'katex/dist/katex.min.css'
import { isSafeHttpUrl, renderMarkdown } from '../utils/markdown-message'

const props = defineProps<{
  text: string
}>()

const html = computed(() => renderMarkdown(props.text))

function onClick(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest('a')
  if (!anchor) return
  event.preventDefault()
  event.stopPropagation()
  const href = anchor.getAttribute('href') ?? ''
  if (isSafeHttpUrl(href)) void window.pantry.openUrl(href)
}
</script>

<template>
  <div class="md-bubble" @click="onClick" v-html="html"></div>
</template>

<style scoped>
.md-bubble {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
  line-height: 1.55;
  font-size: inherit;
  color: inherit;
}

.md-bubble :deep(p) {
  margin: 0 0 0.55em;
}

.md-bubble :deep(p:last-child) {
  margin-bottom: 0;
}

.md-bubble :deep(h1),
.md-bubble :deep(h2),
.md-bubble :deep(h3),
.md-bubble :deep(h4),
.md-bubble :deep(h5),
.md-bubble :deep(h6) {
  margin: 0.4em 0 0.35em;
  line-height: 1.3;
  font-weight: 650;
}

.md-bubble :deep(h1) { font-size: 1.25em; }
.md-bubble :deep(h2) { font-size: 1.15em; }
.md-bubble :deep(h3) { font-size: 1.08em; }

.md-bubble :deep(ul),
.md-bubble :deep(ol) {
  margin: 0.35em 0;
  padding-left: 1.35em;
}

.md-bubble :deep(li) {
  margin: 0.15em 0;
}

.md-bubble :deep(blockquote) {
  margin: 0.45em 0;
  padding: 0.15em 0 0.15em 0.75em;
  border-left: 3px solid var(--line);
  color: var(--text-2);
}

.md-bubble :deep(pre) {
  margin: 0.45em 0;
  padding: 0.55em 0.7em;
  overflow-x: auto;
  border-radius: 8px;
  background: var(--surface-hover);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  line-height: 1.45;
}

.md-bubble :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}

.md-bubble :deep(:not(pre) > code) {
  padding: 0.1em 0.35em;
  border-radius: 4px;
  background: var(--surface-hover);
}

.md-bubble :deep(table) {
  border-collapse: collapse;
  margin: 0.45em 0;
  max-width: 100%;
  font-size: 0.95em;
}

.md-bubble :deep(th),
.md-bubble :deep(td) {
  border: 1px solid var(--line);
  padding: 0.25em 0.5em;
}

.md-bubble :deep(th) {
  background: var(--surface-hover);
  font-weight: 600;
}

.md-bubble :deep(a.md-link) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.md-bubble :deep(a.md-link-blocked) {
  color: inherit;
  text-decoration: none;
  pointer-events: none;
}

.md-bubble :deep(.katex-display) {
  margin: 0.5em 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.md-bubble :deep(.katex) {
  font-size: 1.05em;
}

.md-bubble :deep(hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 0.7em 0;
}
</style>