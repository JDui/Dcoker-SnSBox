import { MessageCircle, Users } from 'lucide-react'
import { cn, initials, platformName, safeMediaUrl } from '../lib/utils'
import type { Platform } from '../lib/types'

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={cn('brand', compact && 'brand-compact')}><span className="brand-mark"><MessageCircle size={25} strokeWidth={1.8} /><span /></span>{!compact && <span>SnSBox<span className="brand-period">.</span></span>}</div>
}
export function PlatformBadge({ platform, compact = false }: { platform: Platform; compact?: boolean }) {
  return <span className={cn('platform-badge', `platform-${platform}`, compact && 'platform-compact')} title={platformName(platform)}>{platform === 'wechat' ? <MessageCircle size={11} fill="currentColor" strokeWidth={0} /> : <span className="qq-mark">Q</span>}{!compact && platformName(platform)}</span>
}
export function Avatar({ name, url, group = false, platform, size = 'normal' }: { name: string; url?: string; group?: boolean; platform?: Platform; size?: 'small' | 'normal' | 'large' }) {
  const safe = safeMediaUrl(url)
  const hue = [...name].reduce((value, char) => value + char.codePointAt(0)!, 0) % 5
  return <span className={cn('avatar', `avatar-${hue}`, `avatar-${size}`, group && 'avatar-group')}>
    {safe ? <img src={safe} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} /> : group ? <Users size={size === 'large' ? 26 : 21} strokeWidth={1.6} /> : <span>{initials(name)}</span>}
    {platform && <span className="avatar-platform"><PlatformBadge platform={platform} compact /></span>}
  </span>
}
