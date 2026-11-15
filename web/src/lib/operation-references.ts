import type { Platform } from './types'

export interface OperationReference { accountId: string; platform: Platform; operationId: string }
const storageKey = 'snsbox.operationReferences'

// Only opaque, authorization-checked task references survive a reload in this tab.
// No QR data, credentials, task messages, contacts, or message bodies are stored.
export function loadOperationReferences(): OperationReference[] {
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw || raw.length > 65_536) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 32).filter((item): item is OperationReference => !!item && typeof item === 'object' && ['wechat', 'qq'].includes(item.platform) && typeof item.accountId === 'string' && item.accountId.length > 0 && item.accountId.length <= 512 && typeof item.operationId === 'string' && item.operationId.length > 0 && item.operationId.length <= 512).map(({ accountId, platform, operationId }) => ({ accountId, platform, operationId }))
  } catch { return [] }
}
export function saveOperationReferences(references: OperationReference[]) {
  try { if (references.length) sessionStorage.setItem(storageKey, JSON.stringify(references.slice(-32))); else sessionStorage.removeItem(storageKey) } catch { /* Restricted storage only disables reload recovery. */ }
}
