import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUpRight, ChevronDown, CircleHelp, Inbox, LoaderCircle, Pin, Search, SlidersHorizontal, VolumeX, X } from 'lucide-react'
import type { Account, Conversation, ConversationPatch, Message, Mode, Platform } from '../lib/types'
import { accountKey, cn, conversationKey, formatTime, platformName } from '../lib/utils'
import { Avatar, Brand, PlatformBadge } from './identity'
import { Button, IconButton, Menu, MenuItem } from './ui'
import { ConversationActions } from './conversation-actions'

export function ConversationList({ conversations, accounts, activeKey, platform, accountFilter, search, searchResults, searchLoading, searchError, loading, error, mode, hasMore, hasMoreSearch, loadingMore, operations, onConversationChange, onPlatform, onAccountFilter, onSearch, onSelect, onSearchSelect, onManageAccounts, onLoadMore, onLoadMoreSearch, onRetry }: {
  conversations: Conversation[]; accounts: Account[]; activeKey?: string; platform: Platform | 'all'; accountFilter: string; search: string; searchResults: Message[]; searchLoading: boolean; searchError?: string; loading: boolean; error?: string; mode: Mode; hasMore: boolean; hasMoreSearch: boolean; loadingMore: boolean
  onPlatform: (platform: Platform | 'all') => void; onAccountFilter: (id: string) => void; onSearch: (value: string) => void; onSelect: (conversation: Conversation) => void; onSearchSelect: (message: Message) => void; onManageAccounts: () => void; onLoadMore: () => void; onLoadMoreSearch: () => void; onRetry: () => void
  operations: Record<string, boolean>; onConversationChange: (conversation: Conversation, patch: ConversationPatch) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: conversations.length, getScrollElement: () => scrollRef.current, estimateSize: () => 94, overscan: 6, getItemKey: index => conversationKey(conversations[index]) })
  const selectedAccount = accounts.find(account => accountKey(account) === accountFilter)
  const matchingConversations = search.trim() ? conversations.filter(conversation => conversation.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : []
  return <aside className="conversation-panel" aria-label="会话列表">
    <div className="sidebar-brand"><Brand /><span className="workspace-label">你的消息空间</span></div>
    <div className="sidebar-heading"><h1>{search.trim() ? '搜索历史' : '消息'}</h1><div className="sidebar-heading-actions"><span className="conversation-count">{conversations.length || '—'}</span><IconButton label="管理账号" onClick={onManageAccounts}><SlidersHorizontal size={19} /></IconButton></div></div>
    <div className="search-field"><Search size={17} /><input id="workspace-search" type="search" placeholder="搜索联系人和已同步消息" aria-label="搜索联系人和已同步消息" value={search} onChange={event => onSearch(event.target.value)} autoComplete="off" />{search && <button type="button" onClick={() => onSearch('')} aria-label="清除搜索"><X size={15} /></button>}<kbd>/</kbd></div>
    <div className="platform-tabs" aria-label="按平台筛选">{(['all', 'wechat', 'qq'] as const).map(value => <button key={value} type="button" onClick={() => onPlatform(value)} className={cn(platform === value && 'is-active')} aria-pressed={platform === value}>{value === 'all' ? '全部消息' : <><span className={`tiny-dot dot-${value}`} />{platformName(value)}</>}</button>)}</div>
    <div className="sidebar-list-label"><span>{search.trim() ? '本地已同步历史' : '最近会话'}</span><Menu label="筛选账号" trigger={<span className="account-filter-label">{selectedAccount ? selectedAccount.displayName : '全部账号'}<ChevronDown size={12} /></span>}><MenuItem onSelect={() => onAccountFilter('')}>全部账号</MenuItem>{accounts.map(account => <MenuItem key={accountKey(account)} onSelect={() => onAccountFilter(accountKey(account))}><PlatformBadge platform={account.platform} />{account.displayName}</MenuItem>)}</Menu></div>
    <div className="conversation-scroll" ref={scrollRef}>
      {search.trim() ? <div className="search-results">
        {matchingConversations.length > 0 && <><p className="search-section-label">匹配的会话</p>{matchingConversations.map(conversation => <button type="button" className="search-conversation-result" key={conversationKey(conversation)} onClick={() => onSelect(conversation)}><Avatar name={conversation.title} group={conversation.kind === 'group'} platform={conversation.platform} size="small" /><span><strong>{conversation.title}</strong><small>{accounts.find(account => account.id === conversation.accountId && account.platform === conversation.platform)?.displayName || platformName(conversation.platform)}</small></span><ArrowUpRight size={14} /></button>)}</>}
        <p className="search-section-label">消息内容 · 仅已同步历史</p>
        {searchLoading && <div className="list-state"><LoaderCircle size={21} className="spinning" /><p>正在搜索已同步历史…</p></div>}
        {searchError && <div className="list-state"><CircleHelp size={23} /><p>{searchError}</p></div>}
        {!searchLoading && !searchError && !searchResults.length && <div className="list-state"><Search size={26} /><strong>还没有找到</strong><p>试试其他关键词。这里只搜索 SnSBox 已同步的消息。</p></div>}
        {searchResults.map(message => {
          const conversation = conversations.find(item => item.id === message.conversationId && item.accountId === message.accountId && item.platform === message.platform)
          const account = accounts.find(item => item.id === message.accountId && item.platform === message.platform)
          return <button type="button" className="search-result" key={JSON.stringify([message.platform, message.accountId, message.conversationId, message.id])} onClick={() => onSearchSelect(message)}><div><PlatformBadge platform={message.platform} /><strong>{conversation?.title || message.senderName || '会话'}</strong><ArrowUpRight size={14} /></div><p>{message.segments.map(segment => segment.type === 'text' ? segment.text : `[${segment.type}]`).join(' ')}</p><small>{account?.displayName || platformName(message.platform)} · {message.senderName || '发送者未知'} · {formatTime(message.timestamp)}</small></button>
        })}
        {hasMoreSearch && <Button className="load-more-list" variant="ghost" onClick={onLoadMoreSearch} disabled={loadingMore}><ArrowDown size={15} />更多搜索结果</Button>}
      </div> : <>
        {loading && <div className="conversation-skeletons">{Array.from({ length: 5 }, (_, i) => <div className="conversation-skeleton" key={i}><span /><div><i /><i /></div></div>)}</div>}
        {error && <div className="list-state"><CircleHelp size={26} /><strong>会话暂时不可用</strong><p>{error}</p><Button variant="secondary" size="sm" onClick={onRetry}>重新加载</Button></div>}
        {!loading && !error && !conversations.length && <div className="list-state"><Inbox size={29} strokeWidth={1.4} /><strong>{accounts.some(account => account.status === 'online') ? '这里还很安静' : '等待你的第一个会话'}</strong><p>{accounts.some(account => account.status === 'online') ? '拉取已同步历史后，会话会出现在这里。' : '连接微信或 QQ 后，在一处继续你的对话。'}</p><Button variant="secondary" size="sm" onClick={onManageAccounts}>管理账号</Button></div>}
        <div className="virtual-conversations" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map(row => {
          const conversation = conversations[row.index]
          const account = accounts.find(item => item.id === conversation.accountId && item.platform === conversation.platform)
          return <div key={row.key} className="conversation-row" data-conversation-key={conversationKey(conversation)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: row.size, transform: `translateY(${row.start}px)` }}>
            <button type="button" className={cn('conversation-item', activeKey === conversationKey(conversation) && 'is-active')} onClick={() => onSelect(conversation)} aria-current={activeKey === conversationKey(conversation) ? 'true' : undefined}>
              <Avatar name={conversation.title} group={conversation.kind === 'group'} url={conversation.avatarUrl} platform={conversation.platform} />
              <span className="conversation-content"><span className="conversation-line"><strong>{conversation.title}</strong><time>{formatTime(conversation.lastMessageAt)}</time></span><span className="conversation-preview"><span>{conversation.lastMessage || '还没有消息'}</span>{conversation.unreadCount > 0 && <span className={cn('unread-badge', conversation.muted && 'unread-muted')}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span>}</span><span className="conversation-account">{account?.displayName || platformName(conversation.platform)}{conversation.pinned && <span className="conversation-flag" role="img" aria-label="已在 SnSBox 置顶"><Pin size={11} /></span>}{conversation.muted && <span className="conversation-flag" role="img" aria-label="SnSBox 本地免打扰"><VolumeX size={12} /></span>}</span></span>
            </button>
            <div className="conversation-row-actions"><ConversationActions conversation={conversation} busy={operations[conversationKey(conversation)]} onChange={patch => onConversationChange(conversation, patch)} /></div>
          </div>
        })}</div>
        {hasMore && <Button variant="ghost" className="load-more-list" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? <LoaderCircle size={15} className="spinning" /> : <ArrowDown size={15} />}加载更多会话</Button>}
      </>}
    </div>
    <div className="sidebar-footer"><span className="sidebar-footer-dot" /><span>{mode === 'demo' ? '界面演示 · 所有内容均为合成' : '独立账号，从容交流'}</span><span className="sidebar-footer-decoration">✳</span></div>
  </aside>
}
