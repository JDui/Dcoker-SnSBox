import { MessageCircle, Users } from 'lucide-react'
import { cn, initials, platformName, safeMediaUrl } from '../lib/utils'
import type { Platform } from '../lib/types'

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={cn('brand', compact && 'brand-compact')}><span className="brand-mark"><MessageCircle size={25} strokeWidth={1.8} /><span /></span>{!compact && <span>SnSBox<span className="brand-period">.</span></span>}</div>
}
export function PlatformBadge({ platform, compact = false }: { platform: Platform; compact?: boolean }) {
  const name = platformName(platform)
  return <span className={cn('platform-badge', `platform-${platform}`, compact && 'platform-compact')} title={`${name}平台`} role="img" aria-label={`${name}平台`}><PlatformGlyph platform={platform} />{!compact && <span aria-hidden="true">{name}</span>}</span>
}
function PlatformGlyph({ platform }: { platform: Platform }) {
  return platform === 'wechat' ? <svg className="platform-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.9 5.7c-1.3-1.8-3.5-2.8-6-2.8C4.5 2.9 1 5.6 1 9c0 2 1.2 3.7 3 4.8l-.7 2.5L6 14.9c.6.1 1.2.2 1.9.2h.5c-.4-.8-.6-1.7-.6-2.6 0-3.7 3.1-6.6 7.1-6.8Z" fill="currentColor"/><path d="M23 12.6c0-3.1-3-5.6-6.7-5.6s-6.7 2.5-6.7 5.6 3 5.6 6.7 5.6c.6 0 1.2-.1 1.8-.2l2.5 1.4-.6-2.3c1.8-1 3-2.6 3-4.5Z" fill="currentColor"/><path d="M5.8 8h.1m5-0h.1m2.8 4h.1m5-0h.1" stroke="var(--badge-dot, var(--panel))" strokeWidth="1.6" strokeLinecap="round"/></svg> : <svg className="platform-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.1 10C5.7 3.5 9 1.5 12 1.5S18.3 3.5 17.9 10c2.4 2.1 3.3 5.8 1.8 6.1-.6.1-1.1-.5-1.7-1.2-.2 2.3-1.3 4-3 4.8.6.3 1.1.8 1.1 1.3 0 .9-2.4 1.2-4.1.6-1.7.6-4.1.3-4.1-.6 0-.5.5-1 1.1-1.3-1.7-.8-2.8-2.5-3-4.8-.6.7-1.1 1.3-1.7 1.2C2.8 15.8 3.7 12.1 6.1 10Z" fill="currentColor"/><path d="M8.7 10.9c1 .6 5.6.6 6.6 0 2.4 4.2.5 7.4-3.3 7.4s-5.7-3.2-3.3-7.4Z" fill="var(--badge-dot, var(--panel))"/><path d="M9.5 6.7h.1m4.8 0h.1" stroke="var(--badge-dot, var(--panel))" strokeWidth="1.7" strokeLinecap="round"/><path d="m9.5 9 2.5 1 2.5-1" stroke="var(--badge-dot, var(--panel))" strokeWidth="1.1" fill="none"/></svg>
}
export function Avatar({ name, url, group = false, platform, size = 'normal' }: { name: string; url?: string; group?: boolean; platform?: Platform; size?: 'small' | 'normal' | 'large' }) {
  const safe = safeMediaUrl(url)
  const hue = [...name].reduce((value, char) => value + char.codePointAt(0)!, 0) % 5
  return <span className={cn('avatar', `avatar-${hue}`, `avatar-${size}`, group && 'avatar-group')}>
    {safe ? <img src={safe} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} /> : group ? <Users size={size === 'large' ? 26 : 21} strokeWidth={1.6} /> : <span>{initials(name)}</span>}
    {platform && <span className="avatar-platform"><PlatformBadge platform={platform} compact /></span>}
  </span>
}
