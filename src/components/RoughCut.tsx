/**
 * RoughCut — 粗剪视图
 *
 * 设计原则（Claude 风格）：
 *  - 颜色仅用于两件事：speaker 识别色（6px 圆点）+ 主操作按钮
 *  - 其余文字全部用 --text / --text-sub / --text-muted 三档灰
 *  - 层级靠字号 + 字重 + 留白，不靠颜色
 *  - 折返标注：左侧 2px amber 竖线 + callout 背景，建议行内嵌在段落下
 *  - 状态反馈：discard = 低透明度 + 删除线，maybe = 中透明度
 */
import { useState, useMemo } from 'react'
import { useProjectStore, type Chunk, type MoveOp } from '@/store/project'
import { getSpeakerConfig, getSpeakerDisplayName } from '@/lib/speakers'
import { fmt, cappedPush } from '@/lib/utils'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove, sortableKeyboardCoordinates
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const NO_SECTION = '__none__'

export default function RoughCut() {
  const { project, setChunkCutStatus, confirmRoughCut, applyMoveOp, setSpeakerName } = useProjectStore()
  const [filter, setFilter] = useState<'all' | 'keep' | 'discard' | 'maybe'>('all')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !project) return
    const chunks = project.chunks
    const oldIdx = chunks.findIndex(c => c.id === active.id)
    const newIdx = chunks.findIndex(c => c.id === over.id)
    useProjectStore.setState(s => ({
      project: s.project ? {
        ...s.project,
        chunks: arrayMove(s.project.chunks, oldIdx, newIdx),
        undo_stack: cappedPush(s.project.undo_stack, chunks),
      } : null
    }))
  }

  // ── Memoised computations (expensive with 5000+ real chunks) ──────
  // All hooks MUST come before any conditional return (Rules of Hooks)
  const chunks = project?.chunks ?? []
  const moveOps = project?.move_ops ?? []

  const stats = useMemo(() => {
    let totalDur = 0, keptDur = 0, keepN = 0, discardN = 0, maybeN = 0
    for (const c of chunks) {
      const d = c.t_end - c.t_start
      totalDur += d
      if (c.cut_status !== 'discard') keptDur += d
      if (c.cut_status === 'keep')    keepN++
      else if (c.cut_status === 'discard') discardN++
      else if (c.cut_status === 'maybe')   maybeN++
    }
    return { totalDur, keptDur, keptPct: totalDur > 0 ? Math.round((keptDur / totalDur) * 100) : 0, keepN, discardN, maybeN }
  }, [chunks])

  const foldbackN = useMemo(
    () => moveOps.filter(o => o.status === 'pending').length,
    [moveOps]
  )

  const moveOpMap = useMemo(() => {
    const map: Record<string, MoveOp> = {}
    for (const op of moveOps) {
      if (op.status === 'pending') map[op.chunk_id] = op
    }
    return map
  }, [moveOps])

  const visible = useMemo(
    () => filter === 'all' ? chunks : chunks.filter(c => c.cut_status === filter),
    [chunks, filter]
  )

  const { secOrder, secMap } = useMemo(() => {
    const order: string[] = []
    const map: Record<string, Chunk[]> = {}
    for (const c of visible) {
      const sid = c.section_id ?? NO_SECTION
      if (!map[sid]) { map[sid] = []; order.push(sid) }
      map[sid].push(c)
    }
    return { secOrder: order, secMap: map }
  }, [visible])

  const speakers = useMemo(
    () => [...new Set(chunks.map(c => c.speaker))].sort(),
    [chunks]
  )

  if (!project) return null

  const { totalDur, keptDur, keptPct, keepN, discardN, maybeN } = stats

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>

      {/* ── 顶栏 ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '16px',
        padding: '0 28px', height: 48,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-raised)', flexShrink: 0,
      }}>
        {/* Speaker 点 + 名（可改名） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {speakers.map(id => (
            <SpeakerLabel key={id} speakerId={id} setSpeakerName={setSpeakerName}
              displayName={getSpeakerDisplayName(id, project.speakerNames)} />
          ))}
        </div>

        <div style={{ width: 1, height: 14, background: 'var(--border)' }} />

        {/* 保留时长 */}
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--text)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{fmt(keptDur)}</span>
          <span style={{ margin: '0 3px' }}>/</span>
          {fmt(totalDur)}
          <span style={{ marginLeft: 6, color: keptPct < 50 ? 'var(--amber)' : 'var(--text-muted)' }}>{keptPct}%</span>
        </span>

        {/* 过滤 tabs */}
        <div style={{ display: 'flex', flex: 1 }}>
          {([
            { k: 'all'     as const, label: '全部',  n: project.chunks.length },
            { k: 'keep'    as const, label: '保留',  n: keepN },
            { k: 'maybe'   as const, label: '待定',  n: maybeN },
            { k: 'discard' as const, label: '丢弃',  n: discardN },
          ]).map(f => (
            <button key={f.k} onClick={() => setFilter(f.k)} style={{
              padding: '0 12px', height: 48, fontSize: '12px',
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: filter === f.k ? 'var(--text)' : 'var(--text-muted)',
              fontWeight: filter === f.k ? 600 : 400,
              borderBottom: filter === f.k ? '2px solid var(--text)' : '2px solid transparent',
              transition: 'color 0.15s',
            }}>
              {f.label}<span style={{ marginLeft: 4, fontSize: '11px' }}>{f.n}</span>
            </button>
          ))}
        </div>

        {/* CTA */}
        <button onClick={confirmRoughCut} style={{
          padding: '7px 18px', fontSize: '12px', fontWeight: 500,
          background: 'var(--text)', color: 'var(--bg)',
          border: 'none', borderRadius: 6, cursor: 'pointer',
          transition: 'opacity 0.15s', whiteSpace: 'nowrap',
        }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          进入精剪 →
        </button>
      </div>

      {/* 操作提示 */}
      <div style={{
        padding: '7px 28px', borderBottom: '1px solid var(--border)',
        display: 'flex', gap: '16px', flexShrink: 0,
      }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>点击保留 / 丢弃 · 右键待定</span>
        {foldbackN > 0 && (
          <span style={{ fontSize: '11px', color: 'var(--amber)', fontWeight: 500 }}>
            {foldbackN} 处话题折返
          </span>
        )}
      </div>

      {/* ── 对话正文 ── */}
      <div style={{ flex: 1, overflow: 'auto', paddingBottom: 60 }}>
        {/* 内容栅格：最大宽度限制，居中，大屏不撑满 */}
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {/* DnD 超过 300 条时禁用（5000+ 条会死锁渲染线程） */}
        {(() => {
          const dndEnabled = visible.length <= 300
          const sectionBody = secOrder.map(sid => {
            const sChunks  = secMap[sid]
            const section  = project.sections.find(s => s.id === sid)
            const isNone   = sid === NO_SECTION
            const keptCnt  = sChunks.filter(c => c.cut_status !== 'discard').length

            return (
              <div key={sid}>
                {/* 章节标题 */}
                {!isNone && (
                  <div style={{
                    padding: '28px 28px 12px',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'baseline', gap: '10px',
                    position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)',
                  }}>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-ui)' }}>
                      {section?.title ?? sid}
                    </span>
                    {section?.keywords.length ? (
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {section.keywords.join(' · ')}
                      </span>
                    ) : null}
                    <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {keptCnt}/{sChunks.length} 段 · {fmt(sChunks[0].t_start)}–{fmt(sChunks[sChunks.length - 1].t_end)}
                    </span>
                  </div>
                )}

                {/* 对话段落 */}
                <div style={{ padding: '0 28px' }}>
                  {sChunks.map((chunk, i) => {
                    const prev = sChunks[i - 1]
                    const isNewSpk = !prev || prev.speaker !== chunk.speaker
                    const op = moveOpMap[chunk.id]
                    const toSection = op ? project.sections.find(s => s.id === op.to_section) : undefined
                    const rowProps = {
                      key: chunk.id,
                      chunk,
                      isNewSpeaker: isNewSpk,
                      foldback: op ? {
                        op,
                        toTitle: toSection?.title ?? op.to_section,
                        onAccept: () => applyMoveOp(chunk.id, 'accepted'),
                        onReject: () => applyMoveOp(chunk.id, 'rejected'),
                      } : undefined,
                      onCycle: () => setChunkCutStatus(chunk.id,
                        chunk.cut_status === 'discard' ? 'keep' : 'discard'),
                      onMaybe: () => setChunkCutStatus(chunk.id, 'maybe'),
                      speakerDisplayName: getSpeakerDisplayName(chunk.speaker, project.speakerNames),
                    }
                    return dndEnabled
                      ? <ChunkRow {...rowProps} />
                      : <PlainChunkRow {...rowProps} />
                  })}
                </div>

                {!isNone && <div style={{ height: 8 }} />}
              </div>
            )
          })

          if (!dndEnabled) return <>{sectionBody}</>
          return (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visible.map(c => c.id)} strategy={verticalListSortingStrategy}>
                {sectionBody}
              </SortableContext>
            </DndContext>
          )
        })()}
        </div>{/* end content rail */}
      </div>
    </div>
  )
}

// ── Speaker 标签（顶栏：色点 + 可改名文字）─────────────────────────
function SpeakerLabel({ speakerId, displayName, setSpeakerName }: {
  speakerId: string
  displayName: string
  setSpeakerName: (id: string, name: string) => void
}) {
  const cfg = getSpeakerConfig(speakerId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setDraft(displayName)
    setEditing(true)
  }
  function commit() {
    setSpeakerName(speakerId, draft.trim() || cfg.name)
    setEditing(false)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      {/* 色点 */}
      <div style={{
        width: 6, height: 6, borderRadius: '50%',
        background: cfg.color, flexShrink: 0, opacity: 0.7,
      }} />
      {editing ? (
        <input
          autoFocus value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); e.stopPropagation() }}
          onClick={e => e.stopPropagation()}
          style={{
            fontSize: '12px', color: 'var(--text)',
            background: 'transparent', border: 'none',
            borderBottom: '1px solid var(--border-mid)',
            outline: 'none', width: 64, padding: '0 1px',
          }}
        />
      ) : (
        <span onClick={startEdit} title="点击改名" style={{
          fontSize: '12px', color: 'var(--text-sub)', cursor: 'text', userSelect: 'none',
        }}>
          {displayName}
        </span>
      )}
    </div>
  )
}

// ── 单条对话行 ──────────────────────────────────────────────────────
function ChunkRow({ chunk, isNewSpeaker, foldback, onCycle, onMaybe, speakerDisplayName }: {
  chunk: Chunk
  isNewSpeaker: boolean
  foldback?: { op: MoveOp; toTitle: string; onAccept: () => void; onReject: () => void }
  onCycle: () => void
  onMaybe: () => void
  speakerDisplayName: string
}) {
  const cfg = getSpeakerConfig(chunk.speaker)
  const isDiscard = chunk.cut_status === 'discard'
  const isMaybe   = chunk.cut_status === 'maybe'
  const hasFoldback = !!foldback

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chunk.id })

  // callout 样式（折返：amber 左线；待定：默认边框左线）
  const leftBorder = hasFoldback
    ? `2px solid var(--amber)`
    : isMaybe
    ? `2px solid var(--border-mid)`
    : 'none'

  return (
    <div
      ref={setNodeRef}
      style={{
        marginTop: isNewSpeaker ? 20 : 0,
        borderLeft: leftBorder,
        paddingLeft: hasFoldback || isMaybe ? 14 : 0,
        opacity: isDragging ? 0.4 : isDiscard ? 0.28 : isMaybe ? 0.65 : 1,
        transition: `opacity 0.18s, ${transition ?? ''}`,
        transform: CSS.Transform.toString(transform),
        background: hasFoldback ? 'rgba(180,83,9,0.025)' : 'transparent',
        borderRadius: hasFoldback ? '0 4px 4px 0' : 0,
        position: 'relative',
      }}
      {...attributes}
    >
      {/* 点击区域 */}
      <div
        onClick={onCycle}
        onContextMenu={e => { e.preventDefault(); onMaybe() }}
        style={{ padding: '4px 0', cursor: 'pointer' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        {/* Speaker + 时间戳（仅在新 speaker 时显示） */}
        {isNewSpeaker && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: 5 }}>
            {/* 色点 */}
            <div style={{
              width: 5, height: 5, borderRadius: '50%',
              background: cfg.color, flexShrink: 0, opacity: 0.6,
            }} />
            <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-sub)' }}>
              {speakerDisplayName}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {fmt(chunk.t_start)}
            </span>
            {isMaybe && (
              <span style={{ fontSize: '10px', color: 'var(--amber)' }}>待定</span>
            )}
            {hasFoldback && (
              <span style={{ fontSize: '10px', color: 'var(--amber)' }}>折返</span>
            )}
          </div>
        )}

        {/* 正文 */}
        <p style={{
          fontSize: '14px', lineHeight: 1.85,
          color: isDiscard ? 'var(--text-muted)' : 'var(--text)',
          textDecoration: isDiscard ? 'line-through' : 'none',
          margin: 0,
          paddingLeft: 12,
        }} className="transcript-text">
          {chunk.text}
        </p>

        {chunk.cut_reason && !isDiscard && (
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '3px 0 0 12px', fontStyle: 'italic' }}>
            {chunk.cut_reason}
          </p>
        )}
      </div>

      {/* 折返建议行（callout 内底部，不单独起行） */}
      {foldback && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '5px 0 8px 12px',
            fontSize: '12px', color: 'var(--text-muted)',
          }}
        >
          <span style={{ flexShrink: 0 }}>↳</span>
          <span>建议移至</span>
          <span style={{ color: 'var(--text-sub)', fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            「{foldback.toTitle}」
          </span>
          <span style={{ fontSize: '11px', flexShrink: 0 }}>
            {Math.round(foldback.op.confidence * 100)}%
          </span>
          <button onClick={foldback.onReject} style={{
            fontSize: '11px', padding: '2px 8px',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0,
          }}>忽略</button>
          <button onClick={foldback.onAccept} style={{
            fontSize: '11px', padding: '2px 8px',
            background: 'var(--text)', border: 'none',
            borderRadius: 5, cursor: 'pointer', color: 'var(--bg)', fontWeight: 500, flexShrink: 0,
          }}>移过去</button>
        </div>
      )}

      {/* 拖拽手柄 */}
      <span
        {...listeners}
        style={{
          position: 'absolute', left: -16, top: '50%',
          transform: 'translateY(-50%)',
          cursor: 'grab', color: 'var(--text-muted)',
          fontSize: '11px', opacity: 0,
          transition: 'opacity 0.15s',
          userSelect: 'none',
        }}
        onMouseEnter={e => (e.currentTarget.style.opacity = '0.5')}
        onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
      >⠿</span>
    </div>
  )
}

// ── 无 DnD 的普通行（chunk 数 > DND_LIMIT 时使用）────────────────────
function PlainChunkRow({ chunk, isNewSpeaker, foldback, onCycle, onMaybe, speakerDisplayName }: {
  chunk: Chunk
  isNewSpeaker: boolean
  foldback?: { op: MoveOp; toTitle: string; onAccept: () => void; onReject: () => void }
  onCycle: () => void
  onMaybe: () => void
  speakerDisplayName: string
}) {
  const cfg = getSpeakerConfig(chunk.speaker)
  const isDiscard = chunk.cut_status === 'discard'
  const isMaybe   = chunk.cut_status === 'maybe'
  const hasFoldback = !!foldback

  const leftBorder = hasFoldback
    ? `2px solid var(--amber)`
    : isMaybe
    ? `2px solid var(--border-mid)`
    : 'none'

  return (
    <div
      style={{
        marginTop: isNewSpeaker ? 20 : 0,
        borderLeft: leftBorder,
        paddingLeft: hasFoldback || isMaybe ? 14 : 0,
        opacity: isDiscard ? 0.28 : isMaybe ? 0.65 : 1,
        transition: 'opacity 0.18s',
        background: hasFoldback ? 'rgba(180,83,9,0.025)' : 'transparent',
        borderRadius: hasFoldback ? '0 4px 4px 0' : 0,
        position: 'relative',
      }}
    >
      {/* 点击区域 */}
      <div
        onClick={onCycle}
        onContextMenu={e => { e.preventDefault(); onMaybe() }}
        style={{ padding: '4px 0', cursor: 'pointer' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        {/* Speaker + 时间戳（仅在新 speaker 时显示） */}
        {isNewSpeaker && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: 5 }}>
            <div style={{
              width: 5, height: 5, borderRadius: '50%',
              background: cfg.color, flexShrink: 0, opacity: 0.6,
            }} />
            <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-sub)' }}>
              {speakerDisplayName}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {fmt(chunk.t_start)}
            </span>
            {isMaybe && (
              <span style={{ fontSize: '10px', color: 'var(--amber)' }}>待定</span>
            )}
            {hasFoldback && (
              <span style={{ fontSize: '10px', color: 'var(--amber)' }}>折返</span>
            )}
          </div>
        )}

        {/* 正文 */}
        <p style={{
          fontSize: '14px', lineHeight: 1.85,
          color: isDiscard ? 'var(--text-muted)' : 'var(--text)',
          textDecoration: isDiscard ? 'line-through' : 'none',
          margin: 0,
          paddingLeft: 12,
        }} className="transcript-text">
          {chunk.text}
        </p>

        {chunk.cut_reason && !isDiscard && (
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '3px 0 0 12px', fontStyle: 'italic' }}>
            {chunk.cut_reason}
          </p>
        )}
      </div>

      {/* 折返建议行 */}
      {foldback && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '5px 0 8px 12px',
            fontSize: '12px', color: 'var(--text-muted)',
          }}
        >
          <span style={{ flexShrink: 0 }}>↳</span>
          <span>建议移至</span>
          <span style={{ color: 'var(--text-sub)', fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            「{foldback.toTitle}」
          </span>
          <span style={{ fontSize: '11px', flexShrink: 0 }}>
            {Math.round(foldback.op.confidence * 100)}%
          </span>
          <button onClick={foldback.onReject} style={{
            fontSize: '11px', padding: '2px 8px',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0,
          }}>忽略</button>
          <button onClick={foldback.onAccept} style={{
            fontSize: '11px', padding: '2px 8px',
            background: 'var(--text)', border: 'none',
            borderRadius: 5, cursor: 'pointer', color: 'var(--bg)', fontWeight: 500, flexShrink: 0,
          }}>移过去</button>
        </div>
      )}
    </div>
  )
}
