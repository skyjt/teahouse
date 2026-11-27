import { readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('界面直接引用的图标都有对应图形，包括头像裁剪的加减号', () => {
  const renderer = new URL('../', import.meta.url)
  const components = new URL('components/', renderer)
  const library = readFileSync(new URL('PantryIcon.vue', components), 'utf8')
  const drawn = new Set([...library.matchAll(/name === '([^']+)'/g)].map(match => match[1]))
  const missing: string[] = []

  for (const directory of [renderer, components]) {
    for (const file of readdirSync(directory).filter(name => name.endsWith('.vue'))) {
      const source = readFileSync(new URL(file, directory), 'utf8')
      for (const [, name] of source.matchAll(/<PantryIcon\b[^>]*?\sname="([^"]+)"/g)) {
        if (!drawn.has(name)) missing.push(file + ' → ' + name)
      }
    }
  }
  expect(missing).toEqual([])
})
