import type { Account, AccountOperation, CompatibilityReport, Conversation, ConversationPatch, LoginChallenge, LoginOptions, Message, Page, Segment, Session, SystemInfo } from './types'

const prefix = '/api/v1'
let csrfToken: string | undefined
let unauthorizedHandler: (() => void) | undefined
export const onUnauthorized = (handler: () => void) => { unauthorizedHandler = handler; return () => { unauthorizedHandler = undefined } }

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); this.name = 'ApiError' }
}

async function request<T>(path: string, init: RequestInit = {}, timeout = 25_000): Promise<T> {
  const method = init.method ?? 'GET'
  const headers = new Headers(init.headers)
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers.set('X-CSRF-Token', csrfToken)
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`${prefix}${path}`, { ...init, headers, credentials: 'same-origin', signal: controller.signal, cache: 'no-store' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      if (response.status === 401 && path !== '/session') unauthorizedHandler?.()
      throw new ApiError(body?.error?.message || `请求未完成（${response.status}）`, response.status, body?.error?.code || 'http_error')
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (controller.signal.aborted) throw new ApiError('请求超时。发送结果可能尚未确认，请先核对历史。', 0, 'timeout')
    throw new ApiError('暂时无法连接 SnSBox，请检查服务后重试。', 0, 'network')
  } finally { window.clearTimeout(timer) }
}
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const params = (values: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  return search.size ? `?${search}` : ''
}

export const api = {
  async session() {
    try { const session = await request<Session>('/session'); csrfToken = session.csrfToken; return session }
    catch (error) { if (error instanceof ApiError && error.status === 401) { csrfToken = undefined; return null } throw error }
  },
  async login(password: string) { const session = await request<Session>('/session', json({ password })); csrfToken = session.csrfToken; return session },
  async logout() { await request<void>('/session', { method: 'DELETE' }); csrfToken = undefined },
  clearSession() { csrfToken = undefined },
  accounts: () => request<Page<Account>>('/accounts'),
  conversations: (accountId?: string, cursor?: string | null) => request<Page<Conversation>>(`/conversations${params({ accountId, cursor, limit: 50 })}`),
  updateConversation: (conversationId: string, patch: ConversationPatch) => request<Conversation>(`/conversations/${encodeURIComponent(conversationId)}`, json(patch, 'PATCH')),
  messages: (conversationId: string, cursor?: string | null) => request<Page<Message>>(`/conversations/${encodeURIComponent(conversationId)}/messages${params({ cursor, limit: 50 })}`),
  search: (query: string, accountId?: string, cursor?: string | null) => request<Page<Message>>(`/messages${params({ query, accountId, cursor, limit: 50 })}`),
  read: (conversationId: string) => request<void>(`/conversations/${encodeURIComponent(conversationId)}/read`, json({})),
  send: (conversationId: string, segments: Segment[], key: string) => request<Message>(`/conversations/${encodeURIComponent(conversationId)}/messages`, { ...json({ segments }), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } }),
  upload: (accountId: string, file: File) => request<{ id: string; url: string; name: string; mimeType: string; size: number }>(`/media${params({ accountId, name: file.name })}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }, 60_000),
  loginAccount: (accountId: string, options: LoginOptions, key: string) => request<LoginChallenge>(`/accounts/${encodeURIComponent(accountId)}/login`, { ...json(options), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } }),
  logoutAccount: (accountId: string, key: string) => request<LoginChallenge>(`/accounts/${encodeURIComponent(accountId)}/logout`, { ...json({}), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } }),
  provision: (accountId: string) => request<{ created: boolean; accountId: string; message: string }>(`/accounts/${encodeURIComponent(accountId)}/provision`, json({ confirmIsolated: true })),
  operation: (accountId: string, operationId: string) => request<AccountOperation>(`/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(operationId)}`),
  cancelOperation: (accountId: string, operationId: string) => request<unknown>(`/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(operationId)}/cancel`, json({})),
  compatibility: () => request<CompatibilityReport>('/system/compatibility'),
  sync: (accountId: string) => request<{ synced: boolean; message: string }>(`/accounts/${encodeURIComponent(accountId)}/sync`, json({}), 60_000),
  system: () => request<SystemInfo>('/system'),
  events: (after?: string) => new EventSource(`${prefix}/events${params({ after })}`, { withCredentials: true }),
}
