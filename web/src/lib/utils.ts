import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Account, Capabilities, CapabilityName, Conversation, Platform } from './types'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
export const platformName = (platform: Platform) => platform === 'wechat' ? '微信' : 'QQ'
export const conversationKey = (conversation: Pick<Conversation, 'platform' | 'accountId' | 'id'>) =>
  JSON.stringify([conversation.platform, conversation.accountId, conversation.id])
export const accountKey = (account: Pick<Account, 'platform' | 'id'>) => JSON.stringify([account.platform, account.id])
export const uniqueId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
export const initials = (name: string) => [...name.replace(/\s|·.*$/g, '')].slice(-2).join('') || '聊'

export function capability(account: Account | undefined, conversation: Conversation | undefined, name: CapabilityName) {
  return conversation?.capabilities?.[name] ?? account?.capabilities[name] ?? { status: 'unverified' as const }
}
export const capabilityLabel = (state: string) => ({ supported: '支持', unsupported: '不支持', unverified: '待验证', unavailable: '暂不可用' })[state] ?? '待验证'
export function capabilityReason(capabilities: Capabilities, name: CapabilityName) {
  const value = capabilities[name]
  return value?.reason || `${capabilityLabel(value?.status ?? 'unverified')}`
}

export function safeExternalUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

// Real media is served by the authenticated same-origin API. External cards never load remote images.
export function safeMediaUrl(value?: string): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin) return undefined
    return url.pathname.startsWith('/api/v1/media/') || url.pathname.startsWith('/demo/') ? url.href : undefined
  } catch { return undefined }
}

export function formatTime(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
export function formatDay(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知'
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return '今天'
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(date)
}
export function formatBytes(size?: number) {
  if (size == null) return ''
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function readPreference(key: string, fallback: string) {
  try { return localStorage.getItem(`snsbox.${key}`) || fallback } catch { return fallback }
}
export function writePreference(key: string, value: string) {
  try { localStorage.setItem(`snsbox.${key}`, value) } catch { /* Preferences are optional in private browsing. */ }
}
