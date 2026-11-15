import { useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, ChevronDown, File, Film, ImagePlus, LoaderCircle, Paperclip, ShieldCheck, Smile, Sticker, X } from 'lucide-react'
import type { Account, Conversation, Draft, DraftAttachment, Mode } from '../lib/types'
import { capability, capabilityLabel, cn, formatBytes, platformName } from '../lib/utils'
import { Button, IconButton, Menu, MenuItem } from './ui'

const emojis = ['😊', '👍', '❤️', '🎉', '☀️', '🌿', '☕', '📷', '✨', '🙏', '👋', '👌']
export function Composer({ account, conversation, draft, mode, busy, blocked, enterSends, onChange, onSend, onFile, onRemoveFile, onEnterSendsChange }: {
  account: Account; conversation: Conversation; draft: Draft; mode: Mode; busy: boolean; blocked: boolean; enterSends: boolean
  onChange: (value: string) => void; onSend: () => void; onFile: (file: File, kind: DraftAttachment['kind']) => void; onRemoveFile: (id: string) => void; onEnterSendsChange: (value: boolean) => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileKind = useRef<DraftAttachment['kind']>('file')
  const composing = useRef(false)
  const compositionEnded = useRef(0)
  const [fileError, setFileError] = useState('')
  const attachment = draft.attachments[0]
  const textBytes = new TextEncoder().encode(draft.text.trim()).length
  const textTooLong = !attachment && textBytes > 16_384
  const activeCapability = capability(account, conversation, attachment?.kind || 'text')
  const available = account.status === 'online' && ['supported', 'unverified'].includes(activeCapability.status)
  const sendable = available && !busy && !blocked && !textTooLong && (!!draft.text.trim() || !!attachment)
  const unverified = activeCapability.status === 'unverified' && mode === 'live'
  const disabledReason = blocked ? '上一条发送结果待确认，请先核对历史。' : account.status !== 'online' ? '账号当前未在线，连接后可发送。' : !available ? activeCapability.reason || `此账号${capabilityLabel(activeCapability.status)}发送此类消息` : undefined
  const chooseFile = (kind: DraftAttachment['kind']) => {
    fileKind.current = kind
    if (!fileRef.current) return
    fileRef.current.accept = kind === 'image' ? 'image/*' : kind === 'sticker' ? 'image/gif,image/webp,image/png' : kind === 'video' ? 'video/*' : '*/*'
    fileRef.current.click()
  }
  const canAttach = (kind: DraftAttachment['kind']) => account.status === 'online' && ['supported', 'unverified'].includes(capability(account, conversation, kind).status) && !busy && !attachment && !blocked
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || !enterSends) return
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || Date.now() - compositionEnded.current < 120) return
    event.preventDefault()
    if (event.repeat) return
    if (sendable) onSend()
  }
  return <section className="composer-wrap" aria-label="消息输入区">
    {disabledReason && <div className="composer-notice" role="status">{disabledReason}</div>}
    {unverified && available && !blocked && <div className="composer-notice verification-notice"><ShieldCheck size={14} />此能力待真实账号验证，点击“验证发送”会实际提交给{platformName(account.platform)}。</div>}
    <div className={cn('composer', busy && 'composer-busy')}>
      <div className="composer-toolbar">
        <div className="composer-tools"><Menu label="添加表情" trigger={<Smile size={20} />}>
          <div className="emoji-grid" aria-label="表情">{emojis.map(emoji => <MenuItem key={emoji} onSelect={() => { onChange(draft.text + emoji); inputRef.current?.focus() }} disabled={!available || busy || !!attachment}>{emoji}</MenuItem>)}</div>
        </Menu>
          <IconButton label={`添加图片 · ${capabilityLabel(capability(account, conversation, 'image').status)}`} disabled={!canAttach('image')} onClick={() => chooseFile('image')}><ImagePlus size={20} /></IconButton>
          <Menu label="添加附件" trigger={<Paperclip size={20} />}>
            <MenuItem disabled={!canAttach('video')} onSelect={() => chooseFile('video')}><Film size={17} />视频<span>{capabilityLabel(capability(account, conversation, 'video').status)}</span></MenuItem>
            <MenuItem disabled={!canAttach('file')} onSelect={() => chooseFile('file')}><File size={17} />文件<span>{capabilityLabel(capability(account, conversation, 'file').status)}</span></MenuItem>
            <MenuItem disabled={!canAttach('sticker')} onSelect={() => chooseFile('sticker')}><Sticker size={17} />表情包<span>{capabilityLabel(capability(account, conversation, 'sticker').status)}</span></MenuItem>
          </Menu>
        </div>
        <span className="composer-identity"><span className={`tiny-dot dot-${account.platform}`} />{account.displayName}</span>
      </div>
      <input ref={fileRef} type="file" className="visually-hidden" tabIndex={-1} onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        if (file.size > 32 * 1024 * 1024) { setFileError('附件最大为 32 MB，请选择更小的文件。'); return }
        const kind = fileKind.current
        if ((kind === 'image' || kind === 'sticker') && !file.type.startsWith('image/') || kind === 'video' && !file.type.startsWith('video/')) { setFileError('文件类型与所选附件类型不匹配。'); return }
        setFileError(''); onFile(file, kind)
      }} />
      {attachment && <div className="draft-attachment">{attachment.preview && attachment.kind !== 'video' ? <img src={attachment.preview} alt="待发送附件" /> : <File size={25} />}<span><strong>{attachment.file.name}</strong><small>{formatBytes(attachment.file.size)} · 附件将单独发送，文字草稿保留</small></span><IconButton label="移除附件" disabled={busy} onClick={() => onRemoveFile(attachment.id)}><X size={16} /></IconButton></div>}
      <textarea ref={inputRef} aria-label={`向${conversation.title}发送消息`} placeholder={attachment ? '附件将单独发送；你的文字草稿会保留' : mode === 'demo' ? '输入演示消息…' : available ? `发送给${conversation.title}…` : '账号在线后可发送消息'} value={draft.text} onChange={event => onChange(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = Date.now() }} onKeyDown={keyDown} disabled={!available || !!attachment} rows={2} maxLength={20_000} />
      {(fileError || textTooLong) && <p className="inline-error" role="alert">{fileError || `文字超过 16 KB 上限（当前 ${(textBytes / 1024).toFixed(1)} KB），请分段发送。中文按 UTF-8 字节计算。`}</p>}
      <div className="composer-bottom"><Menu label="发送快捷键" trigger={<span className="shortcut-trigger">{enterSends ? 'Enter 发送，Shift + Enter 换行' : 'Enter 换行，点击按钮发送'}<ChevronDown size={12} /></span>}>
        <MenuItem onSelect={() => onEnterSendsChange(true)}>{enterSends ? '✓ ' : ''}Enter 发送</MenuItem><MenuItem onSelect={() => onEnterSendsChange(false)}>{!enterSends ? '✓ ' : ''}Enter 换行</MenuItem>
      </Menu><Button className="send-button" onClick={onSend} disabled={!sendable} aria-label={mode === 'demo' ? '发送演示消息' : unverified ? '验证发送' : '发送消息'}>{busy ? <LoaderCircle size={17} className="spinning" /> : <ArrowUp size={18} />}{mode === 'demo' ? '演示发送' : unverified ? '验证发送' : '发送'}</Button></div>
    </div>
    <p className="composer-footnote">{mode === 'demo' ? '演示消息仅留在当前页面，不会发送至任何平台' : 'SnSBox 本地历史 · 账号与会话独立'}</p>
  </section>
}
