/**
 * SpeakerAvatar — 说话人头像组件
 *
 * 头像图案：几何 SVG 纹（非文字），4 种：
 *   slot 0 (s1)：均衡器竖条   — 三条高低不同的柱，代表"主播/主持"
 *   slot 1 (s2)：声波弧线     — 单条 S 形波，代表"嘉宾/声音"
 *   slot 2 (s3)：四点阵       — 2×2 圆点，代表"第三方"
 *   slot 3 (s4)：广播扇弧     — 三段同心弧，代表"第四位"
 */
import { getSpeakerConfig, colorWithAlpha } from '@/lib/speakers'

interface SpeakerAvatarProps {
  speakerId: string
  size?: 'sm' | 'md' | 'lg'
  pulse?: boolean
  showName?: boolean
  namePosition?: 'right' | 'bottom'
  style?: React.CSSProperties
}

const SIZE_PX = { sm: 24, md: 32, lg: 40 } as const
const ICON_PX = { sm: 10, md: 13, lg: 17 } as const  // icon inside circle

// ─── 4 种几何图案 ─────────────────────────────────────────────────────
function PatternEqualizer({ color, size }: { color: string; size: number }) {
  // 三根竖条（均衡器），高度 40 / 100 / 65%
  const s = size
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill={color}>
      <rect x="1"   y="7.5" width="3.5" height="8.5" rx="1.75" />
      <rect x="6.2" y="2"   width="3.5" height="14"  rx="1.75" />
      <rect x="11.5" y="5"  width="3.5" height="11"  rx="1.75" />
    </svg>
  )
}

function PatternWave({ color, size }: { color: string; size: number }) {
  // 单条 S 形声波，fill=none stroke
  const s = size
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeLinecap="round">
      <path
        d="M1 8 C3 3, 6 13, 8 8 C10 3, 13 13, 15 8"
        strokeWidth="2"
      />
    </svg>
  )
}

function PatternDots({ color, size }: { color: string; size: number }) {
  // 2×2 四点阵，稍微内缩
  const s = size
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill={color}>
      <circle cx="4"  cy="4"  r="2.2" />
      <circle cx="12" cy="4"  r="2.2" />
      <circle cx="4"  cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
    </svg>
  )
}

function PatternBroadcast({ color, size }: { color: string; size: number }) {
  // 三段同心扇弧（从右侧散出），fill=none stroke
  const s = size
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeLinecap="round">
      <path d="M5 8 Q8 5 11 8 Q8 11 5 8" strokeWidth="1.4" />
      <path d="M3 5 Q8 1 13 5 Q8 9 3 5" strokeWidth="1.4" opacity="0" />
      {/* 两段扇弧 */}
      <path d="M3.5 4.5 Q8 0.5 12.5 4.5" strokeWidth="1.6" />
      <path d="M5.5 11.5 Q8 15.5 10.5 11.5" strokeWidth="1.6" />
      {/* 中心点 */}
      <circle cx="8" cy="8" r="1.5" fill={color} />
    </svg>
  )
}

const PATTERNS = [PatternEqualizer, PatternWave, PatternDots, PatternBroadcast]

function SpeakerPattern({ speakerId, color, iconSize }: {
  speakerId: string; color: string; iconSize: number
}) {
  const num = parseInt(speakerId.replace(/\D/g, ''), 10) || 1
  const slot = (num - 1) % 4
  const Component = PATTERNS[slot]
  return <Component color={color} size={iconSize} />
}

// ─── 主组件 ───────────────────────────────────────────────────────────
export default function SpeakerAvatar({
  speakerId,
  size = 'md',
  pulse = false,
  showName = false,
  namePosition = 'right',
  style,
}: SpeakerAvatarProps) {
  const cfg = getSpeakerConfig(speakerId)
  const px = SIZE_PX[size]
  const iconSz = ICON_PX[size]

  const avatar = (
    <div
      title={cfg.name}
      style={{ position: 'relative', width: px, height: px, flexShrink: 0 }}
    >
      {/* 脉冲环 */}
      {pulse && (
        <div style={{
          position: 'absolute', inset: -3, borderRadius: '50%',
          border: `2px solid ${colorWithAlpha(cfg.color, 0.4)}`,
          animation: 'speaker-pulse 1.8s ease-in-out infinite',
        }} />
      )}

      {/* 圆形背景 */}
      <div style={{
        width: px, height: px, borderRadius: '50%',
        background: colorWithAlpha(cfg.color, 0.10),
        border: `1.5px solid ${colorWithAlpha(cfg.color, 0.22)}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        userSelect: 'none',
      }}>
        <SpeakerPattern speakerId={speakerId} color={cfg.color} iconSize={iconSz} />
      </div>
    </div>
  )

  if (!showName) return <div style={{ display: 'inline-flex', ...style }}>{avatar}</div>

  return (
    <div style={{
      display: 'inline-flex',
      flexDirection: namePosition === 'bottom' ? 'column' : 'row',
      alignItems: 'center',
      gap: namePosition === 'bottom' ? 4 : 8,
      ...style,
    }}>
      {avatar}
      <span style={{
        fontSize: size === 'lg' ? 13 : 11,
        fontWeight: 500,
        color: cfg.color,
        whiteSpace: 'nowrap',
      }}>
        {cfg.name}
      </span>
    </div>
  )
}

// CSS animation
const STYLE_ID = 'speaker-avatar-styles'
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `@keyframes speaker-pulse {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 0.2; transform: scale(1.15); }
  }`
  document.head.appendChild(el)
}
