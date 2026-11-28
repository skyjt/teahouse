import { networkInterfaces } from 'node:os'

export interface LocalIpv4Interface {
  /** 系统网卡名（如 eth0 / WLAN） */
  name: string
  address: string
  netmask: string
  mac: string
  internal: boolean
  broadcast: string
}

function familyIsV4(family: string | number): boolean {
  return family === 'IPv4' || family === 4
}

function broadcastOf(address: string, netmask: string): string {
  const ip = address.split('.').map(Number)
  const mask = netmask.split('.').map(Number)
  if (ip.length !== 4 || mask.length !== 4 || ip.some((n) => !Number.isInteger(n)) || mask.some((n) => !Number.isInteger(n))) {
    return '255.255.255.255'
  }
  return ip.map((octet, i) => (octet & mask[i]) | (~mask[i] & 0xff)).join('.')
}

/** 枚举本机 IPv4 网卡（含回环，设置页可过滤）。 */
export function listLocalIpv4Interfaces(): LocalIpv4Interface[] {
  const result: LocalIpv4Interface[] = []
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    for (const addr of list ?? []) {
      if (!familyIsV4(addr.family)) continue
      result.push({
        name,
        address: addr.address,
        netmask: addr.netmask,
        mac: addr.mac || '',
        internal: addr.internal,
        broadcast: broadcastOf(addr.address, addr.netmask)
      })
    }
  }
  return result
}

/** 非回环 IPv4，用于展示与默认选择。 */
export function listExternalIpv4Interfaces(): LocalIpv4Interface[] {
  return listLocalIpv4Interfaces().filter((item) => !item.internal)
}

/**
 * 解析当前应使用的本机 IPv4：
 * - preferred 仍存在于网卡列表时优先；
 * - 否则回退第一块非回环网卡；
 * - 再没有则 127.0.0.1。
 */
export function resolveLocalIpv4(preferred = ''): string {
  const external = listExternalIpv4Interfaces()
  if (preferred && external.some((item) => item.address === preferred)) return preferred
  return external[0]?.address ?? '127.0.0.1'
}

export function macForIpv4(address: string): string {
  return listLocalIpv4Interfaces().find((item) => item.address === address)?.mac ?? ''
}

/** 定向广播目标：选定网卡时只广播该子网 + 受限广播；未选定则枚举全部。 */
export function computeBroadcastTargets(preferred = ''): string[] {
  const targets = new Set<string>(['255.255.255.255'])
  const external = listExternalIpv4Interfaces()
  const selected = preferred ? external.filter((item) => item.address === preferred) : external
  const list = selected.length > 0 ? selected : external
  for (const item of list) targets.add(item.broadcast)
  return [...targets]
}

/** TCP/UDP 绑定地址：有可用首选 IP 时绑定该地址，否则不限制（undefined = 全接口）。 */
export function resolveBindAddress(preferred = ''): string | undefined {
  const ip = resolveLocalIpv4(preferred)
  if (ip === '127.0.0.1') return undefined
  if (preferred && ip === preferred) return preferred
  return undefined
}