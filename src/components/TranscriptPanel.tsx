import { useProjectStore, type Chunk } from '@/store/project'
import { useState, useRef, useEffect } from 'react'
import { getSpeakerConfig } from '@/lib/speakers'
import { fmt } from '@/lib/utils'
import SpeakerAvatar from './SpeakerAvatar'
import {
  DndContext, closestCenter,
  KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable, arrayMove
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ─── 章节颜色（印刷质感，低饱和，与 index.css 保持一致）──
// dot = 主色，bg/border 用极淡的 alpha 推导
const SECTION_COLORS: Record<string, { dot: string }> = {
  s1: { dot: '#4A6070' },  // slate ink
  s2: { dot: '#4D6B4D' },  // moss
  s3: { dot: '#6D4D62' },  // warm mauve
  s4: { dot: '#8B6914' },  // ochre
  s5: { dot: '#3D6068' },  // slate teal
  s6: { dot: '#8B3A2F' },  // brick
  s7: { dot: '#4A4A72' },  // dusty indigo
  s8: { dot: '#7A4055' },  // rose ash
}

function hex2rgba(hex: string, alpha: string) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${alpha})`
}

export function getSectionColor(id?: string) {
  if (!id) return null
  const n = parseInt(id.replace(/\D/g, '')) || 1
  const entry = SECTION_COLORS[`s${((n - 1) % 8) + 1}`]
  if (!entry) return null
  const { dot } = entry
  return {
    dot,
    bg: hex2rgba(dot, '0.06'),
    border: hex2rgba(dot, '0.20'),
    text: dot,
  }
}


function highlightText(text: string, query: string) {
  if (!query) return <>{text}</>
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return <>{parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase()
      ? <mark key={i} style={{ background: '#FEF08A', color: 'inherit', borderRadius: '2px' }}>{p}</mark>
      : p
  )}</>
}

// ─── TranscriptPanel ─────────────────────────────────────
export default function TranscriptPanel({
  audioTime = 0,
  onChunkClick,
  sectionFilter
}: {
  audioTime?: number
  onChunkClick?: (t: number) => void
  sectionFilter?: string   // 只显示某章节
}) {
  const { project } = useProjectStore()
  const [query, setQuery] = useState('')
  const chunkRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [matchIndex, setMatchIndex] = useState(0)
  const autoScroll = useRef(true)
  const containerRef = useRef<HTMLDivElement>(null)

  // ALL hooks MUST be called before any conditional return (Rules of Hooks)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  if (!project) return null

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = project!.chunks.findIndex(c => c.id === active.id)
    const newIndex = project!.chunks.findIndex(c => c.id === over.id)
    const snapshot = [...project!.chunks]
    useProjectStore.setState(s => ({
      project: s.project ? {
        ...s.project,
        chunks: arrayMove(s.project.chunks, oldIndex, newIndex),
        undo_stack: [...s.project.undo_stack, snapshot]
      } : null
    }))
  }

  const q = query.trim().toLowerCase()
  const visibleChunks = sectionFilter
    ? project.chunks.filter(c => c.section_id === sectionFilter)
    : project.chunks

  const matchIds = q
    ? visibleChunks.filter(c => c.text.toLowerCase().includes(q)).map(c => c.id)
    : []

  function jumpNext() {
    if (!matchIds.length) return
    const next = (matchIndex + 1) % matchIds.length
    setMatchIndex(next)
    chunkRefs.current[matchIds[next]]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  function jumpPrev() {
    if (!matchIds.length) return
    const prev = (matchIndex - 1 + matchIds.length) % matchIds.length
    setMatchIndex(prev)
    chunkRefs.current[matchIds[prev]]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // 当前播放的 chunk
  const activeChunkId = project.chunks.find(
    c => audioTime >= c.t_start && audioTime < c.t_end
  )?.id

  // 自动滚动
  useEffect(() => {
    if (!autoScroll.current || !activeChunkId) return
    chunkRefs.current[activeChunkId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeChunkId])

  // 按说话人分组连续段落（呈现段落感）
  type Group = { speaker: string; sectionId?: string; chunks: Chunk[] }
  const groups: Group[] = []
  for (const chunk of visibleChunks) {
    const last = groups[groups.length - 1]
    if (last && last.speaker === chunk.speaker && last.sectionId === chunk.section_id) {
      last.chunks.push(chunk)
    } else {
      groups.push({ speaker: chunk.speaker, sectionId: chunk.section_id, chunks: [chunk] })
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      borderRight: '1px solid var(--border)',
      background: 'var(--bg)', overflow: 'hidden',
      flex: 1, minHeight: 0,
    }}>
      {/* 搜索栏 */}
      <div style={{
        display: 'flex', gap: '6px', padding: '10px 16px',
        alignItems: 'center', borderBottom: '1px solid var(--border)',
        background: 'var(--bg)', flexShrink: 0
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setMatchIndex(0) }}
          placeholder="搜索文稿…"
          style={{
            flex: 1, border: 'none', background: 'transparent',
            color: 'var(--text)', fontSize: '13px', outline: 'none'
          }}
        />
        {matchIds.length > 0 && (
          <>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {matchIndex + 1} / {matchIds.length}
            </span>
            <NavBtn onClick={jumpPrev}>↑</NavBtn>
            <NavBtn onClick={jumpNext}>↓</NavBtn>
          </>
        )}
        {q && !matchIds.length && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>无结果</span>
        )}
      </div>

      {/* 逐字稿滚动区 */}
      <div ref={containerRef} style={{ flex: 1, overflowY: 'auto', padding: '0 24px 32px', minHeight: 0 }}>
        {/* 内容栅格：最大宽度，居中 */}
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleChunks.map(c => c.id)} strategy={verticalListSortingStrategy}>
            {groups.map((group, gi) => (
              <SpeakerGroup
                key={`${group.speaker}-${gi}`}
                group={group}
                matchIds={matchIds}
                currentMatchId={matchIds[matchIndex]}
                activeChunkId={activeChunkId}
                searchQuery={q}
                chunkRefs={chunkRefs}
                onSeekClick={onChunkClick}
              />
            ))}
          </SortableContext>
        </DndContext>
        </div>{/* end content rail */}
      </div>
    </div>
  )
}

// ─── 说话人段落组 ─────────────────────────────────────────
function SpeakerGroup({ group, matchIds, currentMatchId, activeChunkId, searchQuery, chunkRefs, onSeekClick }: {
  group: { speaker: string; sectionId?: string; chunks: Chunk[] }
  matchIds: string[]
  currentMatchId?: string
  activeChunkId?: string
  searchQuery: string
  chunkRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  onSeekClick?: (t: number) => void
}) {
  const project = useProjectStore(s => s.project)
  const isGroupActive = group.chunks.some(c => c.id === activeChunkId)

  // 自定义名称支持
  const cfg = getSpeakerConfig(group.speaker)
  const displayName = project?.speakerNames?.[group.speaker] ?? cfg.name

  return (
    <div style={{ paddingTop: '20px' }}>
      {/* 说话人行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <SpeakerAvatar speakerId={group.speaker} size="sm" pulse={isGroupActive} />
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: isGroupActive ? cfg.color : 'var(--text-sub)',
          transition: 'color 0.2s'
        }}>
          {displayName}
        </span>
        {/* 时间戳 */}
        <span
          onClick={() => onSeekClick?.(group.chunks[0].t_start)}
          style={{
            fontSize: '11px', color: 'var(--text-muted)',
            cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
            marginLeft: 'auto'
          }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
        >
          {fmt(group.chunks[0].t_start)}
        </span>
      </div>

      {/* 段落内的逐块 */}
      {group.chunks.map(chunk => (
        <SortableChunk
          key={chunk.id}
          chunk={chunk}
          isMatch={matchIds.includes(chunk.id)}
          isCurrent={currentMatchId === chunk.id}
          isPlaying={chunk.id === activeChunkId}
          searchQuery={searchQuery}
          chunkRefs={chunkRefs}
          onSeekClick={() => onSeekClick?.(chunk.t_start)}
        />
      ))}
    </div>
  )
}

// ─── 单个可拖拽语义块 ─────────────────────────────────────
function SortableChunk({ chunk, isMatch, isCurrent, isPlaying, searchQuery, chunkRefs, onSeekClick }: {
  chunk: Chunk
  isMatch?: boolean
  isCurrent?: boolean
  isPlaying?: boolean
  searchQuery: string
  chunkRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  onSeekClick?: () => void
}) {
  const { project, addBeepMark, removeBeepMark } = useProjectStore()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chunk.id })
  const [hovered, setHovered] = useState(false)

  const beepMark = project?.beepMarks.find(b => b.chunkId === chunk.id)
  const isMisplaced = project?.move_ops.some(op => op.chunk_id === chunk.id && op.status === 'pending')
  const op = project?.move_ops.find(o => o.chunk_id === chunk.id && o.status === 'pending')
  const confidence = op?.confidence ?? 0

  function toggleBeep() {
    if (beepMark) {
      removeBeepMark(beepMark.id)
    } else {
      addBeepMark({
        chunkId: chunk.id,
        text: chunk.text,
        tStart: chunk.t_start,
        tEnd: chunk.t_end,
      })
    }
  }

  const dndStyle = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }

  return (
    <div
      ref={el => { setNodeRef(el); chunkRefs.current[chunk.id] = el }}
      style={dndStyle}
      {...attributes}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{
        position: 'relative', paddingLeft: '12px', marginBottom: '2px',
        borderLeft: isPlaying
          ? '2px solid var(--accent)'
          : beepMark
          ? '2px solid var(--red)'
          : isMisplaced
          ? `2px solid ${confidence > 0.85 ? 'var(--red)' : 'var(--amber)'}`
          : '2px solid transparent',
        transition: 'border-color 0.2s'
      }}>
        {/* 搜索命中高亮背景 */}
        {(isMatch || isPlaying) && (
          <div style={{
            position: 'absolute', inset: '-2px -4px',
            background: isCurrent ? 'rgba(217,119,87,0.12)' : isPlaying ? 'rgba(217,119,87,0.06)' : 'rgba(217,119,87,0.08)',
            borderRadius: 'var(--r-sm)', zIndex: 0, transition: 'background 0.2s'
          }} />
        )}

        {/* 文本 */}
        <p
          className="transcript-text selectable"
          onClick={onSeekClick}
          style={{
            position: 'relative', zIndex: 1,
            fontSize: '15px', lineHeight: 1.9,
            color: isPlaying ? 'var(--text)' : beepMark ? 'var(--text-muted)' : 'var(--text-sub)',
            margin: 0, cursor: 'pointer',
            fontWeight: isPlaying ? 500 : 400,
            textDecoration: beepMark ? 'line-through' : 'none',
            transition: 'color 0.2s',
          }}
          onMouseEnter={e => { if (!beepMark) e.currentTarget.style.color = 'var(--text)' }}
          onMouseLeave={e => { if (!beepMark) e.currentTarget.style.color = isPlaying ? 'var(--text)' : 'var(--text-sub)' }}
        >
          {highlightText(chunk.text, searchQuery)}
        </p>

        {/* beep 标签 */}
        {beepMark && (
          <span style={{
            position: 'absolute', right: 24, top: '4px',
            fontSize: '10px', color: 'var(--red)',
            background: 'var(--red-dim)', padding: '1px 6px',
            borderRadius: 10, fontWeight: 500, letterSpacing: '0.02em',
          }}>MUTE</span>
        )}

        {/* Hover 操作按钮 */}
        {hovered && (
          <button
            onClick={e => { e.stopPropagation(); toggleBeep() }}
            title={beepMark ? '取消消音' : '标记消音'}
            style={{
              position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: '10px', fontWeight: 500,
              color: beepMark ? 'var(--red)' : 'var(--text-muted)',
              padding: '2px 6px', zIndex: 2,
            }}
          >
            {beepMark ? '×' : 'M'}
          </button>
        )}

        {/* 拖拽手柄 */}
        <span {...listeners} style={{
          position: 'absolute', left: '-18px', top: '50%',
          transform: 'translateY(-50%)',
          cursor: 'grab', color: 'var(--text-muted)',
          fontSize: '11px', opacity: hovered ? 0.5 : 0,
          transition: 'opacity 0.15s'
        }}>⠿</span>
      </div>
    </div>
  )
}

function NavBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: '1px solid var(--border)',
      borderRadius: 'var(--r-sm)', padding: '2px 7px',
      fontSize: '11px', color: 'var(--text-sub)', cursor: 'pointer'
    }}>
      {children}
    </button>
  )
}
