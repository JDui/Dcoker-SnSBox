import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleHelp, Clock3, FolderCheck, ImageOff, LoaderCircle, QrCode, RefreshCw, ScanLine, ShieldCheck, X } from 'lucide-react'
import { api } from '../lib/api'
import type { Account, AccountOperation, LoginChallenge } from '../lib/types'
import { accountKey, cn, platformName } from '../lib/utils'
import { Button } from './ui'
import { PlatformBadge } from './identity'

const terminalPhases = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'needs_review'])
export const isOperationTerminal = (value?: Pick<AccountOperation, 'state'> & { phase?: string }) => !!value && (terminalPhases.has(value.phase || '') || value.state === 'blocked' || value.state === 'uncertain')
const phaseLabel = (phase?: string) => ({ queued: '任务已排队', running: '正在处理', awaiting_scan: '等待手机扫码', awaiting_approval: '等待手机确认', succeeded: '任务已完成', failed: '任务未完成', cancelled: '任务已取消', expired: '二维码已过期', needs_review: '需要核对结果' })[phase || ''] || '等待上游状态'

function qrUrl(value: string | null | undefined, accountId: string, operationId: string, generation?: number | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined
  const expected = `/api/v1/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(operationId)}/qr`
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin || url.pathname !== expected || url.hash) return undefined
    if (generation != null) url.searchParams.set('generation', String(generation))
    return url.href
  } catch { return undefined }
}

// v1 normalizes to RFC3339; tolerate Unix seconds in older persisted upstream task snapshots.
function operationExpiry(value?: string | number | null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : NaN
  if (typeof value !== 'string' || !value.trim()) return NaN
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000
  return Date.parse(value)
}

export function AccountOperationPanel({ account, challenge, onUpdate }: { account: Account; challenge: LoginChallenge; onUpdate: (account: Account, operation: AccountOperation) => void }) {
  const client = useQueryClient()
  const operationId = challenge.operationId!
  const queryKey = ['live', 'account-operation', accountKey(account), operationId]
  const operation = useQuery({
    queryKey,
    queryFn: async () => { const result = await api.operation(account.id, operationId); if (result.accountId !== account.id || result.id !== operationId) throw new Error('任务身份不匹配，请刷新账号状态后核对。'); return result },
    retry: false,
    refetchInterval: query => query.state.error || isOperationTerminal(query.state.data) ? false : 2000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: query => !isOperationTerminal(query.state.data),
    refetchOnMount: query => !isOperationTerminal(query.state.data),
  })
  const cancel = useMutation({ mutationFn: () => api.cancelOperation(account.id, operationId), retry: false, onSuccess: () => client.invalidateQueries({ queryKey }) })
  const [now, setNow] = useState(Date.now())
  const [imageFailed, setImageFailed] = useState(false)
  const value = operation.data
  const expiry = operationExpiry(value?.expiresAt)
  const expired = Number.isFinite(expiry) && now >= expiry
  const phase = value?.state === 'uncertain' ? 'needs_review' : expired && !isOperationTerminal(value) ? 'expired' : value?.phase
  const terminal = isOperationTerminal(value)
  const image = value && !operation.error && !expired && !terminal && ['awaiting_scan', 'awaiting_approval'].includes(value.phase) ? qrUrl(value.qrCode, account.id, operationId, value.qrGeneration) : undefined
  useEffect(() => {
    if (!value) return
    onUpdate(account, value)
    if (isOperationTerminal(value)) client.invalidateQueries({ queryKey: ['live', 'accounts'] })
  }, [value, onUpdate, account.id, account.platform, client])
  useEffect(() => { setImageFailed(false) }, [value?.qrGeneration, value?.qrCode])
  useEffect(() => {
    setNow(Date.now())
    if (!Number.isFinite(expiry)) return
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(expiry - Date.now() + 30, 2_147_483_647)))
    return () => window.clearTimeout(timeout)
  }, [expiry])
  return <div className={cn('operation-panel', phase === 'succeeded' && 'operation-succeeded', (value?.state === 'blocked' || value?.state === 'uncertain' || expired) && 'operation-needs-attention')}>
    <div className="operation-heading">{operation.isPending ? <LoaderCircle size={16} className="spinning" /> : phase === 'succeeded' ? <Check size={16} /> : phase === 'awaiting_scan' ? <ScanLine size={16} /> : <Clock3 size={16} />}<strong>{value?.kind === 'logout' ? '退出账号' : '登录账号'} · {phaseLabel(phase)}</strong><Button variant="ghost" size="sm" onClick={() => operation.refetch()} disabled={operation.isFetching}><RefreshCw size={13} />刷新任务</Button></div>
    <p>{operation.error instanceof Error ? operation.error.message : expired ? '此二维码已到期，不会再展示；请先刷新任务确认上游状态，再决定是否发起新登录。' : value?.message || challenge.message || '正在查询上游任务状态。'}</p>
    {image && !imageFailed && <div className="login-qr"><img src={image} alt={`${platformName(account.platform)}登录二维码（仅当前任务）`} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /><div><QrCode size={20} /><strong>{value?.phase === 'awaiting_approval' ? '请在手机上确认' : `使用${platformName(account.platform)}扫码`}</strong><p>二维码仅用于当前账号任务，不会保存在浏览器本地存储。</p>{Number.isFinite(expiry) && <small>有效期至 {new Date(expiry).toLocaleTimeString()}</small>}</div></div>}
    {imageFailed && <div className="qr-unavailable"><ImageOff size={18} />二维码暂时无法读取，请刷新任务；不会自动重新登录。</div>}
    {value?.kind === 'login' && phase === 'succeeded' && <p className="operation-followup">任务完成不代表文本或媒体已验收，账号状态以上方刷新结果为准。</p>}
    {(!terminal || operation.error) && account.platform === 'wechat' && <div className="operation-actions"><Button variant="ghost" size="sm" disabled={cancel.isPending || !value || !!operation.error} onClick={() => cancel.mutate()}><X size={13} />{cancel.isPending ? '请求取消中…' : '取消当前任务'}</Button><span>取消不删除历史或凭据</span></div>}
    {(!terminal || operation.error) && account.platform === 'qq' && <p className="operation-followup">{value?.kind === 'logout' ? '此来源不支持取消任务。关闭面板不会取消退出请求，请刷新状态核对。' : '此来源不支持取消扫码。关闭面板不会取消登录，请等待二维码过期。'}</p>}
    {cancel.error && <p className="inline-error" role="alert">取消结果未确认，请刷新当前任务核对，不会自动重复请求。</p>}
  </div>
}

export function CompatibilityCheck({ enabled }: { enabled: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const result = useQuery({ queryKey: ['live', 'compatibility'], queryFn: api.compatibility, enabled: enabled && expanded, retry: false, staleTime: 60_000 })
  const nextStep = result.data?.nextStep
  return <section className="compatibility-check"><div><span className="compatibility-icon"><FolderCheck size={21} /></span><span><h3>保留已有客户端资料</h3><p>只读检查布局，不导入令牌或接管正在运行的 config。</p></span><Button variant="secondary" size="sm" disabled={!enabled || result.isFetching} onClick={() => { if (expanded) result.refetch(); else setExpanded(true) }}>{result.isFetching ? <LoaderCircle size={14} className="spinning" /> : <ShieldCheck size={14} />}只读预检</Button></div>{expanded && <div className="compatibility-result" role="status">{result.isPending ? <p>正在检查固定目录元数据…</p> : result.error ? <p className="inline-error">{result.error instanceof Error ? result.error.message : '预检未完成'}</p> : <><strong>{result.data?.configured === false ? '尚未配置旧资料只读来源' : result.data?.mode === 'live-source-readonly' ? '检查方式：只读元数据' : '已取得资料预检结果'}</strong>{result.data?.message && <p>{result.data.message}</p>}{result.data?.wechat && <div className="compatibility-platform"><PlatformBadge platform="wechat" /><span>资料目录 {result.data.wechat.profileRoots} · 会话库文件 {result.data.wechat.sessionDatabases} · 消息库文件 {result.data.wechat.messageDatabases}</span><small>尚未尝试解密 · 令牌复用待验证</small></div>}{result.data?.qq && <div className="compatibility-platform"><PlatformBadge platform="qq" /><span>官方资料目录 {result.data.qq.profileRoots}</span><small>官方凭据不直接等同于独立 QQ 服务的登录凭据</small></div>}<p><CircleHelp size={13} />{nextStep === 'exclusive-copy-required' ? '继续接入需要独立、一致且可独占的资料副本，不能直接注册正在运行的原 config。' : nextStep === 'configure-readonly-source' ? '请在部署端配置旧资料只读来源；不会搜索其他个人目录。' : nextStep === 'check-source-mount' ? '来源暂时不可访问，请在部署端检查挂载与权限。' : '请根据服务端预检结果继续配置独立资料空间。'}</p>{result.data?.scanTruncated && <small>本次检查达到有界扫描上限，结果可能不完整。</small>}<small>识别到目录或数据库特征，不代表已解密、已登录或可收发消息。</small></>}</div>}</section>
}
