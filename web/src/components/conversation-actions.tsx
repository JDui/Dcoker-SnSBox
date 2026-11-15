import { Mail, MailOpen, MoreHorizontal, Pin, PinOff, Volume2, VolumeX } from 'lucide-react'
import type { Conversation, ConversationPatch } from '../lib/types'
import { platformName } from '../lib/utils'
import { Menu, MenuItem } from './ui'

export function ConversationActions({ conversation, busy = false, onChange }: { conversation: Conversation; busy?: boolean; onChange: (patch: ConversationPatch) => void }) {
  const unread = conversation.unread ?? conversation.unreadCount > 0
  return <Menu label={`会话操作：${platformName(conversation.platform)} · ${conversation.title}`} trigger={<MoreHorizontal size={19} />}>
    <div className="menu-caption">SnSBox 本地状态，不同步平台</div>
    <MenuItem disabled={busy} onSelect={() => onChange({ pinned: !conversation.pinned })}>{conversation.pinned ? <PinOff size={16} /> : <Pin size={16} />}{conversation.pinned ? '取消置顶' : '置顶会话'}</MenuItem>
    <MenuItem disabled={busy} onSelect={() => onChange({ muted: !conversation.muted })}>{conversation.muted ? <Volume2 size={16} /> : <VolumeX size={16} />}{conversation.muted ? '取消免打扰' : '本地免打扰'}</MenuItem>
    <MenuItem disabled={busy} onSelect={() => onChange({ unread: !unread })}>{unread ? <MailOpen size={16} /> : <Mail size={16} />}{unread ? '标为已读' : '标为未读'}</MenuItem>
  </Menu>
}
