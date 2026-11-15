export type Platform = 'wechat' | 'qq'
export type CapabilityState = 'supported' | 'unsupported' | 'unverified' | 'unavailable'
export type CapabilityName =
  | 'login' | 'logout' | 'text' | 'image' | 'video' | 'sticker'
  | 'file' | 'miniApp' | 'history' | 'realtime' | 'mail'

export interface Capability {
  status: CapabilityState
  reason?: string
}
export type Capabilities = Partial<Record<CapabilityName, Capability>>

export interface Account {
  id: string
  platform: Platform
  displayName: string
  status: 'online' | 'offline' | 'login_required' | 'connecting' | 'error' | 'unconfigured'
  statusMessage?: string
  avatarUrl?: string
  capabilities: Capabilities
  historyScope?: string
  mailUrl?: string
  adapter?: string
  upstreamConfigured?: boolean
}

export interface Conversation {
  id: string
  accountId: string
  platform: Platform
  title: string
  kind: 'direct' | 'group'
  avatarUrl?: string
  lastMessage?: string
  lastMessageAt?: string
  unreadCount: number
  unread?: boolean
  muted?: boolean
  pinned?: boolean
  memberCount?: number
  capabilities?: Capabilities
}
export interface ConversationPatch { pinned?: boolean; muted?: boolean; unread?: boolean }

export interface Media {
  url?: string
  thumbnailUrl?: string
  filename?: string
  mediaId?: string
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  state?: 'available' | 'pending' | 'expired' | 'failed' | 'unsupported'
  unavailableReason?: string
}

export type Segment =
  | { type: 'text'; text: string }
  | ({ type: 'image' | 'video' | 'sticker' | 'file' | 'audio' } & Media)
  | { type: 'link' | 'miniApp'; title?: string; text?: string; description?: string; url?: string; appName?: string; thumbnailUrl?: string }
  | { type: 'quote'; sender: string; text: string }
  | { type: 'mention'; text: string }
  | { type: 'unsupported'; label: string }
  | { type: 'unknown'; text: string }

export type DeliveryState = 'queued' | 'submitting' | 'accepted' | 'failed' | 'uncertain' | 'received' | 'demo'

export interface Message {
  id: string
  conversationId: string
  accountId: string
  platform: Platform
  direction: 'incoming' | 'outgoing' | null
  senderName: string | null
  senderId?: string
  avatarUrl?: string
  timestamp?: string | null
  segments: Segment[]
  status: DeliveryState
  error?: string
  commandId?: string
}

export interface Page<T> { items: T[]; nextCursor?: string | null }
export interface LoginChallenge { state: 'pending' | 'blocked' | 'accepted'; message?: string; qrCode?: string; loginUrl?: string }
export interface Session { authenticated: boolean; csrfToken: string }
export interface SystemInfo { version: string; dataPolicy: string; legacyConfig?: { configured: boolean; readOnly: boolean; message?: string; entries: { path: string; present: boolean; purpose: string }[] } }
export interface DraftAttachment { id: string; file: File; preview?: string; kind: 'image' | 'video' | 'file' | 'sticker' }
export interface Draft { text: string; attachments: DraftAttachment[] }
export type Mode = 'live' | 'demo'
