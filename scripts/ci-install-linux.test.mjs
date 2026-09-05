import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('Linux 拆分安装覆盖锁文件中的安装钩子，better-sqlite3 只强制重建一次', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const script = readFileSync('scripts/ci-install-linux.sh', 'utf8')
  const hooks = Object.entries(lock.packages)
    .filter(([name, pkg]) => name && pkg.hasInstallScript && (!pkg.os || pkg.os.includes('linux')))
    .map(([name]) => name.replace(/^node_modules\//, ''))
  const replayed = script.match(/^npm rebuild (.+)$/m)[1].split(' ')
  expect([...replayed, 'better-sqlite3'].sort()).toEqual(hooks.sort())
  expect(script).toMatch(/^npm ci .*--ignore-scripts/m)
  expect(script.match(/^npm_config_build_from_source=true npm run rebuild:electron$/gm)).toHaveLength(1)
  expect(script).toMatch(/^node scripts\/check-native-glibc.cjs /m)
})
