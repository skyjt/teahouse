import { ref, watch } from 'vue'
import type { SearchResult } from '../../../shared/ipc'

/** 同步在面板 setup 内调用，watch 随面板卸载自动清理。 */
export function useGlobalSearch(query: () => string) {
  const result = ref<SearchResult>({ peers: [], messageGroups: [], files: [] })
  const searching = ref(false)
  const failed = ref(false)

  watch(query, (q, _previous, onCleanup) => {
    let canceled = false
    searching.value = true
    failed.value = false
    const timer = setTimeout(async () => {
      try {
        const next = await window.pantry.search(q)
        if (!canceled) result.value = next
      } catch {
        if (!canceled) failed.value = true
      } finally {
        if (!canceled) searching.value = false
      }
    }, 200)
    onCleanup(() => {
      canceled = true
      clearTimeout(timer)
    })
  }, { immediate: true, flush: 'sync' })

  return { result, searching, failed }
}
