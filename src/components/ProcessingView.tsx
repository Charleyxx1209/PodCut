import { useEffect, useRef } from 'react'
import { useProjectStore } from '@/store/project'
import { getSpeakerConfig } from '@/lib/speakers'
import SpeakerAvatar from './SpeakerAvatar'

function fmt(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function ProcessingView() {
  const { project, skipToRoughCut } = useProjectStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── ALL hooks BEFORE any conditional return (Rules of Hooks) ──────
  const chunks_partial = project?.chunks_partial ?? []

  // 自动滚到最新一条
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chunks_partial.length])

  if (!project) return null

  const {
    stage, chunks, transcription_progress,
    total_duration_seconds, transcription_error,
    model_status, model_download_ratio, analysis_status,
  } = project

  const processedSec = total_duration_seconds * transcription_progress
  const pct = Math.round(transcription_progress * 100)
  const isExtracting = stage === 'extracting'
  const isAnalyzing  = stage === 'analyzing'

  // Analyzing stage: simple full-screen status
  if (isAnalyzing) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)', gap: '16px',
      }}>
        <Spinner />
        <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text)' }}>
          {analysis_status ?? 'AI 正在分析话题结构…'}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          已合并 {chunks.length} 段对话，正在识别章节与折返点
        </span>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>

      {/* ── 顶部进度区 ── */}
      <div style={{
        padding: '18px 32px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-raised)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Spinner />
            <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>
              {isExtracting ? '提取音频…' : 'AI 转写中…'}
            </span>
            {!isExtracting && total_duration_seconds > 0 && (
              <span style={{
                fontSize: '12px', color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums'
              }}>
                {fmt(processedSec)} / {fmt(total_duration_seconds)}
              </span>
            )}
          </div>

          {chunks_partial.length > 0 && (
            <button
              onClick={skipToRoughCut}
              style={{
                fontSize: '12px', color: 'var(--text-muted)',
                background: 'none', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', padding: '4px 12px',
                cursor: 'pointer', transition: 'color 0.15s'
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              跳过，使用已有结果 →
            </button>
          )}
        </div>

        {/* 进度条 */}
        <div style={{ height: '2px', background: 'var(--border)', borderRadius: '1px', overflow: 'hidden' }}>
          {isExtracting ? (
            <div style={{
              height: '100%', width: '30%', background: 'var(--accent)',
              borderRadius: '1px', animation: 'progress-scan 1.4s ease-in-out infinite'
            }} />
          ) : (
            <div style={{
              height: '100%', width: `${pct}%`,
              background: 'var(--accent)', borderRadius: '1px', transition: 'width 0.6s ease'
            }} />
          )}
        </div>

        {!isExtracting && (
          <div style={{
            marginTop: '5px', display: 'flex', justifyContent: 'space-between',
            fontSize: '11px', color: 'var(--text-muted)'
          }}>
            <span>
              {chunks_partial.length === 0
                ? '正在加载 AI 模型，首次约需 30–60 秒…'
                : `${pct}% · 已识别 ${chunks_partial.length} 段`}
            </span>
            {pct > 0 && total_duration_seconds > 0 && (
              <ETA progress={transcription_progress} totalSeconds={total_duration_seconds} />
            )}
          </div>
        )}

        {/* 模型下载进度（蓝色信息条） */}
        {model_status && (
          <div style={{
            marginTop: '12px', padding: '10px 14px',
            background: 'rgba(37, 99, 235, 0.06)',
            border: '1px solid rgba(37, 99, 235, 0.2)',
            borderRadius: 'var(--r-sm)',
          }}>
            <div style={{ fontSize: '12px', color: '#2563EB', marginBottom: '6px' }}>
              ⬇ {model_status}
            </div>
            <div style={{ height: '3px', background: 'rgba(37, 99, 235, 0.15)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${Math.round((model_download_ratio ?? 0) * 100)}%`,
                background: '#2563EB', borderRadius: '2px', transition: 'width 0.5s ease',
              }} />
            </div>
          </div>
        )}

        {/* 错误提示 + 重试按钮 */}
        {transcription_error && (
          <div style={{
            marginTop: '12px', padding: '10px 14px',
            background: 'rgba(220, 38, 38, 0.05)',
            border: '1px solid rgba(220, 38, 38, 0.25)',
            borderRadius: 'var(--r-sm)',
            fontSize: '12px', color: '#dc2626',
            lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {transcription_error}
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button
                onClick={() => {
                  // 清除错误 + 重置 partial + 回到 idle → 触发 Workspace 重新启动转写
                  useProjectStore.setState(s => ({
                    project: s.project ? {
                      ...s.project,
                      transcription_error: undefined,
                      transcription_progress: 0,
                      chunks_partial: [],
                      stage: 'idle' as const,
                    } : null
                  }))
                }}
                style={{
                  padding: '5px 14px', fontSize: '12px', fontWeight: 500,
                  background: 'var(--text)', color: 'var(--bg)',
                  border: 'none', borderRadius: 5, cursor: 'pointer',
                }}
              >
                重试
              </button>
              {project.chunks_partial.length > 0 && (
                <button
                  onClick={skipToRoughCut}
                  style={{
                    padding: '5px 14px', fontSize: '12px',
                    background: 'transparent', color: 'var(--text-sub)',
                    border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer',
                  }}
                >
                  使用已有结果
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 流式转写内容区 ── */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', padding: '0 32px 32px' }}
      >
        {chunks_partial.length === 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '200px', color: 'var(--text-muted)', fontSize: '13px'
          }}>
            {isExtracting ? '音频提取完成后开始转写…' : '转写结果将实时出现在这里'}
          </div>
        ) : (
          chunks_partial.map((chunk, i) => {
            const prevSpeaker = i > 0 ? chunks_partial[i - 1].speaker : null
            const isNewSpeaker = chunk.speaker !== prevSpeaker
            const isLast = i === chunks_partial.length - 1

            return (
              <div
                key={chunk.id}
                style={{
                  display: 'flex', gap: '14px',
                  padding: isNewSpeaker ? '16px 0 8px' : '4px 0 8px',
                  animation: isLast ? 'chunk-slide-in 0.2s ease' : 'none',
                }}
              >
                {/* 头像列 — 只在 Speaker 切换时显示，其他行空出位置保持对齐 */}
                <div style={{ width: 32, flexShrink: 0, paddingTop: '2px' }}>
                  {isNewSpeaker ? (
                    <SpeakerAvatar
                      speakerId={chunk.speaker}
                      size="md"
                      pulse={isLast && transcription_progress < 1}
                    />
                  ) : (
                    // 同一 Speaker 连续时，左侧细线
                    <div style={{
                      width: 1.5, height: '100%', minHeight: 20,
                      background: 'var(--border)', margin: '0 auto',
                      borderRadius: '1px',
                    }} />
                  )}
                </div>

                {/* 内容 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isNewSpeaker && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      marginBottom: '5px'
                    }}>
                      <SpeakerName speakerId={chunk.speaker} />
                      <span style={{
                        fontSize: '11px', color: 'var(--text-muted)',
                        fontVariantNumeric: 'tabular-nums'
                      }}>
                        {fmt(chunk.t_start)}
                      </span>
                    </div>
                  )}
                  <p style={{
                    fontSize: '14px', lineHeight: 1.75,
                    color: 'var(--text-sub)', margin: 0
                  }}>
                    {chunk.text}
                  </p>
                </div>
              </div>
            )
          })
        )}

        {/* 输入光标 */}
        {chunks_partial.length > 0 && transcription_progress < 1 && (
          <div style={{ padding: '4px 0 4px 46px' }}>
            <span style={{
              display: 'inline-block', width: 2, height: 16,
              background: 'var(--text-muted)',
              animation: 'blink 1s step-end infinite',
              verticalAlign: 'middle', borderRadius: '1px',
            }} />
          </div>
        )}
      </div>
    </div>
  )
}

// Speaker 名称标签（尊重用户自定义名称）
function SpeakerName({ speakerId }: { speakerId: string }) {
  const cfg = getSpeakerConfig(speakerId)
  const speakerNames = useProjectStore(s => s.project?.speakerNames ?? {})
  const displayName = speakerNames[speakerId] ?? cfg.name
  return (
    <span style={{ fontSize: '12px', fontWeight: 600, color: cfg.color }}>
      {displayName}
    </span>
  )
}

// ETA 估算
function ETA({ progress }: { progress: number; totalSeconds: number }) {
  const startRef = useRef<{ time: number; progress: number } | null>(null)
  if (!startRef.current && progress > 0) startRef.current = { time: Date.now(), progress }
  if (!startRef.current || progress <= 0 || progress >= 1) return null

  const elapsed = (Date.now() - startRef.current.time) / 1000
  const made = progress - startRef.current.progress
  if (made <= 0) return null
  const remaining = (1 - progress) / (made / elapsed)
  if (remaining <= 0 || !isFinite(remaining)) return null

  const m = Math.floor(remaining / 60), s = Math.floor(remaining % 60)
  return <span>{m > 0 ? `约剩 ${m} 分 ${s} 秒` : `约剩 ${s} 秒`}</span>
}

function Spinner() {
  return (
    <div style={{
      width: 16, height: 16,
      border: '2px solid var(--border)',
      borderTopColor: 'var(--accent)',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
      flexShrink: 0,
    }} />
  )
}
