import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useProjectStore, type MusicTrack } from '@/store/project'
import { getSpeakerConfig, getSpeakerDisplayName } from '@/lib/speakers'
import { fmt, isTauri } from '@/lib/utils'
import SpeakerAvatar from './SpeakerAvatar'

// ─── 常量 ──────────────────────────────────────────────
const TRACK_H = 56    // px per speaker track
const LABEL_W = 92    // px for speaker label column

// Mock 波形（预计算，固定随机种子）
const MOCK_WAVE = (() => {
  let seed = 42
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff }
  const N = 1200
  const raw = Array.from({ length: N }, () => 0.18 + rand() * 0.72)
  const smooth = [...raw]
  for (let i = 2; i < N - 2; i++) {
    smooth[i] = (raw[i-2] + raw[i-1] + raw[i] + raw[i+1] + raw[i+2]) / 5
  }
  return smooth
})()

// ─── AudioWorkbench ────────────────────────────────────
interface AudioWorkbenchProps {
  onSeek?: (t: number) => void
  onTimeUpdate?: (t: number) => void
  seekTo?: { t: number; id: number }
}

export default function AudioWorkbench({ onSeek, onTimeUpdate, seekTo }: AudioWorkbenchProps) {
  const { project } = useProjectStore()
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const realWaveRef = useRef<number[] | null>(null)
  const [playing, setPlaying] = useState(false)
  const [curTime, setCurTime] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [audioUrl, setAudioUrl] = useState<string | undefined>()
  // 说话人分轨 URL（精剪时独立播放/静音控制）
  const [trackUrls, setTrackUrls] = useState<Record<string, string>>({})
  // 每个说话人的静音状态
  const [mutedTracks, setMutedTracks] = useState<Record<string, boolean>>({})

  // ── 唯一 speaker 列表（从 chunks 推导）
  const speakers = useMemo(() => {
    if (!project?.chunks.length) return ['s1', 's2']
    return [...new Set(project.chunks.map(c => c.speaker))].sort()
  }, [project?.chunks])

  const totalDur = project?.chunks.length
    ? project.chunks[project.chunks.length - 1].t_end
    : 137

  // ── 真实音频 URL（Tauri asset protocol）
  useEffect(() => {
    const path = project?.audio_path
    if (!path || !isTauri()) { setAudioUrl(undefined); return }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      setAudioUrl(convertFileSrc(path))
    }).catch(() => setAudioUrl(undefined))
  }, [project?.audio_path])

  // ── 分轨 URL（分轨文件就绪后加载）
  useEffect(() => {
    if (!isTauri()) return
    const s1 = project?.track_s1
    const s2 = project?.track_s2
    if (!s1 && !s2) return
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      const urls: Record<string, string> = {}
      if (s1) urls['s1'] = convertFileSrc(s1)
      if (s2) urls['s2'] = convertFileSrc(s2)
      setTrackUrls(urls)
    }).catch(() => {})
  }, [project?.track_s1, project?.track_s2])

  // ── 真实波形（Web Audio API）
  useEffect(() => {
    if (!audioUrl) { realWaveRef.current = null; return }
    let cancelled = false
    let actx: AudioContext | null = null
    fetch(audioUrl)
      .then(r => r.arrayBuffer())
      .then(buf => {
        if (cancelled) return
        actx = new AudioContext()
        return actx.decodeAudioData(buf).then(decoded => {
          if (cancelled) { actx?.close(); actx = null; return }
          const data = decoded.getChannelData(0)
          const N = 1200
          const block = Math.max(1, Math.floor(data.length / N))
          const peaks = Array.from({ length: N }, (_, i) => {
            let max = 0
            for (let j = 0; j < block; j++) {
              const v = Math.abs(data[i * block + j] ?? 0)
              if (v > max) max = v
            }
            return max
          })
          const maxP = Math.max(...peaks, 0.001)
          realWaveRef.current = peaks.map(p => p / maxP)
          actx?.close(); actx = null
        })
      })
      .catch(() => { actx?.close(); actx = null })
    return () => { cancelled = true; actx?.close(); actx = null }
  }, [audioUrl])

  // ── 外部 seek 请求
  useEffect(() => {
    if (seekTo === undefined) return
    setCurTime(seekTo.t)
    if (audioRef.current) audioRef.current.currentTime = seekTo.t
    draw(seekTo.t)
  }, [seekTo])

  // ── 绘制多轨波形
  const draw = useCallback((t: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const chunks = project?.chunks ?? []
    const spks = [...new Set(chunks.map(c => c.speaker))].sort()
    if (!spks.length) return

    const H = spks.length * TRACK_H
    ctx.clearRect(0, 0, W, H)

    const waveData = realWaveRef.current ?? MOCK_WAVE
    const playX = (t / totalDur) * W
    const beepMarks = project?.beepMarks ?? []

    spks.forEach((spkId, row) => {
      const yTop = row * TRACK_H
      const yMid = yTop + TRACK_H / 2
      const cfg = getSpeakerConfig(spkId)
      const spkChunks = chunks.filter(c => c.speaker === spkId)

      // ── speaker 活跃区段背景
      for (const chunk of spkChunks) {
        const x0 = (chunk.t_start / totalDur) * W
        const x1 = (chunk.t_end   / totalDur) * W
        ctx.fillStyle = `rgba(${cfg.rgb}, 0.04)`
        ctx.fillRect(x0, yTop + 2, x1 - x0, TRACK_H - 4)
      }

      // ── 静音段标记（淡灰斜纹底纹，仅在第一行画一次即可）
      if (row === 0) {
        const silences = project?.silences ?? []
        for (const sil of silences) {
          const sx0 = (sil.start / totalDur) * W
          const sx1 = (sil.end   / totalDur) * W
          const sw = Math.max(sx1 - sx0, 1)
          // 淡灰竖纹
          ctx.fillStyle = 'rgba(0,0,0,0.025)'
          ctx.fillRect(sx0, 0, sw, spks.length * TRACK_H)
        }
      }

      // ── 波形条
      for (let i = 0; i < W; i++) {
        const t_i = (i / W) * totalDur
        const inChunk = spkChunks.some(c => t_i >= c.t_start && t_i < c.t_end)
        if (!inChunk) continue
        const wIdx = Math.floor((i / W) * (waveData.length - 1))
        const amp = waveData[wIdx] ?? 0.4
        const barH = Math.max(2, amp * (TRACK_H - 18))
        const played = i < playX
        ctx.fillStyle = played ? `rgba(${cfg.rgb}, 0.80)` : `rgba(${cfg.rgb}, 0.26)`
        ctx.fillRect(i, yMid - barH / 2, 1, barH)
      }

      // ── 消音标记（红色遮罩）
      for (const bm of beepMarks) {
        const chunk = spkChunks.find(c => c.id === bm.chunkId)
        if (!chunk) continue
        const x0 = (bm.tStart / totalDur) * W
        const x1 = (bm.tEnd   / totalDur) * W
        ctx.fillStyle = 'rgba(184,84,80,0.18)'
        ctx.fillRect(x0, yTop + 2, Math.max(x1 - x0, 4), TRACK_H - 4)
        // beep label
        ctx.fillStyle = 'rgba(184,84,80,0.8)'
        ctx.font = '500 8px system-ui, sans-serif'
        ctx.fillText('MUTE', x0 + 2, yMid + 3)
      }

      // ── 行分隔线
      if (row < spks.length - 1) {
        ctx.fillStyle = 'rgba(0,0,0,0.06)'
        ctx.fillRect(0, yTop + TRACK_H - 1, W, 1)
      }
    })

    // ── 播放指针
    ctx.fillStyle = '#d97757'
    ctx.fillRect(playX - 0.75, 0, 1.5, H)
    ctx.beginPath()
    ctx.moveTo(playX - 5, 0); ctx.lineTo(playX + 5, 0); ctx.lineTo(playX, 8)
    ctx.closePath(); ctx.fill()
  }, [project, totalDur, speakers])

  // ── 动画循环（mock 模式）
  useEffect(() => {
    if (audioUrl) { draw(curTime); return }
    if (!playing) { draw(curTime); return }
    let last = performance.now()
    function tick(now: number) {
      const dt = (now - last) / 1000 * speed
      last = now
      setCurTime(t => {
        const next = Math.min(t + dt, totalDur)
        draw(next)
        onTimeUpdate?.(next)
        if (next >= totalDur) { setPlaying(false); return totalDur }
        return next
      })
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
  }, [playing, speed, totalDur, audioUrl])

  // 静止时重绘
  useEffect(() => { draw(curTime) }, [curTime, draw])

  // 播放速率同步
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  // ── 点击 canvas seek
  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const t = ((e.clientX - rect.left) / rect.width) * totalDur
    setCurTime(t)
    onSeek?.(t)
    if (audioRef.current) audioRef.current.currentTime = t
  }

  // ── 播放 / 暂停
  function togglePlay() {
    if (audioRef.current) {
      if (playing) audioRef.current.pause()
      else audioRef.current.play()
    }
    setPlaying(p => !p)
  }

  // ── 快进 / 快退
  function seek(delta: number) {
    setCurTime(t => {
      const next = Math.max(0, Math.min(t + delta, totalDur))
      if (audioRef.current) audioRef.current.currentTime = next
      onSeek?.(next)
      return next
    })
  }

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
  const canvasH = Math.max(TRACK_H, speakers.length * TRACK_H)
  const { setMusicTrack, removeMusicTrack } = useProjectStore()
  const musicTracks = project?.musicTracks ?? {}

  async function handleAddMusic(type: 'intro' | 'outro') {
    let filePath: string | undefined
    let fileName = type === 'intro' ? '片头曲' : '片尾曲'

    if (isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({
          filters: [{ name: '音频', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'] }],
          multiple: false,
        })
        if (!selected) return
        filePath = typeof selected === 'string' ? selected : undefined
        if (filePath) {
          const base = filePath.split('/').pop() ?? filePath
          fileName = base.replace(/\.[^.]+$/, '')
        }
      } catch { /* user cancelled */ return }
    }

    // 获取音频时长
    let dur = 30
    if (filePath && isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        dur = await invoke<number>('get_audio_duration', { path: filePath })
      } catch { /* fallback */ }
    }

    const track: MusicTrack = {
      type, duration: dur,
      fadeIn: type === 'intro' ? 3 : 0,
      fadeOut: type === 'outro' ? 5 : 0,
      title: fileName,
      path: filePath,
    }
    setMusicTrack(track)
  }

  return (
    <div style={{
      background: 'var(--bg-raised)',
      borderBottom: '1px solid var(--border)',
    }}>
      {/* ── 上栏：控制区 ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '16px',
        padding: '10px 20px', borderBottom: '1px solid var(--border)'
      }}>

        {/* 播放控制 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <IconBtn title="后退5秒" onClick={() => seek(-5)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>
            </svg>
          </IconBtn>
          <button onClick={togglePlay} style={{
            width: '32px', height: '32px', borderRadius: '50%',
            background: 'var(--text)', color: 'var(--bg)',
            border: 'none', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '13px',
            transition: 'opacity 0.15s', cursor: 'pointer'
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <IconBtn title="前进5秒" onClick={() => seek(5)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 6v12l8.5-6L13 6zm-2 0l-8.5 6 8.5 6V6z"/>
            </svg>
          </IconBtn>
        </div>

        {/* 时间显示 */}
        <div style={{
          fontSize: '13px', fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-sub)', minWidth: '100px'
        }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{fmt(curTime)}</span>
          <span style={{ margin: '0 4px' }}>/</span>
          {fmt(totalDur)}
        </div>

        {/* 进度条（可点击） */}
        <div style={{ flex: 1, position: 'relative', height: '4px', cursor: 'pointer' }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            const t = ((e.clientX - rect.left) / rect.width) * totalDur
            setCurTime(t); onSeek?.(t)
          }}
        >
          <div style={{ position: 'absolute', inset: 0, background: 'var(--border)', borderRadius: '2px' }} />
          <div style={{
            position: 'absolute', top: 0, left: 0, height: '100%',
            width: `${(curTime / totalDur) * 100}%`,
            background: 'var(--text)', borderRadius: '2px', transition: 'none'
          }} />
        </div>

        {/* 变速 */}
        <div style={{ display: 'flex', gap: '3px' }}>
          {SPEEDS.map(s => (
            <button key={s} onClick={() => setSpeed(s)} style={{
              padding: '3px 7px', fontSize: '11px',
              background: speed === s ? 'var(--text)' : 'transparent',
              color: speed === s ? 'var(--bg)' : 'var(--text-sub)',
              border: '1px solid ' + (speed === s ? 'var(--text)' : 'var(--border)'),
              borderRadius: 'var(--r-sm)', cursor: 'pointer'
            }}>
              {s}×
            </button>
          ))}
        </div>
      </div>

      {/* ── 多轨波形区 ── */}
      <div style={{ padding: '10px 20px 12px' }}>
        {/* 时间刻度（与 canvas 对齐，留出 label 列宽度） */}
        <div style={{
          display: 'flex', paddingLeft: LABEL_W + 8, marginBottom: '6px'
        }}>
          {Array.from({ length: 9 }).map((_, i) => (
            <span key={i} style={{
              flex: 1, fontSize: '10px', color: 'var(--text-muted)',
              textAlign: i === 8 ? 'right' : 'left'
            }}>
              {fmt((i / 8) * totalDur)}
            </span>
          ))}
        </div>

        {/* Label 列 + Canvas */}
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          {/* Speaker 标签列 */}
          <div style={{ width: LABEL_W, flexShrink: 0 }}>
            {speakers.map(spkId => {
              const cfg = getSpeakerConfig(spkId)
              const displayName = getSpeakerDisplayName(spkId, project?.speakerNames)
              const hasSplitTrack = !!trackUrls[spkId]
              const isMuted = !!mutedTracks[spkId]
              return (
                <div key={spkId} style={{
                  height: TRACK_H, display: 'flex', alignItems: 'center', gap: '7px',
                  paddingRight: '8px',
                }}>
                  <SpeakerAvatar speakerId={spkId} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{
                      fontSize: '11px', fontWeight: 500,
                      color: isMuted ? 'var(--text-muted)' : cfg.color,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      display: 'block',
                    }}>
                      {displayName}
                    </span>
                    {hasSplitTrack && (
                      <button
                        onClick={() => setMutedTracks(m => ({ ...m, [spkId]: !m[spkId] }))}
                        title={isMuted ? '取消静音' : '静音此轨'}
                        style={{
                          fontSize: '9px', padding: '1px 5px', marginTop: 2,
                          border: `1px solid ${isMuted ? 'var(--border-mid)' : cfg.color}`,
                          borderRadius: 3, background: 'transparent', cursor: 'pointer',
                          color: isMuted ? 'var(--text-muted)' : cfg.color,
                        }}
                      >
                        {isMuted ? 'M' : '●'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 波形 Canvas */}
          <canvas
            ref={canvasRef}
            width={1200}
            height={canvasH}
            onClick={handleCanvasClick}
            style={{
              flex: 1, height: canvasH,
              cursor: 'crosshair', display: 'block',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--border)',
            }}
          />
        </div>

        {/* ── 配乐轨道 ── */}
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(['intro', 'outro'] as const).map(type => {
            const track = musicTracks[type]
            const label = type === 'intro' ? '片头曲' : '片尾曲'
            const trackW = track ? `${Math.min(100, (track.duration / totalDur) * 100)}%` : '0%'
            const trackOffset = type === 'outro' ? `calc(${100 - Math.min(100, (track?.duration ?? 0) / totalDur * 100)}%)` : '0%'

            return (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                {/* 标签 */}
                <div style={{
                  width: LABEL_W, flexShrink: 0, paddingRight: 8,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>♪</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>
                </div>

                {/* 轨道条 */}
                <div style={{
                  flex: 1, height: 22, borderRadius: 4,
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border)',
                  position: 'relative', overflow: 'hidden',
                }}>
                  {track ? (
                    <>
                      {/* 音乐条 */}
                      <div style={{
                        position: 'absolute', top: 0, bottom: 0,
                        left: trackOffset, width: trackW,
                        background: 'rgba(217,119,87,0.18)',
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}>
                        {/* 淡入渐变 */}
                        <div style={{
                          position: 'absolute', left: 0, top: 0, bottom: 0,
                          width: `${(track.fadeIn / track.duration) * 100}%`,
                          background: 'linear-gradient(to right, transparent, rgba(217,119,87,0.25))',
                        }} />
                        {/* 主体 */}
                        <div style={{
                          position: 'absolute',
                          left: `${(track.fadeIn / track.duration) * 100}%`,
                          right: `${(track.fadeOut / track.duration) * 100}%`,
                          top: 4, bottom: 4,
                          background: 'rgba(217,119,87,0.35)',
                          borderRadius: 2,
                        }} />
                        {/* 淡出渐变 */}
                        <div style={{
                          position: 'absolute', right: 0, top: 0, bottom: 0,
                          width: `${(track.fadeOut / track.duration) * 100}%`,
                          background: 'linear-gradient(to left, transparent, rgba(217,119,87,0.25))',
                        }} />
                        {/* 标题 */}
                        <span style={{
                          position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                          fontSize: 10, color: '#d97757', whiteSpace: 'nowrap', fontWeight: 500,
                        }}>
                          {track.title}
                        </span>
                      </div>
                      {/* 移除按钮 */}
                      <button onClick={() => removeMusicTrack(type)} style={{
                        position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--text-muted)', fontSize: 11, padding: '0 2px',
                        lineHeight: 1,
                      }}>×</button>
                    </>
                  ) : (
                    <button onClick={() => handleAddMusic(type)} style={{
                      width: '100%', height: '100%',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '0 10px', color: 'var(--text-muted)', fontSize: 11,
                    }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                    >
                      <span>+</span>
                      <span>添加{label}</span>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── 敏感词消音 ── */}
      <SensitiveKeywordsBar />

      {/* 真实音频元素 */}
      <audio
        ref={audioRef}
        src={audioUrl}
        preload={audioUrl ? 'metadata' : 'none'}
        style={{ display: 'none' }}
        onTimeUpdate={() => {
          const t = audioRef.current?.currentTime ?? 0
          setCurTime(t)
          onTimeUpdate?.(t)
          draw(t)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurTime(totalDur) }}
      />
    </div>
  )
}

function IconBtn({ children, onClick, title }: {
  children: React.ReactNode; onClick: () => void; title?: string
}) {
  return (
    <button title={title} onClick={onClick} style={{
      width: '28px', height: '28px', borderRadius: 'var(--r-sm)',
      background: 'transparent', border: '1px solid var(--border)',
      color: 'var(--text-sub)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
    }}>
      {children}
    </button>
  )
}

// ── 敏感词消音管理栏 ──────────────────────────────────────────
function SensitiveKeywordsBar() {
  const { project, setSensitiveKeywords, autoMarkBeeps, removeBeepMark } = useProjectStore()
  const [draft, setDraft] = useState('')
  const [lastResult, setLastResult] = useState<string | null>(null)

  if (!project) return null

  const keywords = project.sensitiveKeywords
  const beepCount = project.beepMarks.length

  function addKeyword() {
    const kw = draft.trim()
    if (!kw || keywords.includes(kw)) return
    setSensitiveKeywords([...keywords, kw])
    setDraft('')
  }

  function removeKeyword(kw: string) {
    setSensitiveKeywords(keywords.filter(k => k !== kw))
  }

  function handleAutoMark() {
    const n = autoMarkBeeps()
    setLastResult(n > 0 ? `新增 ${n} 处消音标记` : '未找到新的匹配')
    setTimeout(() => setLastResult(null), 3000)
  }

  function clearAllBeeps() {
    for (const bm of project!.beepMarks) removeBeepMark(bm.id)
  }

  return (
    <div style={{
      padding: '8px 20px 10px',
      borderTop: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: '12px',
      flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
        敏感词消音
      </span>

      {/* 已有关键词标签 */}
      {keywords.map(kw => (
        <span key={kw} style={{
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          padding: '2px 8px', fontSize: '11px',
          background: 'var(--red-dim)', color: 'var(--red)',
          borderRadius: '12px',
        }}>
          {kw}
          <button onClick={() => removeKeyword(kw)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--red)', fontSize: '11px', padding: 0, lineHeight: 1,
          }}>×</button>
        </span>
      ))}

      {/* 输入框 */}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') addKeyword() }}
        placeholder="输入敏感词…"
        style={{
          width: 100, padding: '3px 8px', fontSize: '11px',
          border: '1px solid var(--border)', borderRadius: 4,
          background: 'transparent', color: 'var(--text)',
          outline: 'none',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-mid)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      />
      <button onClick={addKeyword} disabled={!draft.trim()} style={{
        fontSize: '10px', padding: '3px 8px',
        background: draft.trim() ? 'var(--text)' : 'var(--border)',
        color: draft.trim() ? 'var(--bg)' : 'var(--text-muted)',
        border: 'none', borderRadius: 4, cursor: draft.trim() ? 'pointer' : 'default',
      }}>
        添加
      </button>

      {/* 自动标记按钮 */}
      {keywords.length > 0 && (
        <button onClick={handleAutoMark} style={{
          fontSize: '10px', padding: '3px 10px',
          background: 'var(--red-dim)', color: 'var(--red)',
          border: '1px solid transparent', borderRadius: 4,
          cursor: 'pointer', fontWeight: 500,
        }}>
          自动标记
        </button>
      )}

      {/* beep 计数 + 清除 */}
      {beepCount > 0 && (
        <>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {beepCount} 处消音
          </span>
          <button onClick={clearAllBeeps} style={{
            fontSize: '10px', padding: '2px 7px',
            background: 'transparent', color: 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 4,
            cursor: 'pointer',
          }}>
            全部清除
          </button>
        </>
      )}

      {/* 反馈消息 */}
      {lastResult && (
        <span style={{ fontSize: '11px', color: 'var(--green)', fontWeight: 500 }}>
          {lastResult}
        </span>
      )}
    </div>
  )
}
