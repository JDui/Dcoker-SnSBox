import { useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, CircleHelp, ExternalLink, KeyRound, LoaderCircle, LogIn, LogOut, Mail, Monitor, Moon, RefreshCw, ShieldCheck, Sun, WifiOff } from 'lucide-react'
import type { Account, AccountAction, AccountOperation, CapabilityName, Conversation, LoginChallenge, LoginOptions, Mode, SystemInfo } from '../lib/types'
import { accountKey, capabilityLabel, cn, platformName, safeExternalUrl } from '../lib/utils'
import { Avatar, PlatformBadge } from './identity'
import { Button, Modal } from './ui'
import { AccountOperationPanel, CompatibilityCheck, isOperationTerminal } from './account-workflow'
import { accentPresets, type AccentName } from '../lib/appearance'

export const accountStatus = (status: Account['status']) => ({ online: '在线', offline: '离线', login_required: '需要登录', connecting: '连接中', error: '连接异常', unconfigured: '尚未配置' })[status]
const capabilities: [CapabilityName, string][] = [['text', '文字'], ['image', '图片'], ['video', '视频'], ['sticker', '表情包'], ['file', '文件'], ['miniApp', '小程序链接'], ['history', '历史'], ['realtime', '实时消息']]

export function AccountManager({ open, onOpenChange, accounts, loading, mode, error, operation, feedback, onAction, onRefresh, onOperationUpdate, onClearFeedback }: {
  open: boolean; onOpenChange: (open: boolean) => void; accounts: Account[]; loading: boolean; mode: Mode; error?: string; operation?: string
  feedback: Record<string, LoginChallenge>; onAction: (account: Account, action: AccountAction, options?: LoginOptions) => void; onRefresh: () => void
  onOperationUpdate: (account: Account, operation: AccountOperation) => void; onClearFeedback: (account: Account) => void
}) {
  const [logoutTarget, setLogoutTarget] = useState<Account | null>(null)
  const [provisionTarget, setProvisionTarget] = useState<Account | null>(null)
  const [confirmIsolated, setConfirmIsolated] = useState(false)
  const [strategies, setStrategies] = useState<Record<string, LoginOptions['strategy']>>({})
  return <>
    <Modal open={open} onOpenChange={onOpenChange} title="账号管理" description="先配置独立来源，再登录平台账号；各平台始终保留独立身份。" className="account-modal">
      <div className="accounts-toolbar">
        <span><ShieldCheck size={14} />{mode === 'demo' ? '以下均为合成演示账号' : '账号状态以实际上游反馈为准'}</span>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? 'spinning' : ''} />刷新状态</Button>
      </div>
      {loading && !accounts.length && <div className="list-state"><LoaderCircle className="spinning" /><p>读取账号…</p></div>}
      {error && <p role="alert" className="inline-error">{error}</p>}
      {!loading && !accounts.length && <div className="list-state"><WifiOff size={25} /><strong>尚无可用账号</strong><p>登录 SnSBox 后查看服务端配置的微信和 QQ 账号。</p></div>}
      <div className="account-cards">{accounts.map(account => {
        const key = accountKey(account)
        const challenge = feedback[key]
        const requestPending = !!operation?.startsWith(key)
        const awaitingTask = !!challenge?.operationId && !isOperationTerminal(challenge)
        const manualReview = challenge?.state === 'uncertain' || !!challenge && !challenge.operationId && challenge.state === 'pending'
        const busy = requestPending || awaitingTask || manualReview
        const actionEnabled = (name: 'login' | 'logout') => ['supported', 'unverified'].includes(account.capabilities[name]?.status || 'unavailable')
        const mailUrl = account.platform === 'qq' && account.mailUrl === 'https://mail.qq.com/' ? account.mailUrl : undefined
        const strategy = strategies[key] || 'auto'
        return <section className="account-card" key={key} aria-label={`${platformName(account.platform)} · ${account.displayName}`}>
          <div className="account-card-heading"><Avatar name={account.displayName} platform={account.platform} /><div><h3>{account.displayName}</h3><p>{platformName(account.platform)}账号{mode === 'demo' && ' · 示例'}</p></div><span className={cn('account-state', account.status === 'online' && 'account-state-online')}><span className={cn('status-dot', account.status === 'online' && 'is-online')} />{mode === 'demo' ? '演示' : accountStatus(account.status)}</span></div>
          <p className="account-status-message">{account.statusMessage || (mode === 'demo' ? '仅用于预览界面，不连接或操作真实平台。' : account.status === 'online' ? '上游已报告有效登录状态，具体收发能力仍需分别验证。' : account.status === 'connecting' ? '正在核对有效连接证据，不将接口可访问等同于账号在线。' : '账号尚未在线，请检查来源配置或发起平台登录。')}</p>
          {mode === 'live' && <ol className="connection-steps" aria-label="账号接入步骤"><li data-complete={!!account.upstreamConfigured}><i>1</i>{account.upstreamConfigured ? '来源已配置' : '配置独立来源'}</li><li data-complete={account.status === 'online'}><i>2</i>{account.status === 'online' ? '账号在线' : awaitingTask ? '等待登录确认' : '登录平台账号'}</li><li data-complete={challenge?.phase === 'synced'}><i>3</i>{challenge?.phase === 'synced' ? '本次同步已完成' : '同步本地历史'}</li></ol>}
          {mode === 'live' && !account.upstreamConfigured && <div className="connection-guidance"><strong>尚未接入</strong><p>请在部署端配置独立上游服务，再刷新账号状态。原 WS 的活动 config 只做只读预检，不直接注册或接管。</p></div>}
          {mode === 'live' && account.platform === 'wechat' && account.upstreamConfigured && <div className="login-method"><label htmlFor={`login-method-${account.id}`}>登录方式</label><select id={`login-method-${account.id}`} value={strategy} disabled={busy} onChange={event => setStrategies(previous => ({ ...previous, [key]: event.target.value as LoginOptions['strategy'] }))}><option value="auto">自动选择（可使用二维码）</option><option value="saved-device">仅使用已有独立设备</option><option value="qr">使用新的登录二维码</option></select></div>}
          <div className="capability-grid">{capabilities.map(([name, label]) => { const value = account.capabilities[name]; return <span key={name} className={`capability-chip capability-${value?.status || 'unverified'}`} title={value?.reason || '尚无能力证据'}>{label}<i />{capabilityLabel(value?.status || 'unverified')}</span> })}</div>
          {account.historyScope && <p className="account-history-scope"><CircleHelp size={13} />{account.historyScope}</p>}
          {challenge?.operationId ? <><AccountOperationPanel account={account} challenge={challenge} onUpdate={onOperationUpdate} />{manualReview && <div className="manual-task-review"><p>结果仍待核对，不会自动重新登录或退出。</p><Button variant="ghost" size="sm" onClick={() => onClearFeedback(account)}>已核对，解除本地提示</Button></div>}</> : challenge && <div className={cn('account-feedback', challenge.state === 'blocked' && 'feedback-error', challenge.state === 'uncertain' && 'feedback-uncertain', challenge.state === 'accepted' && 'feedback-accepted')} role="status"><strong>{challenge.state === 'uncertain' ? '请求结果待核对' : challenge.state === 'pending' ? '等待继续操作' : challenge.state === 'blocked' ? '操作尚未完成' : '上游已接受请求'}</strong><p>{challenge.message}</p>{safeExternalUrl(challenge.loginUrl || undefined) && <a href={safeExternalUrl(challenge.loginUrl || undefined)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">前往上游登录页面<ArrowUpRight size={14} /></a>}{manualReview && <><p>先刷新账号或检查上游；此请求不会自动重新提交。</p><Button variant="ghost" size="sm" onClick={() => onClearFeedback(account)}>已核对，解除本地提示</Button></>}</div>}
          <div className="account-actions">
            <Button variant="secondary" size="sm" disabled={busy || !actionEnabled('login') || mode === 'demo'} onClick={() => onAction(account, 'login', account.platform === 'wechat' ? { strategy, allowQr: strategy !== 'saved-device' } : {})} title={account.capabilities.login?.reason}><LogIn size={14} />{requestPending ? '正在提交…' : account.capabilities.login?.status === 'unverified' ? '验证登录' : '登录账号'}</Button>
            <Button variant="ghost" size="sm" disabled={busy || !account.upstreamConfigured || mode === 'demo'} onClick={() => onAction(account, 'sync')}><RefreshCw size={14} className={requestPending ? 'spinning' : ''} />同步历史</Button>
            <Button variant="ghost" size="sm" disabled={busy || !actionEnabled('logout') || mode === 'demo'} onClick={() => setLogoutTarget(account)} title={account.capabilities.logout?.reason}><LogOut size={14} />退出账号</Button>
            {mailUrl && <a className="mail-link" href={mailUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Mail size={14} />QQ 邮箱<ExternalLink size={12} /></a>}
          </div>
          {mode === 'live' && account.platform === 'wechat' && account.upstreamConfigured && <details className="independent-account"><summary>首次接入 · 独立账号资料</summary><p>仅在已配置的上游中准备独立账号空间。此操作不导入旧 config、令牌或历史，不影响原客户端。</p><Button variant="secondary" size="sm" disabled={busy} onClick={() => { setConfirmIsolated(false); setProvisionTarget(account) }}>初始化独立账号</Button></details>}
        </section>
      })}</div>
      <CompatibilityCheck enabled={mode === 'live' && accounts.length > 0} />
      <p className="modal-footnote">扫码或任务受理不等于真实收发已验收。QQ 邮箱在独立网页打开；SnSBox 不读取邮箱，也不接管原客户端资料。</p>
    </Modal>
    <Modal open={!!logoutTarget} onOpenChange={value => { if (!value) setLogoutTarget(null) }} title={`退出${logoutTarget ? platformName(logoutTarget.platform) : ''}账号？`} description="此操作向上游请求退出登录，SnSBox 已同步的本地历史会保留。"><p className="confirmation-copy">{logoutTarget?.displayName}</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setLogoutTarget(null)}>取消</Button><Button variant="danger" onClick={() => { if (logoutTarget) onAction(logoutTarget, 'logout'); setLogoutTarget(null) }}>请求退出</Button></div></Modal>
    <Modal open={!!provisionTarget} onOpenChange={value => { if (!value) { setProvisionTarget(null); setConfirmIsolated(false) } }} title="准备独立账号资料" description="只在已配置上游创建独立的 managed 账号；已有同名账号不覆盖。"><p className="confirmation-copy">不会导入、移动或写入原 WS 的活动 config。后续登录使用此独立空间，原客户端资料保持原状。</p><label className="isolation-confirmation"><input type="checkbox" checked={confirmIsolated} onChange={event => setConfirmIsolated(event.target.checked)} /><span>我确认只初始化独立账号空间，不接管原资料目录。</span></label><div className="dialog-actions"><Button variant="secondary" onClick={() => setProvisionTarget(null)}>取消</Button><Button disabled={!confirmIsolated} onClick={() => { if (provisionTarget && confirmIsolated) onAction(provisionTarget, 'provision'); setProvisionTarget(null); setConfirmIsolated(false) }}>准备独立账号</Button></div></Modal>
  </>
}

export function Settings({ accent, onAccent, reduceTransparency, onReduceTransparency, open, onOpenChange, theme, onTheme, enterSends, onEnterSends, mode, system, onSignOut, signingOut }: {
  accent: AccentName; onAccent: (value: AccentName) => void
  reduceTransparency: boolean; onReduceTransparency: (value: boolean) => void; open: boolean; onOpenChange: (value: boolean) => void; theme: string; onTheme: (value: string) => void; enterSends: boolean; onEnterSends: (value: boolean) => void; mode: Mode; system?: SystemInfo; onSignOut: () => void; signingOut: boolean
}) {
  return <Modal open={open} onOpenChange={onOpenChange} title="设置" description="偏好只保存在当前浏览器，消息草稿仅保留于当前页面。" className="settings-modal">
    <div className="settings-section"><h3>外观</h3><div className="theme-options">{[{ id: 'light', label: '浅色', icon: Sun }, { id: 'dark', label: '深色', icon: Moon }, { id: 'system', label: '跟随系统', icon: Monitor }].map(({ id, label, icon: Icon }) => <button type="button" key={id} className={cn('theme-option', theme === id && 'is-active')} onClick={() => onTheme(id)} aria-pressed={theme === id}><span className={`theme-preview preview-${id}`}><i /><i /><i /></span><span><Icon size={15} />{label}</span></button>)}</div></div>
    <div className="settings-section"><h3 id="accent-choice-title">重点色</h3><div className="accent-choices" role="group" aria-labelledby="accent-choice-title">{accentPresets.map(preset => <Button key={preset.id} variant="secondary" className={cn('accent-choice', accent === preset.id && 'is-active')} aria-pressed={accent === preset.id} onClick={() => onAccent(preset.id)}><span className="accent-swatch" style={{ background: preset.light.main }} aria-hidden="true" /><span>{preset.label}</span><span className="accent-check" aria-hidden="true">{accent === preset.id && <Check size={12} />}</span></Button>)}</div><p className="accent-help">仅用于操作、选中与焦点；平台和状态颜色保持独立。</p></div>
    <div className="settings-section"><h3>浮层材质</h3><label className="settings-row"><span><strong>减少透明效果</strong><small>使用实色弹窗和菜单，关闭背景模糊。</small></span><input type="checkbox" role="switch" checked={reduceTransparency} onChange={event => onReduceTransparency(event.target.checked)} /></label></div><div className="settings-section"><h3>输入</h3><label className="settings-row"><span><strong>Enter 发送消息</strong><small>关闭后 Enter 换行，通过按钮发送；中文组合输入始终不会触发发送。</small></span><input type="checkbox" role="switch" checked={enterSends} onChange={event => onEnterSends(event.target.checked)} /></label></div>
    <div className="settings-section data-policy"><ShieldCheck size={18} /><div><h3>数据与历史范围</h3><p>{system?.dataPolicy || '只搜索 SnSBox 已同步的历史，不保证获取其他设备的完整记录。各平台账号、会话与草稿独立。'}</p><p>消息正文、草稿和管理密码不会写入浏览器本地存储。</p></div></div>
    <details className="diagnostics"><summary>高级 · 服务与资料状态<ChevronDown size={15} /></summary><div><p>SnSBox {system?.version || '0.1.0'} · {mode === 'demo' ? '界面演示' : '当前服务'}</p><p>{system?.legacyConfig?.message || '资料兼容信息需连接服务后查看。'}</p>{system?.legacyConfig?.configured && <><p>旧资料访问策略：{system.legacyConfig.readOnly ? '只读' : '非只读'}</p><ul>{system.legacyConfig.entries.map(entry => <li key={entry.path}><code>{entry.path}</code><span>{entry.present ? '目录存在' : '未发现'}</span></li>)}</ul><p>目录存在不代表已解密、已登录或可收发消息。</p></>}</div></details>
    <div className="settings-footer"><span>SnSBox {system?.version || '0.1.0'}</span>{mode === 'live' && <Button variant="ghost" size="sm" onClick={onSignOut} disabled={signingOut}><LogOut size={14} />退出 SnSBox</Button>}</div>
  </Modal>
}

export function ConversationInfo({ open, onOpenChange, conversation, account }: { open: boolean; onOpenChange: (value: boolean) => void; conversation?: Conversation; account?: Account }) {
  return <Modal open={open && !!conversation && !!account} onOpenChange={onOpenChange} title="会话信息" description="确认当前身份、历史范围和已知能力。" className="info-modal">{conversation && account && <><div className="info-identity"><Avatar name={conversation.title} group={conversation.kind === 'group'} platform={conversation.platform} size="large" /><h3>{conversation.title}</h3><span><PlatformBadge platform={account.platform} />{account.displayName}</span></div><div className="info-scope"><ShieldCheck size={19} /><div><strong>历史范围</strong><p>{account.historyScope || 'SnSBox 已同步的本地历史；不保证全设备完整记录。'}</p><p>未读仅表示 SnSBox 本地状态，打开会话不代表同步平台已读。</p></div></div><h4 className="info-section-title">会话能力</h4><div className="info-capabilities">{capabilities.map(([name, label]) => { const value = conversation.capabilities?.[name] || account.capabilities[name]; return <div key={name}><span>{label}</span><span className={`capability-text-${value?.status || 'unverified'}`}>{capabilityLabel(value?.status || 'unverified')}</span>{value?.reason && <small>{value.reason}</small>}</div> })}</div><p className="modal-footnote">“上游已接受”只代表接口受理，不等同于对端收到或已读。</p></>}</Modal>
}

export function Authentication({ loading, error, onLogin, onDemo, onRetry }: { loading: boolean; error?: string; onLogin: (password: string) => Promise<void>; onDemo: () => void; onRetry: () => void }) {
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return <main className="authentication-panel"><div className="authentication-card"><span className="authentication-icon"><KeyRound size={27} strokeWidth={1.5} /></span><h2>登录 SnSBox</h2><p>使用部署时设置的管理密码。</p>{loading ? <div className="auth-loading"><LoaderCircle size={21} className="spinning" />正在连接服务…</div> : <form onSubmit={async event => { event.preventDefault(); if (!password || submitting) return; setSubmitting(true); setFormError(''); try { await onLogin(password); setPassword('') } catch (failure) { setFormError(failure instanceof Error ? failure.message : '登录失败'); setPassword('') } finally { setSubmitting(false) } }}><label htmlFor="admin-password">SnSBox 管理密码</label><input type="password" id="admin-password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="输入部署时设置的管理密码" required disabled={submitting} />{(error || formError) && <p className="inline-error" role="alert">{formError || error}</p>}<Button type="submit" disabled={submitting || !password}>{submitting && <LoaderCircle size={16} className="spinning" />}进入消息空间<ArrowUpRight size={16} /></Button>{error && <Button variant="ghost" type="button" onClick={onRetry}>重新连接服务</Button>}</form>}<div className="auth-demo"><span>演示使用合成内容</span><button type="button" onClick={onDemo}>打开界面演示<ArrowUpRight size={13} /></button></div><p className="auth-note"><ShieldCheck size={13} />此处只登录 SnSBox，平台账号在进入后单独连接。</p></div></main>
}
