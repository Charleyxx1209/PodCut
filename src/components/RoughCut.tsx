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
import { useState, useMemo, useRef, useEffect, useCallback, memo } from 'react'
import { useProjectStore, type Chunk, type Section, type MoveOp } from '@/store/project'
import { getSpeakerConfig, getSpeakerDisplayName } from '@/lib/speakers'
import { fmt, cappedPush, isTauri } from '@/lib/utils'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove, sortableKeyboardCoordinates
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useVirtualizer } from '@tanstack/react-virtual'

const NO_SECTION = '__none__'

/** 虚拟滚动扁平化条目：章节头 | 对话段落 */
type FlatItem =
  | { type: 'header'; sid: string; section?: Section; sChunks: Chunk[] }
  | { type: 'chunk'; chunk: Chunk; isNewSpeaker: boolean }

export default function RoughCut() {
  const { project, setChunkCutStatus, bulkSetCutStatus, confirmRoughCut, applyMoveOp, setSpeakerName } = useProjectStore()
  const [filter, setFilter] = useState<'all' | 'keep' | 'discard' | 'maybe'>('all')

  // ── 播放器状态 ─────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [curTime, setCurTime] = useState(0)
  const [audioUrl, setAudioUrl] = useState<string | undefined>()
  const animRef = useRef<number>(0)
  const [speed, setSpeed] = useState(1)

  // 音频总时长（用于播放器进度条，需在 audio hooks 之前计算）
  const audioDur = useMemo(() => {
    const chunks = project?.chunks ?? []
    if (!chunks.length) return 137
    return chunks[chunks.length - 1].t_end
  }, [project?.chunks])

  // 加载真实音频（Tauri asset protocol）
  useEffect(() => {
    const path = project?.audio_path
    if (!path || !isTauri()) { setAudioUrl(undefined); return }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      setAudioUrl(convertFileSrc(path))
    }).catch(() => setAudioUrl(undefined))
  }, [project?.audio_path])

  // Mock 模式动画循环
  useEffect(() => {
    if (audioUrl || !playing) return
    let last = performance.now()
    function tick(now: number) {
      const dt = (now - last) / 1000 * speed
      last = now
      setCurTime(t => {
        const next = Math.min(t + dt, audioDur)
        if (next >= audioDur) { setPlaying(false); return audioDur }
        return next
      })
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
  }, [playing, speed, audioDur, audioUrl])

  // 播放速率同步
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  const togglePlay = useCallback(() => {
    if (audioRef.current) {
      if (playing) audioRef.current.pause()
      else audioRef.current.play()
    }
    setPlaying(p => !p)
  }, [playing])

  const seekTo = useCallback((t: number) => {
    setCurTime(t)
    if (audioRef.current) audioRef.current.currentTime = t
  }, [])

  // 键盘快捷键：空格播放/暂停，J/K/L
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      if (e.key === 'j') seekTo(Math.max(0, curTime - 5))
      if (e.key === 'l') seekTo(Math.min(audioDur, curTime + 5))
      if (e.key === 'k') { e.preventDefault(); togglePlay() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [togglePlay, seekTo, curTime, audioDur])

  // 当前播放高亮的 chunk
  const activeChunkId = useMemo(
    () => project?.chunks.find(c => curTime >= c.t_start && curTime < c.t_end)?.id,
    [project?.chunks, curTime]
  )

  // scrollContainerRef 在此声明，auto-scroll 在 virtualizer 之后
  const scrollContainerRef = useRef<HTMLDivElement>(null)

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

  // ── 虚拟滚动（>300 条时启用）────────────────────────────────────────
  const dndEnabled = visible.length <= 300

  const flatItems = useMemo<FlatItem[]>(() => {
    if (dndEnabled) return []          // DnD 路径不需要扁平化
    const items: FlatItem[] = []
    for (const sid of secOrder) {
      const sChunks = secMap[sid]
      if (sid !== NO_SECTION) {
        items.push({ type: 'header', sid, sChunks })
      }
      for (let i = 0; i < sChunks.length; i++) {
        const prev = sChunks[i - 1]
        items.push({ type: 'chunk', chunk: sChunks[i], isNewSpeaker: !prev || prev.speaker !== sChunks[i].speaker })
      }
    }
    return items
  }, [dndEnabled, secOrder, secMap])

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (i) => flatItems[i]?.type === 'header' ? 64 : (flatItems[i] as any)?.isNewSpeaker ? 64 : 36,
    overscan: 20,
    enabled: !dndEnabled,
  })

  // 播放中自动滚动到当前高亮段落（仅切换到新段落时触发）
  useEffect(() => {
    if (!playing || !activeChunkId) return
    // 虚拟滚动模式：通过 index 跳转（DOM 中可能不存在目标行）
    if (flatItems.length > 0) {
      const idx = flatItems.findIndex(item => item.type === 'chunk' && item.chunk.id === activeChunkId)
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' })
      return
    }
    // DnD 模式：直接查 DOM
    const el = scrollContainerRef.current?.querySelector(`[data-chunk-id="${activeChunkId}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeChunkId, playing, flatItems, virtualizer])

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
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>点击保留 / 丢弃 · 右键待定 · 双击播放 · 时间戳跳转</span>
        {foldbackN > 0 && (
          <span style={{ fontSize: '11px', color: 'var(--amber)', fontWeight: 500 }}>
            {foldbackN} 处话题折返
          </span>
        )}
      </div>

      {/* ── 对话正文 ── */}
      <div ref={scrollContainerRef} style={{ flex: 1, overflow: 'auto', paddingBottom: 60 }}>
        {/* 内容栅格：最大宽度限制，居中，大屏不撑满 */}
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {/* 虚拟滚动 vs DnD 两条路径 */}
        {dndEnabled ? (
          /* ≤300 条：DnD 拖拽排序，正常 DOM 渲染 */
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={visible.map(c => c.id)} strategy={verticalListSortingStrategy}>
              {secOrder.map(sid => {
                const sChunks = secMap[sid]
                const section = project.sections.find(s => s.id === sid)
                const isNone = sid === NO_SECTION
                const keptCnt = sChunks.filter(c => c.cut_status !== 'discard').length
                const allDiscarded = sChunks.every(c => c.cut_status === 'discard')
                const allKept = sChunks.every(c => c.cut_status === 'keep')
                const chunkIds = sChunks.map(c => c.id)
                return (
                  <div key={sid}>
                    {!isNone && <SectionHeaderBar section={section} sid={sid} sChunks={sChunks}
                      keptCnt={keptCnt} allKept={allKept} allDiscarded={allDiscarded} chunkIds={chunkIds}
                      bulkSetCutStatus={bulkSetCutStatus} />}
                    <div style={{ padding: '0 28px' }}>
                      {sChunks.map((chunk, i) => {
                        const prev = sChunks[i - 1]
                        const isNewSpk = !prev || prev.speaker !== chunk.speaker
                        const op = moveOpMap[chunk.id]
                        const toSection = op ? project.sections.find(s => s.id === op.to_section) : undefined
                        return <MemoChunkRow key={chunk.id} chunk={chunk} isNewSpeaker={isNewSpk}
                          isPlaying={chunk.id === activeChunkId}
                          foldback={op ? { op, toTitle: toSection?.title ?? op.to_section,
                            onAccept: () => applyMoveOp(chunk.id, 'accepted'),
                            onReject: () => applyMoveOp(chunk.id, 'rejected') } : undefined}
                          onCycle={() => setChunkCutStatus(chunk.id, chunk.cut_status === 'discard' ? 'keep' : 'discard')}
                          onMaybe={() => setChunkCutStatus(chunk.id, 'maybe')}
                          onSeek={() => { seekTo(chunk.t_start); if (!playing) togglePlay() }}
                          speakerDisplayName={getSpeakerDisplayName(chunk.speaker, project.speakerNames)} />
                      })}
                    </div>
                    {!isNone && <div style={{ height: 8 }} />}
                  </div>
                )
              })}
            </SortableContext>
          </DndContext>
        ) : (
          /* >300 条：虚拟滚动，仅渲染可见行 */
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map(vRow => {
              const item = flatItems[vRow.index]
              return (
                <div key={vRow.key} ref={virtualizer.measureElement} data-index={vRow.index}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%',
                           transform: `translateY(${vRow.start}px)` }}>
                  {item.type === 'header' ? (
                    <SectionHeaderBar
                      section={project.sections.find(s => s.id === item.sid)}
                      sid={item.sid} sChunks={item.sChunks}
                      keptCnt={item.sChunks.filter(c => c.cut_status !== 'discard').length}
                      allKept={item.sChunks.every(c => c.cut_status === 'keep')}
                      allDiscarded={item.sChunks.every(c => c.cut_status === 'discard')}
                      chunkIds={item.sChunks.map(c => c.id)}
                      bulkSetCutStatus={bulkSetCutStatus} />
                  ) : (() => {
                    const chunk = item.chunk
                    const op = moveOpMap[chunk.id]
                    const toSection = op ? project.sections.find(s => s.id === op.to_section) : undefined
                    return <MemoPlainChunkRow chunk={chunk} isNewSpeaker={item.isNewSpeaker}
                      isPlaying={chunk.id === activeChunkId}
                      foldback={op ? { op, toTitle: toSection?.title ?? op.to_section,
                        onAccept: () => applyMoveOp(chunk.id, 'accepted'),
                        onReject: () => applyMoveOp(chunk.id, 'rejected') } : undefined}
                      onCycle={() => setChunkCutStatus(chunk.id, chunk.cut_status === 'discard' ? 'keep' : 'discard')}
                      onMaybe={() => setChunkCutStatus(chunk.id, 'maybe')}
                      onSeek={() => { seekTo(chunk.t_start); if (!playing) togglePlay() }}
                      speakerDisplayName={getSpeakerDisplayName(chunk.speaker, project.speakerNames)} />
                  })()}
                </div>
              )
            })}
          </div>
        )}
        </div>{/* end content rail */}
      </div>

      {/* ── 底部播放器栏 ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '0 28px', height: 48, flexShrink: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-raised)',
      }}>
        {/* 播放/暂停 */}
        <button onClick={togglePlay} style={{
          width: 28, height: 28, borderRadius: '50%',
          background: 'var(--text)', color: 'var(--bg)',
          border: 'none', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: '11px',
          cursor: 'pointer', flexShrink: 0,
        }}>
          {playing ? '⏸' : '▶'}
        </button>

        {/* 时间 */}
        <span style={{
          fontSize: '12px', fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-sub)', minWidth: 90, flexShrink: 0,
        }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{fmt(curTime)}</span>
          <span style={{ margin: '0 3px' }}>/</span>
          {fmt(audioDur)}
        </span>

        {/* 进度条 */}
        <div
          style={{ flex: 1, position: 'relative', height: 4, cursor: 'pointer' }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            const t = ((e.clientX - rect.left) / rect.width) * audioDur
            seekTo(t)
          }}
        >
          <div style={{ position: 'absolute', inset: 0, background: 'var(--border)', borderRadius: 2 }} />
          <div style={{
            position: 'absolute', top: 0, left: 0, height: '100%',
            width: `${(curTime / audioDur) * 100}%`,
            background: 'var(--text)', borderRadius: 2,
          }} />
        </div>

        {/* 倍速 */}
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          {[0.75, 1, 1.5, 2].map(s => (
            <button key={s} onClick={() => setSpeed(s)} style={{
              padding: '2px 6px', fontSize: '10px',
              background: speed === s ? 'var(--text)' : 'transparent',
              color: speed === s ? 'var(--bg)' : 'var(--text-muted)',
              border: `1px solid ${speed === s ? 'var(--text)' : 'var(--border)'}`,
              borderRadius: 3, cursor: 'pointer',
            }}>
              {s}x
            </button>
          ))}
        </div>

        {/* 快捷键提示 */}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>
          Space J/K/L
        </span>
      </div>

      {/* 隐藏 audio 元素 */}
      <audio
        ref={audioRef}
        src={audioUrl}
        preload={audioUrl ? 'metadata' : 'none'}
        style={{ display: 'none' }}
        onTimeUpdate={() => {
          const t = audioRef.current?.currentTime ?? 0
          setCurTime(t)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurTime(audioDur) }}
      />
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
function ChunkRow({ chunk, isNewSpeaker, isPlaying, foldback, onCycle, onMaybe, onSeek, speakerDisplayName }: {
  chunk: Chunk
  isNewSpeaker: boolean
  isPlaying?: boolean
  foldback?: { op: MoveOp; toTitle: string; onAccept: () => void; onReject: () => void }
  onCycle: () => void
  onMaybe: () => void
  onSeek?: () => void
  speakerDisplayName: string
}) {
  const cfg = getSpeakerConfig(chunk.speaker)
  const isDiscard = chunk.cut_status === 'discard'
  const isMaybe   = chunk.cut_status === 'maybe'
  const hasFoldback = !!foldback

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chunk.id })

  // callout 样式（折返：amber 左线；待定：默认边框左线；播放中：accent 左线）
  const leftBorder = isPlaying
    ? `2px solid var(--accent)`
    : hasFoldback
    ? `2px solid var(--amber)`
    : isMaybe
    ? `2px solid var(--border-mid)`
    : 'none'

  return (
    <div
      ref={setNodeRef}
      data-chunk-id={chunk.id}
      style={{
        marginTop: isNewSpeaker ? 20 : 0,
        borderLeft: leftBorder,
        paddingLeft: hasFoldback || isMaybe || isPlaying ? 14 : 0,
        opacity: isDragging ? 0.4 : isDiscard ? 0.28 : isMaybe ? 0.65 : 1,
        transition: `opacity 0.18s, ${transition ?? ''}`,
        transform: CSS.Transform.toString(transform),
        background: isPlaying ? 'rgba(217,119,87,0.04)' : hasFoldback ? 'rgba(180,83,9,0.025)' : 'transparent',
        borderRadius: hasFoldback || isPlaying ? '0 4px 4px 0' : 0,
        position: 'relative',
      }}
      {...attributes}
    >
      {/* 点击区域 */}
      <div
        onClick={onCycle}
        onDoubleClick={e => { e.preventDefault(); onSeek?.() }}
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
            <span
              onClick={e => { e.stopPropagation(); onSeek?.() }}
              style={{
                fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums',
                cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              {fmt(chunk.t_start)}
            </span>
            {isPlaying && (
              <span style={{ fontSize: '10px', color: 'var(--accent)' }}>播放中</span>
            )}
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
          color: isDiscard ? 'var(--text-muted)' : isPlaying ? 'var(--text)' : 'var(--text)',
          textDecoration: isDiscard ? 'line-through' : 'none',
          fontWeight: isPlaying ? 500 : 400,
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

// ── 章节标题栏（提取为独立组件，DnD / 虚拟滚动共用）───────────────────
function SectionHeaderBar({ section, sid, sChunks, keptCnt, allKept, allDiscarded, chunkIds, bulkSetCutStatus }: {
  section?: Section; sid: string; sChunks: Chunk[]
  keptCnt: number; allKept: boolean; allDiscarded: boolean; chunkIds: string[]
  bulkSetCutStatus: (ids: string[], status: 'keep' | 'discard' | 'maybe') => void
}) {
  return (
    <div style={{
      padding: '28px 28px 12px',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: '10px',
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
      <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
        {!allKept && (
          <button onClick={() => bulkSetCutStatus(chunkIds, 'keep')} title="全部保留" style={{
            fontSize: '10px', padding: '1px 7px', background: 'var(--green-dim)', color: 'var(--green)',
            border: '1px solid transparent', borderRadius: 4, cursor: 'pointer', fontWeight: 500,
          }}>全部保留</button>
        )}
        {!allDiscarded && (
          <button onClick={() => bulkSetCutStatus(chunkIds, 'discard')} title="全部丢弃" style={{
            fontSize: '10px', padding: '1px 7px', background: 'var(--red-dim)', color: 'var(--red)',
            border: '1px solid transparent', borderRadius: 4, cursor: 'pointer', fontWeight: 500,
          }}>全部丢弃</button>
        )}
      </div>
      <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {keptCnt}/{sChunks.length} 段 · {fmt(sChunks[0].t_start)}–{fmt(sChunks[sChunks.length - 1].t_end)}
      </span>
    </div>
  )
}

// ── 无 DnD 的普通行（chunk 数 > DND_LIMIT 时使用）────────────────────
function PlainChunkRow({ chunk, isNewSpeaker, isPlaying, foldback, onCycle, onMaybe, onSeek, speakerDisplayName }: {
  chunk: Chunk
  isNewSpeaker: boolean
  isPlaying?: boolean
  foldback?: { op: MoveOp; toTitle: string; onAccept: () => void; onReject: () => void }
  onCycle: () => void
  onMaybe: () => void
  onSeek?: () => void
  speakerDisplayName: string
}) {
  const cfg = getSpeakerConfig(chunk.speaker)
  const isDiscard = chunk.cut_status === 'discard'
  const isMaybe   = chunk.cut_status === 'maybe'
  const hasFoldback = !!foldback

  const leftBorder = isPlaying
    ? `2px solid var(--accent)`
    : hasFoldback
    ? `2px solid var(--amber)`
    : isMaybe
    ? `2px solid var(--border-mid)`
    : 'none'

  return (
    <div
      data-chunk-id={chunk.id}
      style={{
        marginTop: isNewSpeaker ? 20 : 0,
        borderLeft: leftBorder,
        paddingLeft: hasFoldback || isMaybe || isPlaying ? 14 : 0,
        opacity: isDiscard ? 0.28 : isMaybe ? 0.65 : 1,
        transition: 'opacity 0.18s',
        background: isPlaying ? 'rgba(217,119,87,0.04)' : hasFoldback ? 'rgba(180,83,9,0.025)' : 'transparent',
        borderRadius: hasFoldback || isPlaying ? '0 4px 4px 0' : 0,
        position: 'relative',
      }}
    >
      {/* 点击区域 */}
      <div
        onClick={onCycle}
        onDoubleClick={e => { e.preventDefault(); onSeek?.() }}
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
            <span
              onClick={e => { e.stopPropagation(); onSeek?.() }}
              style={{
                fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums',
                cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              {fmt(chunk.t_start)}
            </span>
            {isPlaying && (
              <span style={{ fontSize: '10px', color: 'var(--accent)' }}>播放中</span>
            )}
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
          fontWeight: isPlaying ? 500 : 400,
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

// ── React.memo 包裹（避免播放/筛选时 5000 行全量重渲染）─────────────
function chunkRowEqual(prev: any, next: any) {
  return prev.chunk === next.chunk &&
         prev.isPlaying === next.isPlaying &&
         prev.isNewSpeaker === next.isNewSpeaker &&
         prev.speakerDisplayName === next.speakerDisplayName &&
         (prev.foldback == null) === (next.foldback == null)
}
const MemoChunkRow = memo(ChunkRow, chunkRowEqual)
const MemoPlainChunkRow = memo(PlainChunkRow, chunkRowEqual)
