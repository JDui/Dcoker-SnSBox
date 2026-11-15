import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { BookOpen, ChevronRight, CircleHelp, FlaskConical, Mail, MessageCircle, Moon, Settings as SettingsIcon, Sun, Users, X } from 'lucide-react'
import { api, ApiError, onUnauthorized } from './lib/api'
import { demoAccounts, demoConversations, demoMessages } from './lib/demo'
import type { Account, Conversation, Draft, DraftAttachment, LoginChallenge, Message, Mode, Page, Platform, Segment } from './lib/types'
import { accountKey, capability, cn, conversationKey, readPreference, uniqueId, writePreference } from './lib/utils'
import { Brand } from './components/identity'
import { IconButton, TooltipProvider } from './components/ui'
import { ConversationList } from './components/conversation-list'
import { ChatPanel, Welcome } from './components/chat-panel'
import { AccountManager, Authentication, ConversationInfo, Settings } from './components/settings'

const emptyDraft: Draft = { text: '', attachments: [] }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : undefined
function dedupe<T extends { id: string; platform?: Platform; accountId?: string; conversationId?: string }>(items: T[]) { const seen = new Set<string>(); return items.filter(item => { const key = JSON.stringify([item.platform, item.accountId, item.conversationId, item.id]); if (seen.has(key)) return false; seen.add(key); return true }) }

export default function App() {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<Mode>('live')
  const [platform, setPlatform] = useState<Platform | 'all'>('all')
  const [accountFilter, setAccountFilter] = useState('')
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [theme, setTheme] = useState(() => readPreference('theme', 'system'))
  const [enterSends, setEnterSends] = useState(() => readPreference('enterSends', 'true') !== 'false')
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [streamState, setStreamState] = useState('connecting')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [pending, setPending] = useState<Record<string, Message[]>>({})
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [demoLocal, setDemoLocal] = useState<Message[]>([])
  const [demoRead, setDemoRead] = useState<Set<string>>(new Set())
  const [accountOperation, setAccountOperation] = useState<string>()
  const [accountFeedback, setAccountFeedback] = useState<Record<string, LoginChallenge>>({})
  const [signingOut, setSigningOut] = useState(false)
  const [notice, setNotice] = useState('')
  const objectUrls = useRef(new Set<string>())
  const epoch = useRef(0)
  const lastEventId = useRef<string | undefined>(undefined)
  const inFlight = useRef(new Set<string>())
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const clearPrivateState = useCallback(() => {
    epoch.current++
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
    objectUrls.current.clear(); inFlight.current.clear()
    setDrafts({}); setPending({}); setSending({}); setSelected(null); setSearch(''); setAccountFilter(''); setAccountFeedback({}); setAccountOperation(undefined); setNotice(''); lastEventId.current = undefined
  }, [])
  useEffect(() => () => { for (const url of objectUrls.current) URL.revokeObjectURL(url) }, [])
  useEffect(() => onUnauthorized(() => {
    api.clearSession()
    clearPrivateState()
    queryClient.setQueryData(['session'], null)
    queryClient.cancelQueries({ predicate: query => query.queryKey[0] !== 'session' }).then(() => queryClient.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }))
  }), [clearPrivateState, queryClient])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { const dark = theme === 'dark' || theme === 'system' && media.matches; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#161b19' : '#f6f8f7') }
    apply(); media.addEventListener('change', apply); writePreference('theme', theme)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => { writePreference('enterSends', String(enterSends)) }, [enterSends])
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250); return () => window.clearTimeout(timer) }, [search])
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !target.matches('input,textarea,[contenteditable="true"]') && !document.querySelector('[role="dialog"]')) { event.preventDefault(); document.getElementById('workspace-search')?.focus() }
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) { setSearch(''); if (window.matchMedia('(max-width: 720px)').matches) setSelected(null) }
    }
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut)
  }, [])

  const session = useQuery({ queryKey: ['session'], queryFn: api.session, enabled: mode === 'live', retry: false, staleTime: Infinity })
  const authenticated = mode === 'live' && !!session.data?.authenticated
  const accountsQuery = useQuery({ queryKey: ['live', 'accounts'], queryFn: api.accounts, enabled: authenticated, retry: false, staleTime: 15_000, refetchInterval: 45_000 })
  const conversationsQuery = useInfiniteQuery({ queryKey: ['live', 'conversations'], queryFn: ({ pageParam }) => api.conversations(undefined, pageParam), initialPageParam: null as string | null, getNextPageParam: page => page.nextCursor || undefined, enabled: authenticated, retry: false, staleTime: 15_000 })
  const systemQuery = useQuery({ queryKey: ['live', 'system'], queryFn: api.system, enabled: authenticated && settingsOpen, retry: false, staleTime: 60_000 })
  const accounts = mode === 'demo' ? demoAccounts : authenticated ? accountsQuery.data?.items ?? [] : []
  const allConversations = mode === 'demo' ? demoConversations.map(conversation => ({ ...conversation, unreadCount: demoRead.has(conversationKey(conversation)) ? 0 : conversation.unreadCount })) : authenticated ? dedupe(conversationsQuery.data?.pages.flatMap(page => page.items) ?? []) : []
  const active = selected ? allConversations.find(item => conversationKey(item) === conversationKey(selected)) || selected : undefined
  const activeAccount = active && accounts.find(account => account.id === active.accountId && account.platform === active.platform)
  const activeKey = active && conversationKey(active)
  const scopedKey = activeKey ? `${mode}:${activeKey}` : undefined
  const filteredConversations = allConversations.filter(conversation => (platform === 'all' || conversation.platform === platform) && (!accountFilter || accountKey({ id: conversation.accountId, platform: conversation.platform }) === accountFilter))
  const selectedAccount = accounts.find(account => accountKey(account) === accountFilter)
  const messagesQuery = useInfiniteQuery({ queryKey: ['live', 'messages', activeKey], queryFn: ({ pageParam }) => api.messages(active!.id, pageParam), initialPageParam: null as string | null, getNextPageParam: page => page.nextCursor || undefined, enabled: authenticated && !!active, retry: false, staleTime: 15_000 })
  const searchQuery = useInfiniteQuery({ queryKey: ['live', 'search', debouncedSearch, selectedAccount?.id], queryFn: ({ pageParam }) => api.search(debouncedSearch, selectedAccount?.id, pageParam), initialPageParam: null as string | null, getNextPageParam: page => page.nextCursor || undefined, enabled: authenticated && !!debouncedSearch, retry: false, staleTime: 15_000 })
  const sourceMessages = mode === 'demo' ? [...demoMessages, ...demoLocal] : dedupe(messagesQuery.data?.pages.flatMap(page => page.items) ?? []).reverse()
  const serverMessages = active ? sourceMessages.filter(message => message.conversationId === active.id && message.accountId === active.accountId && message.platform === active.platform) : []
  const latestMessageId = serverMessages.at(-1)?.id
  const localMessages = scopedKey ? pending[scopedKey] || [] : []
  const messages = [...serverMessages, ...localMessages]
  const localIds = useMemo(() => new Set(localMessages.map(message => message.id)), [localMessages])
  const searchResults = (mode === 'demo' ? [...demoMessages, ...demoLocal].filter(message => message.segments.some(segment => segment.type === 'text' && segment.text.toLocaleLowerCase().includes(debouncedSearch.toLocaleLowerCase()))) : dedupe(searchQuery.data?.pages.flatMap(page => page.items) ?? [])).filter(message => (platform === 'all' || message.platform === platform) && (!accountFilter || accountKey({ id: message.accountId, platform: message.platform }) === accountFilter))

  useEffect(() => {
    if (!authenticated) return
    let refreshTimer: number | undefined
    let closed = false
    setStreamState('connecting')
    const source = api.events(lastEventId.current)
    source.onopen = () => { setStreamState('connected'); queryClient.invalidateQueries({ queryKey: ['live', 'accounts'] }); queryClient.invalidateQueries({ queryKey: ['live', 'conversations'] }) }
    source.addEventListener('update', event => {
      const update = event as MessageEvent
      if (update.lastEventId) lastEventId.current = update.lastEventId
      if (refreshTimer) return
      refreshTimer = window.setTimeout(() => { queryClient.invalidateQueries({ queryKey: ['live'] }); refreshTimer = undefined }, 220)
    })
    source.onerror = () => {
      setStreamState('reconnecting')
      api.session().then(value => { if (!closed && !value) { clearPrivateState(); queryClient.setQueryData(['session'], null); queryClient.removeQueries({ queryKey: ['live'] }) } }).catch(() => { /* EventSource retries; account status remains separate. */ })
    }
    return () => { closed = true; source.close(); window.clearTimeout(refreshTimer) }
  }, [authenticated, queryClient, clearPrivateState])
  useEffect(() => {
    if (!active || !authenticated) return
    const context = epoch.current
    api.read(active.id).then(() => { if (context === epoch.current) queryClient.invalidateQueries({ queryKey: ['live', 'conversations'] }) }).catch(() => { /* A local read failure must not block reading the conversation. */ })
  }, [activeKey, latestMessageId, authenticated, queryClient])

  const setWorkspaceMode = (next: Mode) => {
    if (next === mode) return
    clearPrivateState(); setInfoOpen(false); setAccountsOpen(false); setSettingsOpen(false); setDemoLocal([]); setDemoRead(new Set()); setPlatform('all'); setMode(next)
    if (next === 'demo') setSelected(demoConversations[0])
    else queryClient.invalidateQueries({ queryKey: ['session'] })
  }
  const selectConversation = (conversation: Conversation) => {
    setSelected(conversation)
    if (mode === 'demo') setDemoRead(previous => new Set(previous).add(conversationKey(conversation)))
  }
  const openSearchResult = (message: Message) => {
    const conversation = allConversations.find(item => item.id === message.conversationId && item.accountId === message.accountId && item.platform === message.platform) || { id: message.conversationId, accountId: message.accountId, platform: message.platform, title: message.senderName || '搜索中的会话', kind: 'direct' as const, unreadCount: 0 }
    selectConversation(conversation); setNotice('已打开会话的最近记录；搜索结果可能位于更早的已同步历史中。')
  }
  const updateDraft = (key: string, patch: Partial<Draft>) => setDrafts(previous => ({ ...previous, [key]: { ...(previous[key] || emptyDraft), ...patch } }))
  const releaseAttachment = (attachment: DraftAttachment) => { if (attachment.preview) { URL.revokeObjectURL(attachment.preview); objectUrls.current.delete(attachment.preview) } }
  const attachFile = (key: string, file: File, kind: DraftAttachment['kind']) => {
    const previous = draftsRef.current[key] || emptyDraft
    previous.attachments.forEach(releaseAttachment)
    const preview = kind === 'image' || kind === 'sticker' ? URL.createObjectURL(file) : undefined
    if (preview) objectUrls.current.add(preview)
    updateDraft(key, { attachments: [{ id: uniqueId(), file, kind, preview }] })
  }
  const removeAttachment = (key: string, id: string) => {
    const current = draftsRef.current[key] || emptyDraft
    current.attachments.filter(item => item.id === id).forEach(releaseAttachment)
    updateDraft(key, { attachments: current.attachments.filter(item => item.id !== id) })
  }
  const consumeDraft = (key: string, snapshot: Draft) => {
    setDrafts(previous => {
      const current = previous[key] || emptyDraft
      if (snapshot.attachments.length) { snapshot.attachments.forEach(releaseAttachment); return { ...previous, [key]: { ...current, attachments: current.attachments.filter(item => !snapshot.attachments.some(sent => sent.id === item.id)) } } }
      return { ...previous, [key]: { ...current, text: current.text === snapshot.text ? '' : current.text } }
    })
  }
  const sendMessage = async () => {
    if (!active || !activeAccount || !scopedKey || inFlight.current.has(scopedKey) || localMessages.some(message => message.status === 'uncertain')) return
    const snapshot = draftsRef.current[scopedKey] || emptyDraft
    const attachment = snapshot.attachments[0]
    if ((!snapshot.text.trim() && !attachment) || activeAccount.status !== 'online' || !['supported', 'unverified'].includes(capability(activeAccount, active, attachment?.kind || 'text').status)) return
    if (!attachment && new TextEncoder().encode(snapshot.text.trim()).length > 16_384) { setNotice('文字超过 16 KB，请分段发送。'); return }
    const key = scopedKey, conversation = active, currentMode = mode, context = epoch.current
    const idempotencyKey = uniqueId()
    const localId = `local-${idempotencyKey}`
    let segments: Segment[] = attachment ? [{ type: attachment.kind, name: attachment.file.name, size: attachment.file.size, unavailableReason: '正在上传…' }] : [{ type: 'text', text: snapshot.text.trim() }]
    const local: Message = { id: localId, conversationId: conversation.id, accountId: conversation.accountId, platform: conversation.platform, senderName: '我', direction: 'outgoing', timestamp: new Date().toISOString(), segments, status: currentMode === 'demo' ? 'demo' : 'submitting' }
    if (currentMode === 'demo') {
      if (attachment) local.segments = [{ type: attachment.kind, name: attachment.file.name, unavailableReason: '演示附件，未上传至服务' }]
      setDemoLocal(previous => [...previous, local]); consumeDraft(key, snapshot); return
    }
    inFlight.current.add(key)
    setSending(previous => ({ ...previous, [key]: true }))
    setPending(previous => ({ ...previous, [key]: [...(previous[key] || []), local] }))
    let submitted = false
    try {
      if (attachment) {
        const uploaded = await api.upload(conversation.accountId, attachment.file)
        if (context !== epoch.current) return
        segments = [{ type: attachment.kind, mediaId: uploaded.id, url: uploaded.url, name: uploaded.name, mimeType: uploaded.mimeType }]
      }
      if (context !== epoch.current) return
      submitted = true
      const result = await api.send(conversation.id, segments, idempotencyKey)
      if (context !== epoch.current) return
      if (result.accountId !== conversation.accountId || result.platform !== conversation.platform || result.conversationId !== conversation.id) throw new Error('发送回执身份不匹配，请核对上游记录。')
      queryClient.setQueryData<InfiniteData<Page<Message>>>(['live', 'messages', conversationKey(conversation)], previous => previous ? { ...previous, pages: [{ ...previous.pages[0], items: [result, ...previous.pages[0].items.filter(item => item.id !== result.id)] }, ...previous.pages.slice(1)] } : { pageParams: [null], pages: [{ items: [result], nextCursor: null }] })
      setPending(previous => ({ ...previous, [key]: (previous[key] || []).filter(item => item.id !== localId) }))
      if (result.status !== 'failed') consumeDraft(key, snapshot)
      queryClient.invalidateQueries({ queryKey: ['live', 'conversations'] })
    } catch (error) {
      if (context !== epoch.current) return
      const uncertain = submitted && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500)
      setPending(previous => ({ ...previous, [key]: (previous[key] || []).map(item => item.id === localId ? { ...item, segments, status: uncertain ? 'uncertain' : 'failed', error: uncertain ? '提交结果暂时无法确认。请核对最近历史，确认后再决定是否发送。' : errorMessage(error) || '发送未完成' } : item) }))
    } finally { if (context === epoch.current) { inFlight.current.delete(key); setSending(previous => ({ ...previous, [key]: false })) } }
  }
  const accountAction = async (account: Account, action: 'login' | 'logout' | 'sync') => {
    if (mode !== 'live' || !authenticated || accountOperation) return
    const key = accountKey(account), context = epoch.current
    setAccountOperation(`${key}:${action}`)
    try {
      let result: LoginChallenge
      if (action === 'login') result = await api.loginAccount(account.id)
      else if (action === 'logout') { const value = await api.logoutAccount(account.id); result = { state: 'pending', message: value?.message || '退出请求已提交。请刷新账号状态确认上游结果。' } }
      else { const value = await api.sync(account.id); result = { state: value.synced ? 'accepted' : 'blocked', message: value.message } }
      if (context === epoch.current) { setAccountFeedback(previous => ({ ...previous, [key]: result })); queryClient.invalidateQueries({ queryKey: ['live'] }) }
    } catch (error) { if (context === epoch.current) setAccountFeedback(previous => ({ ...previous, [key]: { state: 'blocked', message: errorMessage(error) || '操作未完成' } })) }
    finally { if (context === epoch.current) setAccountOperation(undefined) }
  }
  const signOut = async () => {
    setSigningOut(true)
    try { await api.logout(); clearPrivateState(); setSettingsOpen(false); queryClient.clear(); queryClient.setQueryData(['session'], null) }
    catch (error) { setNotice(errorMessage(error) || '退出未完成，请重试。') }
    finally { setSigningOut(false) }
  }
  const loadOlder = async () => {
    const count = serverMessages.length
    const result = await messagesQuery.fetchNextPage()
    if (result.isError) throw result.error
    return dedupe(result.data?.pages.flatMap(page => page.items) || []).length > count
  }
  const openHistory = () => { if (window.matchMedia('(max-width: 720px)').matches) setSelected(null); window.setTimeout(() => document.getElementById('workspace-search')?.focus(), 0) }
  const totalUnread = allConversations.reduce((sum, item) => sum + item.unreadCount, 0)
  const authScreen = mode === 'live' && !authenticated
  const currentDraft = scopedKey ? drafts[scopedKey] || emptyDraft : emptyDraft
  return <TooltipProvider delayDuration={350}><div className={cn('app-shell', active && !authScreen && 'has-active', mode === 'demo' && 'demo-mode', authScreen && 'auth-screen')}>
    {mode === 'demo' && <div className="demo-banner"><FlaskConical size={14} /><strong>界面演示</strong><span>合成内容，不连接或发送真实消息</span><button type="button" onClick={() => setWorkspaceMode('live')}>退出演示<ChevronRight size={13} /></button></div>}
    <nav className="navigation-rail" aria-label="主导航"><button type="button" className="rail-brand-button" aria-label="回到消息首页" onClick={() => setSelected(null)}><Brand compact /></button><div className="rail-primary"><IconButton label="消息" className="rail-button is-active" onClick={() => { setSearch(''); setSelected(null) }}><MessageCircle size={23} strokeWidth={1.7} />{totalUnread > 0 && <span className="rail-notification-dot" />}</IconButton><IconButton label="搜索历史" className="rail-button" onClick={openHistory}><BookOpen size={22} strokeWidth={1.7} /></IconButton><IconButton label="账号管理" className="rail-button" onClick={() => setAccountsOpen(true)}><Users size={22} strokeWidth={1.7} /></IconButton></div><div className="rail-bottom"><a className="rail-mail" href="https://mail.qq.com/" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label="在新标签页打开 QQ 邮箱" title="QQ 邮箱（独立网页）"><Mail size={20} /></a><IconButton label="切换浅深色" className="rail-button theme-quick-toggle" onClick={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={21} /> : <Moon size={21} />}</IconButton><IconButton label="设置" className="rail-button" onClick={() => setSettingsOpen(true)}><SettingsIcon size={21} strokeWidth={1.7} /></IconButton><button type="button" className="profile-button" onClick={() => setAccountsOpen(true)} aria-label="查看账号">S<span /></button></div></nav>
    <ConversationList conversations={filteredConversations} accounts={accounts} activeKey={activeKey} platform={platform} accountFilter={accountFilter} search={search} searchResults={searchResults} searchLoading={mode === 'live' && !!search.trim() && (debouncedSearch !== search.trim() || searchQuery.isFetching && !searchQuery.data)} searchError={errorMessage(searchQuery.error)} loading={authenticated && conversationsQuery.isPending} error={authenticated ? errorMessage(conversationsQuery.error) : undefined} mode={mode} hasMore={mode === 'live' && !!conversationsQuery.hasNextPage} hasMoreSearch={mode === 'live' && !!searchQuery.hasNextPage} loadingMore={conversationsQuery.isFetchingNextPage || searchQuery.isFetchingNextPage} onPlatform={setPlatform} onAccountFilter={setAccountFilter} onSearch={setSearch} onSelect={selectConversation} onSearchSelect={openSearchResult} onManageAccounts={() => setAccountsOpen(true)} onLoadMore={() => conversationsQuery.fetchNextPage()} onLoadMoreSearch={() => searchQuery.fetchNextPage()} onRetry={() => conversationsQuery.refetch()} />
    <div className="main-workspace">{notice && <div className="workspace-notice" role="status"><CircleHelp size={15} /><span>{notice}</span><IconButton label="关闭提示" onClick={() => setNotice('')}><X size={15} /></IconButton></div>}
      {authScreen ? <Authentication loading={session.isPending} error={errorMessage(session.error)} onLogin={async password => { const value = await api.login(password); clearPrivateState(); queryClient.setQueryData(['session'], value) }} onDemo={() => setWorkspaceMode('demo')} onRetry={() => session.refetch()} /> : active && activeAccount && scopedKey ? <ChatPanel key={scopedKey} account={activeAccount} conversation={active} messages={messages} localIds={localIds} draft={currentDraft} mode={mode} busy={!!sending[scopedKey]} blocked={localMessages.some(message => message.status === 'uncertain')} loading={mode === 'live' && messagesQuery.isPending} error={mode === 'live' ? errorMessage(messagesQuery.error) : undefined} hasMore={mode === 'live' && !!messagesQuery.hasNextPage} loadingMore={messagesQuery.isFetchingNextPage} enterSends={enterSends} onBack={() => setSelected(null)} onInfo={() => setInfoOpen(true)} onSearch={openHistory} onLoadOlder={loadOlder} onRetry={() => messagesQuery.refetch()} onDraftChange={value => updateDraft(scopedKey, { text: value })} onSend={sendMessage} onFile={(file, kind) => attachFile(scopedKey, file, kind)} onRemoveFile={id => removeAttachment(scopedKey, id)} onEnterSendsChange={setEnterSends} onCheck={() => { messagesQuery.refetch(); setNotice('正在刷新最近历史。请核对平台实际记录；未确认的消息不会自动重发。') }} onDismiss={id => setPending(previous => ({ ...previous, [scopedKey]: (previous[scopedKey] || []).filter(message => message.id !== id) }))} /> : <Welcome mode={mode} onAccounts={() => setAccountsOpen(true)} onDemo={() => setWorkspaceMode('demo')} accounts={accounts} streamState={streamState} />}
      {authenticated && streamState === 'reconnecting' && <div className="stream-indicator" role="status"><span />实时连接恢复中</div>}
    </div>
    <AccountManager open={accountsOpen} onOpenChange={setAccountsOpen} accounts={accounts} loading={authenticated && accountsQuery.isFetching} error={errorMessage(accountsQuery.error)} mode={mode} operation={accountOperation} feedback={accountFeedback} onAction={accountAction} onRefresh={() => { if (mode === 'live' && authenticated) accountsQuery.refetch() }} />
    <Settings open={settingsOpen} onOpenChange={setSettingsOpen} theme={theme} onTheme={setTheme} enterSends={enterSends} onEnterSends={setEnterSends} mode={mode} system={systemQuery.data} onSignOut={signOut} signingOut={signingOut} />
    <ConversationInfo open={infoOpen} onOpenChange={setInfoOpen} conversation={active} account={activeAccount} />
  </div></TooltipProvider>
}
