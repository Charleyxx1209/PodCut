/**
 * ExportPanel — 导出音频 + 小宇宙上传
 * 以抽屉形式从右侧滑入，覆盖在精剪工作台上方
 */
import { useState, useEffect } from 'react'
import { useProjectStore } from '@/store/project'
import { fmt, isTauri } from '@/lib/utils'
import { generateRssXml, type RssConfig } from '@/lib/rss'

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
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState(false)
  const [exportedPath, setExportedPath] = useState('')
  const [exportedSize, setExportedSize] = useState(0)  // bytes
  const [exportError, setExportError] = useState('')
  const [progressMsg, setProgressMsg] = useState('')
  const [progressPct, setProgressPct] = useState(0)

  // 监听导出进度事件（Tauri）
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ pct: number; msg: string }>('export_progress', (e) => {
        setProgressMsg(e.payload.msg)
        setProgressPct(e.payload.pct)
      }).then(fn => { unlisten = fn })
    })
    return () => { unlisten?.() }
  }, [])

  // 在 Finder / 文件管理器中显示已导出文件
  async function showInFinder() {
    if (!isTauri() || !exportedPath) return
    try {
      const { Command } = await import('@tauri-apps/plugin-shell')
      // macOS: open -R 选中文件
      await Command.create('open', ['-R', exportedPath]).execute()
    } catch (e) {
      console.error('showInFinder failed:', e)
    }
  }

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

  async function handleExport() {
    setExporting(true)
    setExportError('')
    setProgressMsg('准备导出…')
    setProgressPct(0)

    try {
      if (isTauri() && project?.audio_path) {
        // 构建保留片段的时间范围列表（按时间排序 + 合并重叠）
        const rawSegs: [number, number][] = kept
          .map(c => [c.t_start, c.t_end] as [number, number])
          .sort((a, b) => a[0] - b[0])
        const segments: [number, number][] = []
        for (const seg of rawSegs) {
          const prev = segments[segments.length - 1]
          if (prev && seg[0] <= prev[1]) {
            // 重叠或相邻 → 合并
            prev[1] = Math.max(prev[1], seg[1])
          } else {
            segments.push([...seg])
          }
        }

        // 弹出文件保存对话框
        const { save } = await import('@tauri-apps/plugin-dialog')
        const ext = format === 'aac' ? 'm4a' : format
        const savePath = await save({
          defaultPath: `${project!.name.replace(/\s+/g, '_')}.${ext}`,
          filters: [{ name: format.toUpperCase(), extensions: [ext] }],
        })
        if (!savePath) {
          setExporting(false)
          setProgressMsg('')
          return
        }

        // 调用 Rust 导出命令（含音乐轨 + beep 标记）
        const { invoke } = await import('@tauri-apps/api/core')

        // 计算 beep 时间范围（需从原始音频时间轴映射到 concat 后的时间轴）
        // concat 后的时间 = 该 segment 在 kept 列表中的累计偏移
        const beepRanges: [number, number][] = []
        if (project!.beepMarks.length > 0) {
          // 构建原始时间 → concat 时间的映射
          let offset = 0
          for (const seg of segments) {
            const segLen = seg[1] - seg[0]
            for (const bm of project!.beepMarks) {
              // 如果 beep 范围与此段重叠，映射到 concat 时间
              const overlapStart = Math.max(bm.tStart, seg[0])
              const overlapEnd = Math.min(bm.tEnd, seg[1])
              if (overlapStart < overlapEnd) {
                beepRanges.push([
                  offset + (overlapStart - seg[0]),
                  offset + (overlapEnd - seg[0]),
                ])
              }
            }
            offset += segLen
          }
        }

        const intro = project!.musicTracks.intro
        const outro = project!.musicTracks.outro

        // 构建章节标记（sections → ffmpeg chapters）
        const chapterMarkers: { title: string; start_ms: number; end_ms: number }[] = []
        if (project!.sections.length > 0) {
          // 计算每个 section 在 concat 时间线上的起止
          let concatOffset = 0
          const sectionStarts: Record<string, number> = {}
          const sectionEnds: Record<string, number> = {}
          for (const seg of segments) {
            const segLen = seg[1] - seg[0]
            // 找到此段对应的 chunk，确定所属 section
            for (const chunk of kept) {
              if (chunk.t_start >= seg[0] && chunk.t_start < seg[1] && chunk.section_id) {
                const sid = chunk.section_id
                if (!(sid in sectionStarts)) sectionStarts[sid] = concatOffset + (chunk.t_start - seg[0])
                sectionEnds[sid] = concatOffset + Math.min(chunk.t_end - seg[0], segLen)
              }
            }
            concatOffset += segLen
          }
          for (const sec of project!.sections) {
            if (sec.id in sectionStarts) {
              chapterMarkers.push({
                title: sec.title,
                start_ms: Math.round(sectionStarts[sec.id] * 1000),
                end_ms: Math.round((sectionEnds[sec.id] ?? sectionStarts[sec.id] + 1) * 1000),
              })
            }
          }
        }

        const result = await invoke<string>('export_audio', {
          inputPath: project!.audio_path,
          segments,
          format,
          quality: bitrates[safeIdx],
          outputPath: savePath,
          introPath: intro?.path ?? null,
          introFadeIn: intro?.fadeIn ?? null,
          introFadeOut: intro?.fadeOut ?? null,
          outroPath: outro?.path ?? null,
          outroFadeIn: outro?.fadeIn ?? null,
          outroFadeOut: outro?.fadeOut ?? null,
          beepRanges: beepRanges.length > 0 ? beepRanges : null,
          metaTitle: project!.name || null,
          metaArtist: null,
          metaAlbum: null,
          chapters: chapterMarkers.length > 0 ? chapterMarkers : null,
        })

        const info = JSON.parse(result)
        setExportedPath(info.path)
        setExportedSize(info.size ?? 0)
        setExported(true)
      } else {
        // DEV 模式模拟
        for (let p = 0; p <= 100; p += 10) {
          await new Promise(r => setTimeout(r, 120))
          setProgressPct(p)
          setProgressMsg(`模拟进度 ${p}%`)
        }
        setExportedSize(1024 * 1024 * 12)  // 12 MB 假数据
        setExportedPath('/tmp/mock-export.mp3')
        setExported(true)
      }
    } catch (e: any) {
      setExportError(String(e?.message ?? e))
    } finally {
      setExporting(false)
      setProgressMsg('')
      setProgressPct(0)
    }
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
              <div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '10px 14px',
                  background: 'rgba(120,140,93,0.1)',
                  border: '1px solid rgba(120,140,93,0.3)',
                  borderRadius: 8,
                }}>
                  <span style={{ fontSize: '16px' }}>✓</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', color: 'var(--green)', fontWeight: 500 }}>
                      导出完成 {exportedSize > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>· {fmtBytes(exportedSize)}</span>}
                    </div>
                    {exportedPath && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {exportedPath}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: 8 }}>
                  {isTauri() && (
                    <button onClick={showInFinder} style={secondaryBtnStyle}>
                      在 Finder 中显示
                    </button>
                  )}
                  <button onClick={() => { setExported(false); setExportedPath(''); setExportedSize(0) }} style={secondaryBtnStyle}>
                    再次导出
                  </button>
                </div>
              </div>
            ) : (
              <>
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
                  {exporting ? (progressMsg || '正在合成…') : `导出 ${format.toUpperCase()} 文件`}
                </button>

                {/* 进度条 */}
                {exporting && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{
                      height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%', width: `${progressPct}%`,
                        background: 'var(--accent)',
                        transition: 'width 0.25s ease',
                      }} />
                    </div>
                    <div style={{
                      fontSize: '11px', color: 'var(--text-muted)',
                      marginTop: 4, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                    }}>
                      {progressPct}%
                    </div>
                  </div>
                )}

                {exportError && (
                  <div style={{
                    marginTop: 8, padding: '8px 12px', fontSize: '12px',
                    color: 'var(--red, #c44)', background: 'rgba(200,60,60,0.06)',
                    border: '1px solid rgba(200,60,60,0.2)', borderRadius: 6,
                  }}>
                    {exportError}
                  </div>
                )}
              </>
            )}
          </Section>

          {/* ── 小宇宙 RSS ── */}
          <Section title="小宇宙 RSS 发布">
            <RssExportSection
              project={project}
              defaultAudioSize={exportedSize}
              defaultAudioFormat={format}
            />
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

const secondaryBtnStyle: React.CSSProperties = {
  flex: 1, padding: '7px',
  fontSize: '12px', fontWeight: 500,
  background: 'transparent',
  color: 'var(--text-sub)',
  border: '1px solid var(--border)',
  borderRadius: 6, cursor: 'pointer',
  transition: 'border-color 0.15s, color 0.15s',
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
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

// ── RSS 导出子组件 ─────────────────────────────────────────────────────
function RssExportSection({ project, defaultAudioSize, defaultAudioFormat }: {
  project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>
  defaultAudioSize?: number       // 来自上一步导出的音频文件大小
  defaultAudioFormat?: AudioFmt   // 来自上一步导出的音频格式
}) {
  const [podcastTitle, setPodcastTitle] = useState(project.name)
  const [audioUrl, setAudioUrl] = useState('')
  const [author, setAuthor] = useState('')
  const [rssGenerated, setRssGenerated] = useState(false)

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', fontSize: '13px',
    border: '1px solid var(--border)', borderRadius: 6,
    background: 'var(--bg)', color: 'var(--text)',
    outline: 'none',
  }

  // 根据导出的格式映射 MIME 类型
  const audioMime: RssConfig['audioType'] | undefined = defaultAudioFormat ? ({
    mp3: 'audio/mpeg' as const,
    aac: 'audio/x-m4a' as const,
    wav: 'audio/wav' as const,
    flac: 'audio/flac' as const,
  })[defaultAudioFormat] : undefined

  function handleGenerateRss() {
    const config: RssConfig = {
      podcastTitle,
      episodeTitle: project.name,
      audioUrl: audioUrl || 'https://your-cdn.com/episode.mp3',
      audioSize: defaultAudioSize,
      audioType: audioMime,
      author: author || undefined,
    }
    const xml = generateRssXml(project, config)
    const name = project.name.replace(/\s+/g, '_')
    dl(xml, `${name}_feed.xml`, 'application/xml')
    setRssGenerated(true)
  }

  return (
    <div>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.6 }}>
        生成标准播客 RSS XML（含章节标记），提交给小宇宙认领后自动同步。
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: 14 }}>
        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>播客名称</label>
          <input
            value={podcastTitle}
            onChange={e => setPodcastTitle(e.target.value)}
            style={inputStyle}
            placeholder="我的播客"
          />
        </div>
        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            音频文件 URL
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — 上传音频到 CDN/OSS 后填写</span>
          </label>
          <input
            value={audioUrl}
            onChange={e => setAudioUrl(e.target.value)}
            style={inputStyle}
            placeholder="https://your-cdn.com/episode.mp3"
          />
          {defaultAudioSize ? (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: 4 }}>
              ✓ 已自动填入音频大小 {fmtBytes(defaultAudioSize)}（来自上一步导出）
            </div>
          ) : null}
        </div>
        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>作者（可选）</label>
          <input
            value={author}
            onChange={e => setAuthor(e.target.value)}
            style={inputStyle}
            placeholder="主播名"
          />
        </div>
      </div>

      {/* 章节预览 */}
      {project.sections.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 6 }}>章节标记（自动包含）</div>
          <div style={{
            padding: '8px 10px', fontSize: '12px',
            background: 'var(--bg-subtle)', borderRadius: 6,
            border: '1px solid var(--border)',
            maxHeight: 100, overflow: 'auto',
          }}>
            {project.sections.map((sec) => (
              <div key={sec.id} style={{ color: 'var(--text-sub)', marginBottom: 2 }}>
                <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', marginRight: 8 }}>
                  {fmt(project.chunks.find(c => c.section_id === sec.id)?.t_start ?? 0)}
                </span>
                {sec.title}
              </div>
            ))}
          </div>
        </div>
      )}

      {rssGenerated ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '10px 14px',
          background: 'rgba(120,140,93,0.1)',
          border: '1px solid rgba(120,140,93,0.3)',
          borderRadius: 8,
        }}>
          <span style={{ fontSize: '16px' }}>✓</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '13px', color: 'var(--green)', fontWeight: 500 }}>RSS XML 已下载</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>
              提交到小宇宙创作者后台即可同步
            </div>
          </div>
          <button onClick={() => setRssGenerated(false)} style={{
            fontSize: '11px', color: 'var(--text-muted)',
            background: 'transparent', border: 'none', cursor: 'pointer',
          }}>重新生成</button>
        </div>
      ) : (
        <button onClick={handleGenerateRss} style={{
          width: '100%', padding: '10px',
          fontSize: '13px', fontWeight: 500,
          background: 'transparent',
          color: 'var(--text-sub)',
          border: '1px solid var(--border)',
          borderRadius: 8, cursor: 'pointer',
          transition: 'border-color 0.15s, color 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text)'; e.currentTarget.style.color = 'var(--text)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-sub)' }}
        >
          生成 RSS XML
        </button>
      )}
    </div>
  )
}
