import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkReleaseArtifacts, checkVersionConsistency } from './check-version-consistency.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(packageVersion = '1.2.3', lockVersion = packageVersion) {
  const root = mkdtempSync(join(tmpdir(), 'pantry-version-check-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pantry', version: packageVersion }))
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: 'pantry', version: lockVersion, packages: { '': { name: 'pantry', version: lockVersion } } })
  )
  return root
}

describe('checkVersionConsistency', () => {
  it('发布前验证五份真实格式清单、十个安装包及其内容', async () => {
    const dir = join(fixture(), 'artifacts')
    const targets = {
      'debian10-uos20-x64': ['linux-amd64.deb', 'linux-x86_64.AppImage'],
      'debian10-uos20-arm64': ['linux-arm64.deb', 'linux-arm64.AppImage'],
      'mac-arm64': ['mac-arm64.zip', 'mac-arm64.dmg'],
      'win7-ia32': ['win-ia32-portable.exe', 'win-ia32-setup.exe'],
      'win7-x64': ['win-x64-portable.exe', 'win-x64-setup.exe']
    }
    for (const [target, suffixes] of Object.entries(targets)) {
      const folder = join(dir, target)
      mkdirSync(folder, { recursive: true })
      const lines = suffixes.map(suffix => {
        const name = `Teahouse-1.2.3-${suffix}`
        writeFileSync(join(folder, name), suffix)
        return `${createHash('sha256').update(suffix).digest('hex')}  ${name}`
      })
      writeFileSync(join(folder, `SHA256SUMS-${target}.txt`), lines.join('\r\n') + '\r\n')
    }
    expect(await checkReleaseArtifacts(dir, '1.2.3')).toEqual([])
    writeFileSync(join(dir, 'win7-x64', 'Teahouse-1.2.3-win-x64-setup.exe'), 'changed')
    rmSync(join(dir, 'mac-arm64', 'Teahouse-1.2.3-mac-arm64.dmg'))
    writeFileSync(join(dir, 'unexpected.txt'), 'other')
    expect(await checkReleaseArtifacts(dir, '1.2.3')).toEqual(expect.arrayContaining([
      'SHA-256 清单与安装包不符：SHA256SUMS-win7-x64.txt',
      '缺少安装包：Teahouse-1.2.3-mac-arm64.dmg',
      '未列入发布的文件：unexpected.txt'
    ]))
  })

  it('package、lock、tag 与产物版本一致时通过', () => {
    const root = fixture()
    const artifacts = join(root, 'artifacts', 'linux')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'Teahouse-1.2.3-linux-amd64.deb'), 'deb')
    writeFileSync(join(artifacts, 'SHA256SUMS.txt'), 'sum')

    expect(
      checkVersionConsistency({
        root,
        artifactsDir: join(root, 'artifacts'),
        env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' }
      })
    ).toEqual({ version: '1.2.3', errors: [] })
  })

  it('报告 lockfile 顶层与根包版本漂移', () => {
    const root = fixture('1.2.3', '1.2.2')
    const result = checkVersionConsistency({ root, env: {} })

    expect(result.errors).toContain('package-lock.json 顶层版本 1.2.2 与 package.json 1.2.3 不一致')
    expect(result.errors).toContain('package-lock.json 根包版本 1.2.2 与 package.json 1.2.3 不一致')
  })

  it('报告 Git tag 与包版本漂移', () => {
    const root = fixture()
    const result = checkVersionConsistency({
      root,
      env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.2' }
    })

    expect(result.errors).toEqual(['Git tag v1.2.2 与期望 v1.2.3 不一致'])
  })

  it('递归报告 Teahouse 产物文件名版本漂移', () => {
    const root = fixture()
    const artifacts = join(root, 'artifacts', 'windows')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'Teahouse-1.2.2-win-x64-setup.exe'), 'exe')

    const result = checkVersionConsistency({ root, artifactsDir: join(root, 'artifacts'), env: {} })

    expect(result.errors).toEqual([
      '产物文件名 Teahouse-1.2.2-win-x64-setup.exe 未使用版本前缀 Teahouse-1.2.3-'
    ])
  })
})
