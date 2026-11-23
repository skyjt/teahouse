import { tr } from '../utils/i18n'
import { defineStore } from 'pinia'
import type { GroupView } from '../../../shared/ipc'

function mergeSnapshot(byId: Record<string, GroupView>, group: GroupView): void {
  const current = byId[group.groupId]
  // 同一 rev 的推送仍可能是较新的 LWW 快照，旧 IPC 查询不应覆盖它。
  if (!current || group.rev > current.rev) byId[group.groupId] = group
}

export const useGroupsStore = defineStore('groups', {
  state: () => ({
    byId: {} as Record<string, GroupView>,
    initialized: false
  }),
  getters: {
    nameOf: (state) => {
      return (groupId: string): string => state.byId[groupId]?.name ?? tr('讨论组')
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      const unsubscribe = window.pantry.onGroupUpdated((g) => {
        this.byId[g.groupId] = g
      })
      try {
        for (const g of await window.pantry.listGroups()) mergeSnapshot(this.byId, g)
      } catch (error) {
        unsubscribe()
        this.initialized = false
        throw error
      }
    },
    async ensure(groupId: string): Promise<void> {
      if (this.byId[groupId]) return
      const g = await window.pantry.getGroup(groupId)
      if (g) mergeSnapshot(this.byId, g)
    }
  }
})
