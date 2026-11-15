import { useState } from 'react'
import { ArrowUpRight, ChevronDown, CircleHelp, ExternalLink, KeyRound, LoaderCircle, LogIn, LogOut, Mail, Monitor, Moon, RefreshCw, ShieldCheck, Sun, WifiOff } from 'lucide-react'
import type { Account, CapabilityName, Conversation, LoginChallenge, Mode, SystemInfo } from '../lib/types'
import { accountKey, capabilityLabel, cn, platformName, safeExternalUrl } from '../lib/utils'
import { Avatar, PlatformBadge } from './identity'
import { Button, Modal } from './ui'

export const accountStatus = (status: Account['status']) => ({ online: '在线', offline: '离线', login_required: '需要登录', connecting: '连接中', error: '连接异常', unconfigured: '尚未配置' })[status]
const capabilities: [CapabilityName, string][] = [['text', '文字'], ['image', '图片'], ['video', '视频'], ['sticker', '表情包'], ['file', '文件'], ['miniApp', '小程序链接'], ['history', '历史'], ['realtime', '实时消息']]

export function AccountManager({ open, onOpenChange, accounts, loading, mode, error, operation, feedback, onAction, onRefresh }: {
  open: boolean; onOpenChange: (open: boolean) => void; accounts: Account[]; loading: boolean; mode: Mode; error?: string; operation?: string; feedback: Record<string, LoginChallenge>; onAction: (account: Account, action: 'login' | 'logout' | 'sync') => void; onRefresh: () => void
}) {
  const [logoutTarget, setLogoutTarget] = useState<Account | null>(null)
  return <><Modal open={open} onOpenChange={onOpenChange} title="你的账号" description="各平台保留独立身份，连接状态和可用能力分别展示。" className="account-modal">
    <div className="accounts-toolbar"><span><ShieldCheck size={14} />{mode === 'demo' ? '以下均为合成演示账号' : '登录请求由已配置的上游处理'}</span><Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? 'spinning' : ''} />刷新状态</Button></div>
    {loading && !accounts.length && <div className="list-state"><LoaderCircle className="spinning" /><p>读取账号…</p></div>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {!loading && !accounts.length && <div className="list-state"><WifiOff size={25} /><strong>尚无可用账号</strong><p>登录 SnSBox 后查看服务端配置的微信和 QQ 账号。</p></div>}
    <div className="account-cards">{accounts.map(account => {
      const key = accountKey(account)
      const pending = operation?.startsWith(key)
      const actionEnabled = (name: 'login' | 'logout') => ['supported', 'unverified'].includes(account.capabilities[name]?.status || 'unavailable')
      const mailUrl = account.platform === 'qq' && account.mailUrl === 'https://mail.qq.com/' ? account.mailUrl : undefined
      return <section className="account-card" key={key}>
        <div className="account-card-heading"><Avatar name={account.displayName} platform={account.platform} /><div><h3>{account.displayName}</h3><p>{platformName(account.platform)}账号{mode === 'demo' && ' · 示例'}</p></div><span className={cn('account-state', account.status === 'online' && 'account-state-online')}><span className={cn('status-dot', account.status === 'online' && 'is-online')} />{mode === 'demo' ? '演示' : accountStatus(account.status)}</span></div>
        <p className="account-status-message">{account.statusMessage || (mode === 'demo' ? '仅用于预览界面，不连接或操作真实平台。' : account.status === 'online' ? '上游状态可用，具体发送能力以验证结果为准。' : '请检查服务端账号配置或上游状态。')}</p>
        <div className="capability-grid">{capabilities.map(([name, label]) => { const value = account.capabilities[name]; return <span key={name} className={`capability-chip capability-${value?.status || 'unverified'}`} title={value?.reason || '尚无能力证据'}>{label}<i />{capabilityLabel(value?.status || 'unverified')}</span> })}</div>
        {account.historyScope && <p className="account-history-scope"><CircleHelp size={13} />{account.historyScope}</p>}
        {feedback[key] && <div className={cn('account-feedback', feedback[key].state === 'blocked' && 'feedback-error')} role="status"><strong>{feedback[key].state === 'pending' ? '等待继续操作' : feedback[key].state === 'blocked' ? '操作尚未完成' : '上游已接受请求'}</strong><p>{feedback[key].message}</p>{safeExternalUrl(feedback[key].loginUrl) && <a href={safeExternalUrl(feedback[key].loginUrl)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">前往上游登录页面<ArrowUpRight size={14} /></a>}</div>}
        <div className="account-actions"><Button variant="secondary" size="sm" disabled={!!pending || !actionEnabled('login') || mode === 'demo'} onClick={() => onAction(account, 'login')} title={account.capabilities.login?.reason}><LogIn size={14} />{account.capabilities.login?.status === 'unverified' ? '验证登录' : '登录账号'}</Button><Button variant="ghost" size="sm" disabled={!!pending || !account.upstreamConfigured || mode === 'demo'} onClick={() => onAction(account, 'sync')}><RefreshCw size={14} className={pending ? 'spinning' : ''} />同步历史</Button><Button variant="ghost" size="sm" disabled={!!pending || !actionEnabled('logout') || mode === 'demo'} onClick={() => setLogoutTarget(account)} title={account.capabilities.logout?.reason}><LogOut size={14} />退出账号</Button>{mailUrl && <a className="mail-link" href={mailUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Mail size={14} />QQ 邮箱<ExternalLink size={12} /></a>}</div>
      </section>
    })}</div>
    <p className="modal-footnote">QQ 邮箱在独立网页打开；SnSBox 不读取邮箱，也不接管已有客户端资料。未验证操作可能需要到上游受保护界面继续。</p>
  </Modal><Modal open={!!logoutTarget} onOpenChange={value => { if (!value) setLogoutTarget(null) }} title={`退出${logoutTarget ? platformName(logoutTarget.platform) : ''}账号？`} description="此操作向上游请求退出登录，SnSBox 已同步的本地历史会保留。"><p className="confirmation-copy">{logoutTarget?.displayName}</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setLogoutTarget(null)}>取消</Button><Button variant="danger" onClick={() => { if (logoutTarget) onAction(logoutTarget, 'logout'); setLogoutTarget(null) }}>请求退出</Button></div></Modal></>
}

export function Settings({ open, onOpenChange, theme, onTheme, enterSends, onEnterSends, mode, system, onSignOut, signingOut }: {
  open: boolean; onOpenChange: (value: boolean) => void; theme: string; onTheme: (value: string) => void; enterSends: boolean; onEnterSends: (value: boolean) => void; mode: Mode; system?: SystemInfo; onSignOut: () => void; signingOut: boolean
}) {
  return <Modal open={open} onOpenChange={onOpenChange} title="让这里更像你" description="偏好只保存在当前浏览器，消息草稿仅保留于当前页面。" className="settings-modal">
    <div className="settings-section"><h3>外观</h3><div className="theme-options">{[{ id: 'light', label: '浅色', icon: Sun }, { id: 'dark', label: '深色', icon: Moon }, { id: 'system', label: '跟随系统', icon: Monitor }].map(({ id, label, icon: Icon }) => <button type="button" key={id} className={cn('theme-option', theme === id && 'is-active')} onClick={() => onTheme(id)} aria-pressed={theme === id}><span className={`theme-preview preview-${id}`}><i /><i /><i /></span><span><Icon size={15} />{label}</span></button>)}</div></div>
    <div className="settings-section"><h3>输入</h3><label className="settings-row"><span><strong>Enter 发送消息</strong><small>关闭后 Enter 换行，通过按钮发送；中文组合输入始终不会触发发送。</small></span><input type="checkbox" role="switch" checked={enterSends} onChange={event => onEnterSends(event.target.checked)} /></label></div>
    <div className="settings-section data-policy"><ShieldCheck size={18} /><div><h3>你的数据，各自安放</h3><p>{system?.dataPolicy || '只搜索 SnSBox 已同步的历史，不保证获取其他设备的完整记录。各平台账号、会话与草稿独立。'}</p><p>消息正文、草稿和管理密码不会写入浏览器本地存储。</p></div></div>
    <details className="diagnostics"><summary>高级 · 服务与资料状态<ChevronDown size={15} /></summary><div><p>SnSBox {system?.version || '0.1.0'} · {mode === 'demo' ? '界面演示' : '当前服务'}</p><p>{system?.legacyConfig?.message || '资料兼容信息需连接服务后查看。'}</p>{system?.legacyConfig?.configured && <><p>旧资料访问策略：{system.legacyConfig.readOnly ? '只读' : '非只读'}</p><ul>{system.legacyConfig.entries.map(entry => <li key={entry.path}><code>{entry.path}</code><span>{entry.present ? '目录存在' : '未发现'}</span></li>)}</ul><p>目录存在不代表已解密、已登录或可收发消息。</p></>}</div></details>
    <div className="settings-footer"><span>SnSBox <i>—</i> 让交流更从容</span>{mode === 'live' && <Button variant="ghost" size="sm" onClick={onSignOut} disabled={signingOut}><LogOut size={14} />退出 SnSBox</Button>}</div>
  </Modal>
}

export function ConversationInfo({ open, onOpenChange, conversation, account }: { open: boolean; onOpenChange: (value: boolean) => void; conversation?: Conversation; account?: Account }) {
  return <Modal open={open && !!conversation && !!account} onOpenChange={onOpenChange} title="会话信息" description="确认当前身份、历史范围和已知能力。" className="info-modal">{conversation && account && <><div className="info-identity"><Avatar name={conversation.title} group={conversation.kind === 'group'} size="large" /><h3>{conversation.title}</h3><span><PlatformBadge platform={account.platform} />{account.displayName}</span></div><div className="info-scope"><ShieldCheck size={19} /><div><strong>历史范围</strong><p>{account.historyScope || 'SnSBox 已同步的本地历史；不保证全设备完整记录。'}</p><p>未读仅表示 SnSBox 本地状态，打开会话不代表同步平台已读。</p></div></div><h4 className="info-section-title">会话能力</h4><div className="info-capabilities">{capabilities.map(([name, label]) => { const value = conversation.capabilities?.[name] || account.capabilities[name]; return <div key={name}><span>{label}</span><span className={`capability-text-${value?.status || 'unverified'}`}>{capabilityLabel(value?.status || 'unverified')}</span>{value?.reason && <small>{value.reason}</small>}</div> })}</div><p className="modal-footnote">“上游已接受”只代表接口受理，不等同于对端收到或已读。</p></>}</Modal>
}

export function Authentication({ loading, error, onLogin, onDemo, onRetry }: { loading: boolean; error?: string; onLogin: (password: string) => Promise<void>; onDemo: () => void; onRetry: () => void }) {
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return <main className="authentication-panel"><div className="authentication-card"><span className="authentication-icon"><KeyRound size={27} strokeWidth={1.5} /></span><span className="eyebrow">YOUR SPACE, YOUR CONVERSATIONS</span><h2>欢迎回到 SnSBox</h2><p>登录你的消息空间，<br />在一处继续微信和 QQ 的对话。</p>{loading ? <div className="auth-loading"><LoaderCircle size={21} className="spinning" />正在连接服务…</div> : <form onSubmit={async event => { event.preventDefault(); if (!password || submitting) return; setSubmitting(true); setFormError(''); try { await onLogin(password); setPassword('') } catch (failure) { setFormError(failure instanceof Error ? failure.message : '登录失败'); setPassword('') } finally { setSubmitting(false) } }}><label htmlFor="admin-password">SnSBox 管理密码</label><input type="password" id="admin-password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="输入部署时设置的管理密码" required disabled={submitting} />{(error || formError) && <p className="inline-error" role="alert">{formError || error}</p>}<Button type="submit" disabled={submitting || !password}>{submitting && <LoaderCircle size={16} className="spinning" />}进入消息空间<ArrowUpRight size={16} /></Button>{error && <Button variant="ghost" type="button" onClick={onRetry}>重新连接服务</Button>}</form>}<div className="auth-demo"><span>想先感受一下？</span><button type="button" onClick={onDemo}>打开界面演示<ArrowUpRight size={13} /></button></div><p className="auth-note"><ShieldCheck size={13} />此处只登录 SnSBox，平台账号在进入后单独连接。</p></div></main>
}
