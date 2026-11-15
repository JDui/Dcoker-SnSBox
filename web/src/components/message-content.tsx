import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDownToLine, ArrowUpRight, Check, CircleHelp, FileText, Film, ImageOff, LoaderCircle, PackageOpen, Play, Puzzle, RefreshCw } from 'lucide-react'
import { formatBytes, formatTime, safeExternalUrl, safeMediaUrl } from '../lib/utils'
import type { Message, Segment } from '../lib/types'
import { Avatar } from './identity'
import { Button, Modal } from './ui'

function PlayableMedia({ segment }: { segment: Extract<Segment, { type: 'image' | 'video' | 'sticker' | 'file' | 'audio' }> }) {
  const [failed, setFailed] = useState(false)
  const url = safeMediaUrl(segment.url)
  const poster = safeMediaUrl(segment.thumbnailUrl)
  if (segment.type === 'audio') return url && !failed && !segment.unavailableReason
    ? <audio controls preload="none" src={url} aria-label={segment.name || '语音消息'} onError={() => setFailed(true)} />
    : <div className="unavailable-media"><PackageOpen size={21} /><span>语音消息<small>{segment.unavailableReason || (failed ? '音频加载失败，可稍后重新打开会话' : '音频暂不可用')}</small></span></div>
  return url && !failed && !segment.unavailableReason
    ? <video className="message-video" controls playsInline preload="none" poster={poster} src={url} aria-label={segment.name || '视频'} onError={() => setFailed(true)} />
    : <div className="video-placeholder">{poster && <img src={poster} alt="视频封面" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} />}<span className="video-play"><Play size={23} fill="currentColor" /></span><div><Film size={15} /><span>{segment.name || '视频'}</span></div><small>{segment.unavailableReason || (failed ? '视频加载失败，可稍后重新打开会话' : '视频尚未下载')}</small></div>
}

function FileAttachment({ segment }: { segment: Extract<Segment, { type: 'image' | 'video' | 'sticker' | 'file' | 'audio' }> }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const url = safeMediaUrl(segment.url)
  const name = segment.name || segment.filename || '附件'
  const download = async () => {
    if (!url || loading) return
    setLoading(true); setError(''); controller.current = new AbortController()
    const timer = window.setTimeout(() => controller.current?.abort(), 60_000)
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.current.signal })
      if (!response.ok) throw new Error('附件未能加载，可能已过期或尚未下载。')
      const blob = await response.blob()
      if (blob.size > 32 * 1024 * 1024) throw new Error('附件超过 32 MB 下载上限。')
      const localUrl = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = localUrl; link.download = name; link.click()
      window.setTimeout(() => URL.revokeObjectURL(localUrl), 1000)
    } catch (failure) { if (!controller.current.signal.aborted) setError(failure instanceof Error ? failure.message : '附件下载失败'); else setError('附件下载已中断，请重试。') }
    finally { window.clearTimeout(timer); setLoading(false) }
  }
  const content = <><span className="file-icon"><FileText size={25} strokeWidth={1.5} /></span><span className="file-info"><strong>{name}</strong><small>{error || segment.unavailableReason || formatBytes(segment.size) || '文件附件'}</small></span>{url && !segment.unavailableReason && (loading ? <LoaderCircle size={18} className="spinning" /> : <ArrowDownToLine size={18} />)}</>
  return url && !segment.unavailableReason ? <button type="button" className="file-card file-download" onClick={download} disabled={loading} aria-label={`下载${name}`}>{content}</button> : <div className="file-card is-unavailable">{content}</div>
}

function Picture({ segment }: { segment: Extract<Segment, { type: 'image' | 'video' | 'sticker' | 'file' | 'audio' }> }) {
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const url = safeMediaUrl(segment.url)
  const name = segment.name || segment.filename || (segment.type === 'sticker' ? '表情包' : '图片')
  if (!url || failed || segment.unavailableReason) return <div className="unavailable-media"><ImageOff size={23} /><span>{name}<small>{segment.unavailableReason || '图片暂不可用'}</small></span></div>
  return <><button className={`picture-button ${segment.type === 'sticker' ? 'is-sticker' : ''}`} type="button" onClick={() => setExpanded(true)} aria-label={`查看${name}`}><img className="message-picture" src={url} alt={name} loading="lazy" onError={() => setFailed(true)} /></button>
    <Modal open={expanded} onOpenChange={setExpanded} title={name} description="图片预览" className="image-modal"><img src={url} alt={name} className="expanded-image" /></Modal></>
}

export function SegmentContent({ segment }: { segment: Segment }) {
  if (segment.type === 'text') return <p className="message-text">{segment.text}</p>
  if (segment.type === 'mention') return <span className="mention">{segment.text}</span>
  if (segment.type === 'quote') return <blockquote><strong>{segment.sender}</strong><p>{segment.text}</p></blockquote>
  if (segment.type === 'image' || segment.type === 'sticker') return <Picture segment={segment} />
  if (segment.type === 'video' || segment.type === 'audio') return <PlayableMedia segment={segment} />
  if (segment.type === 'file') return <FileAttachment segment={segment} />
  if (segment.type === 'link' || segment.type === 'miniApp') {
    const url = safeExternalUrl(segment.url)
    const content = <><div className="link-card-type">{segment.type === 'miniApp' ? <Puzzle size={13} /> : <ArrowUpRight size={13} />}<span>{segment.type === 'miniApp' ? segment.appName || '小程序链接' : '分享链接'}</span>{url && <ArrowUpRight size={14} className="link-external" />}</div><strong>{segment.title || '分享内容'}</strong>{(segment.text || segment.description) && <p>{segment.text || segment.description}</p>}<small>{url ? new URL(url).hostname : '没有可安全打开的链接'}</small></>
    return url ? <a className="link-card" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{content}</a> : <div className="link-card is-unavailable">{content}</div>
  }
  return <div className="unknown-segment"><CircleHelp size={17} /><span>{segment.type === 'unknown' ? segment.text : segment.type === 'unsupported' ? segment.label : '暂不支持此消息类型'}</span></div>
}

export function Delivery({ message }: { message: Message }) {
  if (message.direction !== 'outgoing') return null
  const state = message.status
  if (state === 'accepted') return <span className="delivery"><Check size={12} />上游已接受</span>
  if (state === 'queued' || state === 'submitting') return <span className="delivery"><LoaderCircle size={12} className="spinning" />{state === 'queued' ? '排队中' : '提交中'}</span>
  if (state === 'failed') return <span className="delivery delivery-error"><AlertCircle size={12} />发送失败</span>
  if (state === 'uncertain') return <span className="delivery delivery-warning"><CircleHelp size={12} />结果待确认</span>
  if (state === 'demo') return <span className="delivery">演示消息</span>
  return null
}

export function MessageBubble({ message, group, local, onCheck, onDismiss, onJump }: { message: Message; group: boolean; local?: boolean; onCheck?: () => void; onDismiss?: () => void; onJump?: () => void }) {
  const outgoing = message.direction === 'outgoing'
  return <article className={`message-row ${outgoing ? 'outgoing' : 'incoming'}`} data-message-id={message.id}>
    {!outgoing && <Avatar name={message.senderName || '发送者未知'} url={message.avatarUrl} size="small" />}
    <div className="message-stack">{group && !outgoing && <span className="sender-name">{message.senderName || '发送者未知'}</span>}
      <div className={`message-bubble ${message.segments.length === 1 && ['image', 'sticker', 'video'].includes(message.segments[0].type) ? 'media-bubble' : ''}`}>
        {message.segments.map((segment, index) => <SegmentContent key={index} segment={segment} />)}
      </div>
      <div className="message-meta"><time dateTime={message.timestamp || undefined}>{formatTime(message.timestamp)}</time>{!message.direction && <span>方向未知</span>}{!message.senderName && <span>发送者未知</span>}<Delivery message={message} />{onJump && <button type="button" onClick={onJump}>打开会话</button>}</div>
      {(message.error || message.status === 'uncertain') && <p className={`message-error ${message.status === 'uncertain' ? 'is-uncertain' : ''}`}>{message.error || '可能已经提交，请核对历史，避免重复发送。'}</p>}
      {local && ['uncertain', 'failed'].includes(message.status) && <div className="message-actions">{message.status === 'uncertain' && <Button variant="ghost" size="sm" onClick={onCheck}><RefreshCw size={13} />核对历史</Button>}<Button variant="ghost" size="sm" onClick={onDismiss}>{message.status === 'uncertain' ? '已核对，移除提示' : '移除提示'}</Button></div>}
    </div>
  </article>
}
