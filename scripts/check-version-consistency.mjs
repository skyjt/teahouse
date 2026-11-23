import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function collectFiles(dir) {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    const path = resolve(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...collectFiles(path))
    else if (stat.isFile()) files.push(path)
  }
  return files
}

export function checkVersionConsistency({ root = process.cwd(), artifactsDir, env = process.env } = {}) {
  const pkg = readJson(resolve(root, 'package.json'))
  const lock = readJson(resolve(root, 'package-lock.json'))
  const version = pkg.version
  const errors = []

  if (lock.version !== version) {
    errors.push(`package-lock.json 顶层版本 ${String(lock.version)} 与 package.json ${version} 不一致`)
  }
  const rootLockVersion = lock.packages?.['']?.version
  if (rootLockVersion !== version) {
    errors.push(`package-lock.json 根包版本 ${String(rootLockVersion)} 与 package.json ${version} 不一致`)
  }

  if (env.GITHUB_REF_TYPE === 'tag') {
    const expectedTag = `v${version}`
    if (env.GITHUB_REF_NAME !== expectedTag) {
      errors.push(`Git tag ${String(env.GITHUB_REF_NAME)} 与期望 ${expectedTag} 不一致`)
    }
  }

  if (artifactsDir) {
    const expectedPrefix = `Teahouse-${version}-`
    for (const path of collectFiles(resolve(artifactsDir))) {
      const name = basename(path)
      if (name.startsWith('Teahouse-') && !name.startsWith(expectedPrefix)) {
        errors.push(`产物文件名 ${name} 未使用版本前缀 ${expectedPrefix}`)
      }
    }
  }

  return { version, errors }
}

const releasePackages = {
  'debian10-uos20-x64': ['linux-amd64.deb', 'linux-x86_64.AppImage'],
  'debian10-uos20-arm64': ['linux-arm64.deb', 'linux-arm64.AppImage'],
  'win7-x64': ['win-x64-setup.exe', 'win-x64-portable.exe'],
  'win7-ia32': ['win-ia32-setup.exe', 'win-ia32-portable.exe'],
  'mac-arm64': ['mac-arm64.dmg', 'mac-arm64.zip']
}

export async function checkReleaseArtifacts(directory, version) {
  const files = new Map()
  const errors = []
  for (const path of collectFiles(resolve(directory))) {
    const name = basename(path)
    if (files.has(name)) errors.push(`重复的发布文件：${name}`)
    files.set(name, path)
  }
  for (const [platform, suffixes] of Object.entries(releasePackages)) {
    const manifest = `SHA256SUMS-${platform}.txt`
    const manifestPath = files.get(manifest)
    files.delete(manifest)
    if (!manifestPath) errors.push(`缺少校验清单：${manifest}`)
    const actual = []
    for (const suffix of suffixes) {
      const name = `Teahouse-${version}-${suffix}`
      const path = files.get(name)
      files.delete(name)
      if (!path) {
        errors.push(`缺少安装包：${name}`)
        continue
      }
      if (statSync(path).size === 0) errors.push(`安装包为空：${name}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      actual.push(`${hash.digest('hex')}  ${name}`)
    }
    if (manifestPath) {
      const expected = readFileSync(manifestPath, 'utf8').trimEnd().split(/\r?\n/).sort()
      if (expected.join('\n') !== actual.sort().join('\n')) errors.push(`SHA-256 清单与安装包不符：${manifest}`)
    }
  }
  for (const name of files.keys()) errors.push(`未列入发布的文件：${name}`)
  return errors
}

function parseArtifactsArg(argv) {
  const index = argv.indexOf('--artifacts')
  if (index < 0) return undefined
  const dir = argv[index + 1]
  if (!dir) throw new Error('--artifacts 缺少目录参数')
  return dir
}

async function main() {
  const artifactsDir = parseArtifactsArg(process.argv.slice(2))
  const result = checkVersionConsistency({ artifactsDir })
  if (artifactsDir && !result.errors.length) {
    result.errors.push(...await checkReleaseArtifacts(artifactsDir, result.version))
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[version] ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`[version] ${result.version} 一致性检查通过`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
