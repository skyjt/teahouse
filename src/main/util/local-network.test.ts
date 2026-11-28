import { describe, expect, it } from 'vitest'
import {
  computeBroadcastTargets,
  resolveBindAddress,
  resolveLocalIpv4
} from './local-network'

describe('local-network', () => {
  it('无首选时仍返回受限广播地址', () => {
    const targets = computeBroadcastTargets('')
    expect(targets).toContain('255.255.255.255')
  })

  it('解析本机 IPv4 始终返回非空字符串', () => {
    expect(resolveLocalIpv4('')).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })

  it('不存在的首选 IP 不会作为绑定地址', () => {
    expect(resolveBindAddress('203.0.113.9')).toBeUndefined()
  })
})