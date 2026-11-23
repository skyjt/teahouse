import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import type { GroupView } from '../../../shared/ipc'
import { useGroupsStore } from './groups'

afterEach(() => vi.unstubAllGlobals())

it.each([2, 3])('初始 rev %i 的查询保留等待期间推送的群成员状态', async rev => {
  setActivePinia(createPinia())
  const stale = { groupId: 'g', rev, amMember: false } as GroupView
  const latest = { ...stale, rev: 3, amMember: true }
  let update!: (g: GroupView) => void
  let list!: (g: GroupView[]) => void
  let get!: (g: GroupView) => void
  vi.stubGlobal('window', { pantry: {
    onGroupUpdated: (handler: typeof update) => { update = handler; return () => {} },
    listGroups: () => new Promise<GroupView[]>(resolve => { list = resolve }),
    getGroup: () => new Promise<GroupView>(resolve => { get = resolve })
  } })
  const store = useGroupsStore()
  const init = store.init()
  const ensure = store.ensure('g')
  update(latest)
  list([stale])
  get(stale)
  await Promise.all([init, ensure])
  expect(store.byId.g).toEqual(latest)
})
