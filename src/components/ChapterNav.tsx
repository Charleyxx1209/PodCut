import { useProjectStore } from '@/store/project'
import { getSectionColor } from './TranscriptPanel'

interface ChapterNavProps {
  currentTime?: number
  onJump?: (t: number) => void
  activeSection?: string
  onSectionFilter?: (id: string | undefined) => void
}

function fmt(s: number) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function ChapterNav({ currentTime = 0, onJump, activeSection, onSectionFilter }: ChapterNavProps) {
  const { project } = useProjectStore()
  if (!project || project.sections.length === 0) return null

  const totalDur = project.chunks.length
    ? project.chunks[project.chunks.length - 1].t_end
    : 1

  // 计算每个章节的起始时间和时长
  type SecInfo = {
    id: string; title: string; keywords: string[]
    t_start: number; t_end: number; chunkCount: number
  }
  const secMap: Record<string, SecInfo> = {}
  for (const s of project.sections) {
    const chunks = project.chunks.filter(c => c.section_id === s.id)
    if (!chunks.length) continue
    secMap[s.id] = {
      id: s.id,
      title: s.title,
      keywords: s.keywords,
      t_start: chunks[0].t_start,
      t_end: chunks[chunks.length - 1].t_end,
      chunkCount: chunks.length
    }
  }
  const sections = project.sections.map(s => secMap[s.id]).filter(Boolean)

  // 当前播放所在章节
  const playingSecId = project.chunks.find(
    c => currentTime >= c.t_start && currentTime < c.t_end
  )?.section_id

  return (
    <div style={{
      borderTop: '1px solid var(--border)',
      background: 'var(--bg-raised)',
      flexShrink: 0
    }}>
      {/* 章节时间轴进度条 */}
      <div style={{ position: 'relative', height: '6px', background: 'var(--border)' }}>
        {sections.map(sec => {
          const color = getSectionColor(sec.id)
          const left = (sec.t_start / totalDur) * 100
          const width = ((sec.t_end - sec.t_start) / totalDur) * 100
          return (
            <div
              key={sec.id}
              title={`${sec.title}  ${fmt(sec.t_start)} – ${fmt(sec.t_end)}`}
              onClick={() => onJump?.(sec.t_start)}
              style={{
                position: 'absolute',
                left: `${left}%`, width: `${width}%`, height: '100%',
                background: color?.dot ?? 'var(--border-mid)',
                opacity: activeSection === sec.id ? 1 : (playingSecId === sec.id ? 0.9 : 0.45),
                cursor: 'pointer', transition: 'opacity 0.2s'
              }}
            />
          )
        })}
        {/* 播放游标 */}
        <div style={{
          position: 'absolute',
          left: `${(currentTime / totalDur) * 100}%`,
          top: 0, width: '2px', height: '100%',
          background: 'var(--accent)', transform: 'translateX(-50%)',
          transition: 'left 0.1s linear'
        }} />
      </div>

      {/* 章节列表 */}
      <div style={{
        display: 'flex', gap: '0', overflowX: 'auto',
        padding: '8px 20px',
        scrollbarWidth: 'none'
      }}>
        {/* 全部 Tab */}
        <ChapterTab
          label="全部"
          isActive={!activeSection}
          color={undefined}
          time={undefined}
          duration={undefined}
          isPlaying={false}
          onClick={() => onSectionFilter?.(undefined)}
        />

        {sections.map(sec => {
          const color = getSectionColor(sec.id)
          const isActive = activeSection === sec.id
          const isPlaying = playingSecId === sec.id
          const dur = sec.t_end - sec.t_start
          return (
            <ChapterTab
              key={sec.id}
              label={sec.title}
              isActive={isActive}
              color={color?.dot}
              bg={color?.bg}
              time={fmt(sec.t_start)}
              duration={fmt(dur)}
              isPlaying={isPlaying}
              onClick={() => {
                onSectionFilter?.(isActive ? undefined : sec.id)
                onJump?.(sec.t_start)
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

function ChapterTab({ label, isActive, color, bg, time, duration, isPlaying, onClick }: {
  label: string
  isActive: boolean
  color?: string
  bg?: string
  time?: string
  duration?: string
  isPlaying: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '7px',
        padding: '5px 14px 5px 10px',
        background: isActive ? (bg ?? 'var(--bg-subtle)') : 'transparent',
        border: `1px solid ${isActive ? (color ?? 'var(--border-mid)') : 'transparent'}`,
        borderRadius: '20px',
        cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'all 0.15s', marginRight: '6px',
        flexShrink: 0
      }}
      onMouseEnter={e => {
        if (!isActive) e.currentTarget.style.background = 'var(--bg-subtle)'
      }}
      onMouseLeave={e => {
        if (!isActive) e.currentTarget.style.background = 'transparent'
      }}
    >
      {/* 彩色圆点 */}
      {color && (
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          background: color, flexShrink: 0,
          boxShadow: isPlaying ? `0 0 0 2px ${color}44` : 'none',
          transition: 'box-shadow 0.2s'
        }} />
      )}

      <span style={{
        fontSize: '12px',
        color: isActive ? (color ?? 'var(--text)') : 'var(--text-sub)',
        fontWeight: isActive || isPlaying ? 600 : 400
      }}>
        {label}
      </span>

      {time && (
        <span style={{
          fontSize: '10px', color: isPlaying ? (color ?? 'var(--accent)') : 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums', fontWeight: isPlaying ? 600 : 400
        }}>
          {time}
        </span>
      )}

      {duration && isActive && (
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          {duration}
        </span>
      )}
    </button>
  )
}
