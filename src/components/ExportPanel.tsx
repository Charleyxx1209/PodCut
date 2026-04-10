/**
 * ExportPanel — 导出音频 + 小宇宙上传
 * 以抽屉形式从右侧滑入，覆盖在精剪工作台上方
 */
import { useState } from 'react'
import { useProjectStore } from '@/store/project'
import { fmt } from '@/lib/utils'

type AudioFmt = 'mp3' | 'wav' | 'aac' | 'flac'

const FORMAT_OPTIONS: { id: AudioFmt; label: string; desc: string }[] = [
  { id: 'mp3',  label: 'MP3',  desc: '128–320 kbps · 小宇宙推荐' },
  { id: 'aac',  label: 'AAC',  desc: '128–256 kbps · Apple 推荐' },
  { id: 'wav',  label: 'WAV',  desc: '无损 · 最大兼容性' },
  { id: 'flac', label: 'FLAC', desc: '无损压缩 · 存档用' },
]

const BITRATE_OPTIONS: Record<AudioFmt, string[]> = {
  mp3:  ['128 kbps', '192 kbps', '256 kbps', '320 kbps'],
  aac:  ['128 kbps', '192 kbps', '256 kbps'],
  wav:  ['44.1 kHz / 16-bit', '48 kHz / 24-bit'],
  flac: ['44.1 kHz', '48 kHz'],
}

export default function ExportPanel({ onClose }: { onClose: () => void }) {
  const { project } = useProjectStore()
  const [format, setFormat] = useState<AudioFmt>('mp3')
  const [bitrateIdx, setBitrateIdx] = useState(2)  // default 256 kbps
  const [cosmoConnected, setCosmoConnected] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState(false)

  if (!project) return null

  const kept = project.chunks.filter(c => c.cut_status !== 'discard')
  const keptDur = kept.reduce((s, c) => s + (c.t_end - c.t_start), 0)
  const beepCount = project.beepMarks.length
  const hasIntro = !!project.musicTracks.intro
  const hasOutro = !!project.musicTracks.outro
  const totalEstimate = keptDur
    + (project.musicTracks.intro?.duration ?? 0)
    + (project.musicTracks.outro?.duration ?? 0)

  const bitrates = BITRATE_OPTIONS[format]
  const safeIdx = Math.min(bitrateIdx, bitrates.length - 1)

  function handleExport() {
    setExporting(true)
    // Simulate export (real: invoke Tauri command)
    setTimeout(() => {
      setExporting(false)
      setExported(true)
    }, 2200)
  }

  function handleCosmoConnect() {
    // Placeholder: real implementation would trigger OAuth flow
    setTimeout(() => setCosmoConnected(true), 600)
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(20,20,19,0.35)',
          zIndex: 40,
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 420,
        background: 'var(--bg-raised)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        zIndex: 41,
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '0 20px', height: 48,
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', flex: 1 }}>
            导出
          </span>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: '18px', padding: '4px 6px',
            lineHeight: 1,
          }}>×</button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

          {/* ── 摘要 ── */}
          <Section title="导出内容">
            <Row label="保留片段" value={`${kept.length} 段 · ${fmt(keptDur)}`} />
            <Row label="片头曲" value={hasIntro ? `${project.musicTracks.intro!.title} (${project.musicTracks.intro!.duration}s)` : '未添加'} muted={!hasIntro} />
            <Row label="片尾曲" value={hasOutro ? `${project.musicTracks.outro!.title} (${project.musicTracks.outro!.duration}s)` : '未添加'} muted={!hasOutro} />
            <Row label="消音处理" value={beepCount > 0 ? `${beepCount} 处 beep` : '无'} muted={beepCount === 0} />
            <Row label="预计总时长" value={fmt(totalEstimate)} bold />
          </Section>

          {/* ── 格式选择 ── */}
          <Section title="音频格式">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: 12 }}>
              {FORMAT_OPTIONS.map(f => (
                <button key={f.id} onClick={() => { setFormat(f.id); setBitrateIdx(0) }} style={{
                  padding: '10px 12px', textAlign: 'left',
                  border: `1px solid ${format === f.id ? 'var(--text)' : 'var(--border)'}`,
                  borderRadius: 8, cursor: 'pointer',
                  background: format === f.id ? 'var(--bg-subtle)' : 'transparent',
                  transition: 'border-color 0.15s',
                }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
                    {f.label}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.desc}</div>
                </button>
              ))}
            </div>

            {/* Bitrate / quality */}
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 6 }}>质量</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {bitrates.map((b, i) => (
                  <button key={b} onClick={() => setBitrateIdx(i)} style={{
                    padding: '4px 10px', fontSize: '12px',
                    border: `1px solid ${safeIdx === i ? 'var(--text)' : 'var(--border)'}`,
                    borderRadius: 20, cursor: 'pointer',
                    background: safeIdx === i ? 'var(--text)' : 'transparent',
                    color: safeIdx === i ? 'var(--bg)' : 'var(--text-sub)',
                    transition: 'all 0.12s',
                  }}>
                    {b}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          {/* ── 本地导出 ── */}
          <Section title="本地保存">
            {exported ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '10px 14px',
                background: 'rgba(120,140,93,0.1)',
                border: '1px solid rgba(120,140,93,0.3)',
                borderRadius: 8,
              }}>
                <span style={{ fontSize: '16px' }}>✓</span>
                <span style={{ fontSize: '13px', color: 'var(--green)', fontWeight: 500 }}>
                  已保存为 {project.name}.{format}
                </span>
              </div>
            ) : (
              <button
                onClick={handleExport}
                disabled={exporting}
                style={{
                  width: '100%', padding: '10px',
                  fontSize: '13px', fontWeight: 500,
                  background: exporting ? 'var(--bg-subtle)' : 'var(--text)',
                  color: exporting ? 'var(--text-muted)' : 'var(--bg)',
                  border: 'none', borderRadius: 8, cursor: exporting ? 'default' : 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                {exporting ? '正在合成…' : `导出 ${format.toUpperCase()} 文件`}
              </button>
            )}
          </Section>

          {/* ── 小宇宙 ── */}
          <Section title="上传至小宇宙">
            {cosmoConnected ? (
              <div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '8px 12px', marginBottom: 10,
                  background: 'var(--bg-subtle)',
                  borderRadius: 8, border: '1px solid var(--border)',
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <span style={{ fontSize: '12px', color: 'var(--bg)', fontWeight: 600 }}>宙</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)' }}>已连接小宇宙</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>播客主页 · 3 个节目</div>
                  </div>
                  <button onClick={() => setCosmoConnected(false)} style={{
                    fontSize: '11px', color: 'var(--text-muted)',
                    background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 6px',
                  }}>断开</button>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 6 }}>上传到</div>
                  <select style={{
                    width: '100%', padding: '8px 10px', fontSize: '13px',
                    border: '1px solid var(--border)', borderRadius: 8,
                    background: 'var(--bg)', color: 'var(--text)',
                    outline: 'none',
                  }}>
                    <option>技术与社会 — EP 42</option>
                    <option>新建草稿</option>
                  </select>
                </div>

                <button
                  disabled={!exported}
                  style={{
                    width: '100%', padding: '10px',
                    fontSize: '13px', fontWeight: 500,
                    background: exported ? 'var(--accent)' : 'var(--bg-subtle)',
                    color: exported ? 'white' : 'var(--text-muted)',
                    border: 'none', borderRadius: 8,
                    cursor: exported ? 'pointer' : 'default',
                    transition: 'background 0.15s',
                  }}
                  title={!exported ? '请先导出音频文件' : ''}
                >
                  上传至小宇宙
                </button>
                {!exported && (
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0', textAlign: 'center' }}>
                    请先完成本地导出
                  </p>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <p style={{ fontSize: '13px', color: 'var(--text-sub)', margin: '0 0 14px' }}>
                  连接小宇宙账号，导出后一键发布节目
                </p>
                <button onClick={handleCosmoConnect} style={{
                  padding: '9px 22px', fontSize: '13px', fontWeight: 500,
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 8, cursor: 'pointer',
                  color: 'var(--text-sub)',
                  transition: 'border-color 0.15s, color 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text)'; e.currentTarget.style.color = 'var(--text)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-sub)' }}
                >
                  连接小宇宙
                </button>
              </div>
            )}
          </Section>

          {/* JSON 数据导出 */}
          <Section title="数据">
            <div style={{ display: 'flex', gap: '8px' }}>
              <ExportDataBtn label="导出剪辑指南 .md" onClick={() => {
                const md = useProjectStore.getState().exportMarkdown()
                const name = project.name.replace(/\s+/g, '_')
                dl(md, `${name}_剪辑指南.md`, 'text/markdown')
              }} />
              <ExportDataBtn label="导出 JSON" onClick={() => {
                const json = useProjectStore.getState().exportJSON()
                const name = project.name.replace(/\s+/g, '_')
                dl(json, `${name}_数据.json`, 'application/json')
              }} />
            </div>
          </Section>

        </div>
      </div>
    </>
  )
}

function dl(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: '11px', fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
        marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value, muted, bold }: { label: string; value: string; muted?: boolean; bold?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '5px 0', borderBottom: '1px solid var(--border)',
      fontSize: '12px',
    }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: muted ? 'var(--text-muted)' : 'var(--text)', fontWeight: bold ? 600 : 400 }}>
        {value}
      </span>
    </div>
  )
}

function ExportDataBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '8px', fontSize: '12px',
      background: 'transparent', border: '1px solid var(--border)',
      borderRadius: 8, cursor: 'pointer', color: 'var(--text-sub)',
      transition: 'border-color 0.15s',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-mid)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
    >
      {label}
    </button>
  )
}
