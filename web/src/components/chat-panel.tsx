import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, CircleHelp, Info, LoaderCircle, MessageCircle, Search, ShieldCheck } from 'lucide-react'
import type { Account, Conversation, ConversationPatch, Draft, DraftAttachment, Message, Mode } from '../lib/types'
import { cn, formatDay, platformName } from '../lib/utils'
import { Avatar, PlatformBadge } from './identity'
import { Button, IconButton } from './ui'
import { MessageBubble } from './message-content'
import { Composer } from './composer'
import { ConversationActions } from './conversation-actions'

export function Welcome({ mode, onAccounts, onDemo, accounts, streamState }: { mode: Mode; onAccounts: () => void; onDemo: () => void; accounts: Account[]; streamState: string }) {
  const online = accounts.filter(account => account.status === 'online').length
  return <main className="welcome-panel">
    <div className="welcome-top"><span><span className={`status-dot ${streamState === 'connected' ? 'is-online' : ''}`} />{mode === 'demo' ? '界面演示' : streamState === 'connected' ? '事件连接正常' : '消息概览'}</span><span>SnSBox</span></div>
    <div className="welcome-content"><span className="welcome-message-icon" aria-hidden="true"><MessageCircle size={32} strokeWidth={1.5} /></span><h2>选择会话</h2><p>从会话列表查看消息，或连接平台账号。<br />这里只显示 SnSBox 已同步的历史。</p><div className="welcome-actions"><Button onClick={onAccounts}>{online ? '查看账号' : '连接账号'}<ChevronRight size={16} /></Button>{mode !== 'demo' && <Button variant="ghost" onClick={onDemo}>查看界面演示</Button>}</div><div className="welcome-note"><ShieldCheck size={14} />{mode === 'demo' ? '合成内容，不代表真实账号接入' : online ? `${online} 个账号在线 · 历史以已同步范围为准` : '尚未接入，连接账号后可同步消息'}</div></div>
  </main>
}

export function ChatPanel({ positionTarget, contextHasNewer = false, onViewLatest, readOnly = false, historyScope, conversationBusy, onConversationChange, account, conversation, messages, localIds, draft, mode, busy, blocked, loading, error, hasMore, loadingMore, enterSends, onBack, onInfo, onSearch, onLoadOlder, onRetry, onDraftChange, onSend, onFile, onRemoveFile, onEnterSendsChange, onCheck, onDismiss }: {
  positionTarget?: { messageId: string; requestId: number }; contextHasNewer?: boolean; onViewLatest?: () => void
  readOnly?: boolean; historyScope?: string; conversationBusy: boolean; onConversationChange: (patch: ConversationPatch) => void; account: Account; conversation: Conversation; messages: Message[]; localIds: Set<string>; draft: Draft; mode: Mode; busy: boolean; blocked: boolean; loading: boolean; error?: string; hasMore: boolean; loadingMore: boolean; enterSends: boolean
  onBack: () => void; onInfo: () => void; onSearch: () => void; onLoadOlder: () => Promise<boolean>; onRetry: () => void; onDraftChange: (value: string) => void; onSend: () => void; onFile: (file: File, kind: DraftAttachment['kind']) => void; onRemoveFile: (id: string) => void; onEnterSendsChange: (value: boolean) => void; onCheck: () => void; onDismiss: (id: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const initial = useRef(true)
  const prepending = useRef(false)
  const anchor = useRef<{ height: number; top: number; count: number; messageId?: string; offset?: number } | null>(null)
  const [showBottom, setShowBottom] = useState(false)
  const [positionAttempt, setPositionAttempt] = useState(0)
  const positionToken = positionTarget ? `${positionTarget.messageId}:${positionTarget.requestId}:${positionAttempt}` : ''
  const positioned = useRef('')
  const [positionState, setPositionState] = useState<{ token: string; status: 'located' | 'paused' }>()
  const virtualizer = useVirtualizer({ count: messages.length, getScrollElement: () => scrollRef.current, estimateSize: () => 130, overscan: 6, getItemKey: index => messages[index].id, paddingEnd: 20, scrollPaddingStart: positionTarget ? 48 : 0 })
  const bottom = () => { virtualizer.scrollToIndex(Math.max(0, messages.length - 1), { align: 'end' }); nearBottom.current = true; setShowBottom(false) }
  const alignMessage = (messageId: string, offset: number, complete: (status: 'located' | 'paused', row?: HTMLElement) => void) => {
    const scroller = scrollRef.current
    const index = messages.findIndex(message => message.id === messageId)
    if (!scroller || index < 0) { complete('paused'); return () => {} }
    let stopped = false, frame = 0, attempts = 0, settled = 0
    const cleanup = () => {
      stopped = true; cancelAnimationFrame(frame)
      scroller.removeEventListener('wheel', interrupt); scroller.removeEventListener('touchstart', interrupt); scroller.removeEventListener('pointerdown', interrupt)
    }
    const finish = (status: 'located' | 'paused', row?: HTMLElement) => { cleanup(); complete(status, row) }
    const interrupt = () => { if (!stopped) finish('paused') }
    const align = () => {
      if (stopped) return
      const row = Array.from(scroller.querySelectorAll<HTMLElement>('[data-position-id]')).find(element => element.dataset.positionId === messageId)
      if (row) {
        const bounds = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect()
        const desired = Math.max(0, Math.min(scroller.scrollTop + rect.top - bounds.top - offset, scroller.scrollHeight - scroller.clientHeight))
        if (Math.abs(desired - scroller.scrollTop) > 2) { virtualizer.scrollToOffset(desired); settled = 0 }
        else if (rect.bottom > bounds.top + 34 && rect.top < bounds.bottom - 20 && ++settled >= 2) { finish('located', row); return }
      }
      if (++attempts >= 30) { finish('paused'); return }
      frame = requestAnimationFrame(align)
    }
    virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' })
    frame = requestAnimationFrame(align)
    scroller.addEventListener('wheel', interrupt, { passive: true })
    scroller.addEventListener('touchstart', interrupt, { passive: true })
    scroller.addEventListener('pointerdown', interrupt)
    return cleanup
  }
  useLayoutEffect(() => {
    if (!messages.length) return
    if (anchor.current && messages.length > anchor.current.count && scrollRef.current) {
      const saved = anchor.current
      anchor.current = null
      if (saved.messageId && saved.offset != null) return alignMessage(saved.messageId, saved.offset, () => { prepending.current = false })
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight - saved.height + saved.top
      prepending.current = false
    } else if (!positionTarget && (initial.current || nearBottom.current) && !prepending.current) {
      const frame = requestAnimationFrame(() => { virtualizer.scrollToIndex(messages.length - 1, { align: 'end' }); initial.current = false })
      return () => cancelAnimationFrame(frame)
    }
  }, [messages.length, virtualizer, positionToken])
  useLayoutEffect(() => {
    if (!positionTarget || positioned.current === positionToken || loading || error) return
    if (!messages.some(message => message.id === positionTarget.messageId)) return
    initial.current = false
    nearBottom.current = false
    return alignMessage(positionTarget.messageId, 48, (status, row) => {
      positioned.current = positionToken
      setPositionState({ token: positionToken, status })
      if (status === 'located') row?.focus({ preventScroll: true })
    })
  }, [positionToken, loading, error, messages.length, virtualizer])
  useEffect(() => {
    const viewport = window.visualViewport
    const onResize = () => { if (nearBottom.current) requestAnimationFrame(bottom) }
    viewport?.addEventListener('resize', onResize)
    return () => viewport?.removeEventListener('resize', onResize)
  })
  const loadOlder = async () => {
    if (!scrollRef.current) return
    const scroller = scrollRef.current, bounds = scroller.getBoundingClientRect()
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-position-id]'))
    const visible = rows.filter(row => { const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top + 34 && rect.top < bounds.bottom })
    const reference = visible.find(row => row.getBoundingClientRect().top >= bounds.top + 34) || visible[0]
    anchor.current = { height: scroller.scrollHeight, top: scroller.scrollTop, count: messages.length, messageId: reference?.dataset.positionId, offset: reference ? reference.getBoundingClientRect().top - bounds.top : undefined }
    prepending.current = true
    nearBottom.current = false
    try { const added = await onLoadOlder(); if (!added) { anchor.current = null; prepending.current = false } }
    catch { anchor.current = null; prepending.current = false }
  }
  const located = positionState?.token === positionToken && positionState.status === 'located'
  const paused = positionState?.token === positionToken && positionState.status === 'paused'
  return <main className={cn('chat-panel', positionTarget && 'has-message-position')} aria-label={`与${conversation.title}的会话`}>
    <header className="chat-header"><IconButton label="返回会话列表" className="mobile-back" onClick={onBack}><ArrowLeft size={21} /></IconButton><Avatar name={conversation.title} group={conversation.kind === 'group'} url={conversation.avatarUrl} platform={conversation.platform} /><div className="chat-heading"><h2>{conversation.title}{conversation.kind === 'group' && conversation.memberCount && <span>{conversation.memberCount}</span>}</h2><div><PlatformBadge platform={conversation.platform} /><span>{account.displayName}</span><span className="identity-divider">·</span><span className="account-status-text"><span className={cn('status-dot', account.status === 'online' && 'is-online')} />{readOnly ? '只读历史' : account.status === 'online' ? mode === 'demo' ? '演示账号' : '账号在线' : '账号未在线'}</span></div></div><div className="chat-header-actions">{!readOnly && <ConversationActions conversation={conversation} busy={conversationBusy} onChange={onConversationChange} />}<IconButton label={readOnly ? '搜索当前历史来源' : '搜索已同步历史'} onClick={onSearch}><Search size={20} /></IconButton><IconButton label="会话信息与能力" onClick={onInfo}><Info size={20} /></IconButton></div></header>
    <div className="history-scope"><ShieldCheck size={13} /><span>{historyScope || (mode === 'demo' ? '界面演示 · 合成内容' : '仅展示 SnSBox 已同步历史，不保证全设备完整记录')}</span><button type="button" onClick={onInfo}>查看范围<ChevronRight size={12} /></button></div>
    {positionTarget && <div className="message-position-bar"><span role="status">{loading ? '正在加载搜索结果…' : error ? '无法定位搜索结果' : located ? '已定位搜索结果' : paused ? '自动定位已停止' : '正在定位搜索结果…'}</span><div>{paused && <Button variant="ghost" size="sm" onClick={() => setPositionAttempt(value => value + 1)}>重新定位</Button>}<Button variant="ghost" size="sm" onClick={onViewLatest}>{contextHasNewer ? '查看最新记录' : '退出定位'}</Button></div></div>}
    <div className="message-scroll" ref={scrollRef} role="log" aria-label="消息记录" aria-live="off" onScroll={() => { const element = scrollRef.current; if (!element) return; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; setShowBottom(!nearBottom.current) }}>
      <div className="history-load">{hasMore ? <Button variant="ghost" size="sm" disabled={loadingMore} onClick={loadOlder}>{loadingMore ? <LoaderCircle size={14} className="spinning" /> : <ArrowUp size={14} />}{loadingMore ? '加载更早消息…' : '加载更早消息'}</Button> : messages.length ? <span>{mode === 'demo' ? '演示记录从这里开始' : readOnly ? '已到当前索引的起点' : '已到当前同步历史的起点'}</span> : null}</div>
      {loading && <div className="chat-list-state"><LoaderCircle size={25} className="spinning" /><p>正在读取历史…</p></div>}
      {error && <div className="chat-list-state"><CircleHelp size={26} /><p>{error}</p><Button variant="secondary" size="sm" onClick={onRetry}>重新加载</Button></div>}
      {!loading && !error && !messages.length && <div className="chat-list-state"><MessageCircle size={30} strokeWidth={1.3} /><strong>{readOnly ? '当前索引暂无消息' : '暂无已同步消息'}</strong><p>{readOnly ? '可返回来源列表，检查副本范围并重新读取。' : '可在账号管理中同步历史。'}</p></div>}
      <div className="virtual-messages" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualizer.getVirtualItems().map(row => {
        const message = messages[row.index]
        const day = formatDay(message.timestamp)
        const showDay = !row.index || day !== formatDay(messages[row.index - 1].timestamp)
        const isTarget = positionTarget?.messageId === message.id
        return <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} data-position-id={message.id} role={isTarget ? 'group' : undefined} aria-label={isTarget ? '搜索命中的消息' : undefined} tabIndex={isTarget ? -1 : undefined} className={cn('virtual-message-row', isTarget && 'is-search-hit')} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}>{showDay && <div className="day-separator"><span>{day}</span></div>}<MessageBubble message={message} group={conversation.kind === 'group'} local={localIds.has(message.id)} onCheck={onCheck} onDismiss={() => onDismiss(message.id)} /></div>
      })}</div>
    </div>
    {showBottom && <Button className="scroll-to-bottom" variant="secondary" size="sm" onClick={positionTarget && contextHasNewer ? onViewLatest : bottom}><ArrowDown size={15} />{positionTarget && contextHasNewer ? '查看最新记录' : '回到最新'}</Button>}
    {readOnly ? <div className="readonly-history-footer"><ShieldCheck size={16} /><span>只读既有历史 · 不发送消息、不修改源资料或平台已读</span></div> : <Composer account={account} conversation={conversation} draft={draft} mode={mode} busy={busy} blocked={blocked} enterSends={enterSends} onChange={onDraftChange} onSend={onSend} onFile={onFile} onRemoveFile={onRemoveFile} onEnterSendsChange={onEnterSendsChange} />}
    <span className="visually-hidden">{readOnly ? '当前历史来源' : '当前发送身份'}：{platformName(account.platform)}，{account.displayName}</span>
  </main>
}
