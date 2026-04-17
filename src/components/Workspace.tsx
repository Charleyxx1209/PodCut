import { useEffect, useState } from 'react'
import { useProjectStore, type Chunk, type Section, type MoveOp } from '@/store/project'
import TranscriptPanel from './TranscriptPanel'
import RoughCut from './RoughCut'
import AudioWorkbench from './AudioWorkbench'
import ChapterNav from './ChapterNav'
import AppIcon from './AppIcon'
import ProcessingView from './ProcessingView'
import ExportPanel from './ExportPanel'
import { mergeFragments, diarizeWithOllama, diarizeWithWhisperX, analyzeWithClaude, detectOllama, detectWhisperX } from '@/lib/postProcess'
import { markSilentChunks, type RawChunk } from '@/lib/speakers'
import { isTauri } from '@/lib/utils'
import { saveProjectFile, loadProjectFile } from '@/lib/projectFile'

// ── Mock 数据（DEV 流式演示用）────────────────────────────────────────
// 辅助：为 mock 文本生成均匀分布的词级时间戳
function mockWords(text: string, tStart: number, tEnd: number) {
  // 中文按字切分（每个字视为一个 "word"）
  const chars = text.split('')
  const dur = tEnd - tStart
  return chars.map((ch, i) => ({
    text: ch,
    start: tStart + (i / chars.length) * dur,
    end: tStart + ((i + 1) / chars.length) * dur,
    deleted: false,
  }))
}

const MOCK_CHUNKS: Chunk[] = [
  { id: 'chunk_001', text: '好，我们今天聊聊AI时代通识教育的困境，很多人学的东西正在被模型替代。', speaker: 's1', t_start: 0,   t_end: 12,  cut_status: 'keep', section_id: 'sec_ai', words: mockWords('好，我们今天聊聊AI时代通识教育的困境，很多人学的东西正在被模型替代。', 0, 12) },
  { id: 'chunk_002', text: '对，我觉得现在大学里教的很多技能，比如写报告、做数据分析，GPT都能做得比人好。', speaker: 's2', t_start: 14,  t_end: 29,  cut_status: 'keep', section_id: 'sec_ai', words: mockWords('对，我觉得现在大学里教的很多技能，比如写报告、做数据分析，GPT都能做得比人好。', 14, 29) },
  { id: 'chunk_003', text: '那你觉得什么样的技能是真正不可替代的？边缘的、小众的那种？', speaker: 's1', t_start: 31,  t_end: 40,  cut_status: 'keep', section_id: 'sec_ai', words: mockWords('那你觉得什么样的技能是真正不可替代的？边缘的、小众的那种？', 31, 40) },
  { id: 'chunk_004', text: '我认识一个修古董钟表的人，他的手艺需要二十年积累，AI完全没办法复制那种触感判断。', speaker: 's2', t_start: 42,  t_end: 58,  cut_status: 'keep', section_id: 'sec_ai', words: mockWords('我认识一个修古董钟表的人，他的手艺需要二十年积累，AI完全没办法复制那种触感判断。', 42, 58) },
  { id: 'chunk_005', text: '这让我想到你当初的决策——你是怎么走上现在这条路的？', speaker: 's1', t_start: 60,  t_end: 69,  cut_status: 'keep', section_id: 'sec_path', words: mockWords('这让我想到你当初的决策——你是怎么走上现在这条路的？', 60, 69) },
  { id: 'chunk_006', text: '其实我大学学的是金融，但第三年突然觉得那条路太可预测了，就去学了焊接。', speaker: 's2', t_start: 71,  t_end: 87,  cut_status: 'keep', section_id: 'sec_path', words: mockWords('其实我大学学的是金融，但第三年突然觉得那条路太可预测了，就去学了焊接。', 71, 87), interjections: [{ speakerId: 's1', start: 78, end: 79.5, text: '哇真的吗' }] },
  { id: 'chunk_007', text: '说回AI替代这个话题，我觉得最危险的不是体力劳动，而是那种中等复杂度的脑力工作。', speaker: 's2', t_start: 88,  t_end: 103, cut_status: 'keep', section_id: 'sec_path', words: mockWords('说回AI替代这个话题，我觉得最危险的不是体力劳动，而是那种中等复杂度的脑力工作。', 88, 103) },
  { id: 'chunk_008', text: '所有人都觉得我疯了，但我觉得那是我第一次做了一个真正属于自己的决定。', speaker: 's2', t_start: 104, t_end: 117, cut_status: 'keep', section_id: 'sec_path', words: mockWords('所有人都觉得我疯了，但我觉得那是我第一次做了一个真正属于自己的决定。', 104, 117) },
  { id: 'chunk_009', text: '你后悔过吗？', speaker: 's1', t_start: 119, t_end: 122, cut_status: 'maybe', cut_reason: '提问过于简短，节目里已有更完整的表述', section_id: 'sec_path', words: mockWords('你后悔过吗？', 119, 122) },
  { id: 'chunk_010', text: '从来没有。反而觉得自己站在一个很奇特的位置，既懂技术逻辑，又有手上的东西。', speaker: 's2', t_start: 124, t_end: 137, cut_status: 'keep', section_id: 'sec_path', words: mockWords('从来没有。反而觉得自己站在一个很奇特的位置，既懂技术逻辑，又有手上的东西。', 124, 137) },
]

const MOCK_SECTIONS: Section[] = [
  { id: 'sec_ai',   title: 'AI时代与不可替代性', keywords: ['AI', '替代', '技能', '钟表'], confirmed: false },
  { id: 'sec_path', title: '个人路径与选择',     keywords: ['金融', '焊接', '决定', '后悔'], confirmed: false },
]

// chunk_007 话题折返：在「个人路径」段插入了对 AI 的讨论，建议移回「AI时代」段
const MOCK_MOVE_OPS: MoveOp[] = [
  {
    chunk_id: 'chunk_007',
    from_index: 6,
    to_section: 'sec_ai',
    to_index_hint: 4,
    confidence: 0.88,
    reason: '此段重新回到「AI替代」主题，与「个人路径」段语境断裂，建议移至 § AI时代 末尾。',
    status: 'pending',
  },
]

// Mock 总时长（模拟 2h 文件）
const MOCK_TOTAL_DURATION = 7200

// ── 流式 Mock：模拟 ASR 逐段推入 ─────────────────────────────────────
// 注：React 18 StrictMode 会让 effect 执行两次，用 stage guard 防止重复启动
function startMockTranscription() {
  const store = useProjectStore.getState()
  // Guard：仅在 idle 状态才启动（StrictMode 第二次调用时 stage 已是 extracting，直接退出）
  if (store.project?.stage !== 'idle') return

  store.setStage('extracting')
  store.setTotalDuration(MOCK_TOTAL_DURATION)

  // 模拟 FFmpeg 提取 1.5s 后开始转写
  setTimeout(() => {
    // 再次检查：防止用户中途重置后 timer 仍在运行
    if (useProjectStore.getState().project?.stage !== 'extracting') return
    useProjectStore.getState().setStage('transcribing')

    let i = 0
    const timer = setInterval(() => {
      // 若用户已重置项目，停止 mock
      if (!useProjectStore.getState().project) { clearInterval(timer); return }
      const chunk = MOCK_CHUNKS[i]
      if (!chunk) {
        clearInterval(timer)
        finalizeMock()
        return
      }
      useProjectStore.getState().appendChunk(chunk)
      useProjectStore.getState().setTranscriptionProgress((i + 1) / MOCK_CHUNKS.length)
      i++
    }, 600)
  }, 1500)
}

function finalizeMock() {
  useProjectStore.getState().finalizeTranscription()
  // 补充章节结构与折返建议（真实场景由 Rust/LLM 在转写后生成）
  useProjectStore.setState(s => ({
    project: s.project ? {
      ...s.project,
      sections: MOCK_SECTIONS,
      move_ops: MOCK_MOVE_OPS,
    } : null
  }))
}

// ── Workspace ────────────────────────────────────────────────────────
export default function Workspace() {
  const { project, setStage, _needsReanalysis, clearResumeFlag, backToRoughCut } = useProjectStore()
  const [audioTime, setAudioTime] = useState(0)
  const [sectionFilter, setSectionFilter] = useState<string | undefined>()
  const [showExport, setShowExport] = useState(false)
  // 外部 seek 请求：用对象包装防止同值重复点击无效
  const [seekRequest, setSeekRequest] = useState<{ t: number; id: number } | undefined>()
  // .podcut 工程文件路径（首次保存后记住，后续 Cmd+S 直接覆盖）
  const [savedPath, setSavedPath] = useState<string | null>(null)

  // ── Cmd+Z / Ctrl+Z 全局撤销 + Cmd+S 保存 ─────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // Cmd+Z / Ctrl+Z  →  撤销
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        if (inInput) return
        e.preventDefault()
        useProjectStore.getState().undoLastMove()
        return
      }

      // Cmd+Shift+Z / Ctrl+Shift+Z  →  重做
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
        if (inInput) return
        e.preventDefault()
        useProjectStore.getState().redoLastMove()
        return
      }

      // Cmd+S / Ctrl+S  →  保存工程文件
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveProjectFile(savedPath ?? undefined).then(p => {
          if (p) setSavedPath(p)
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [savedPath])

  // ── 共用：跑 Ollama 识别 + Claude 章节分析 ──────────────────────
  async function runAnalysisPipeline(baseChunks: Chunk[], srcAudio: string) {
    const log = (msg: string) => console.log(`[Analysis] ${msg}`)
    const apiKey = localStorage.getItem('podcut_api_key') ?? ''
    const hfToken = localStorage.getItem('podcut_hf_token') ?? ''
    try {
      // 优先尝试 WhisperX（需要 HF token + whisperx 已安装）
      let diarized = baseChunks
      let usedWhisperX = false

      if (hfToken && isTauri()) {
        const wx = await detectWhisperX()
        if (wx.available) {
          log(`diarize: using WhisperX v${wx.version}`)
          try {
            diarized = await diarizeWithWhisperX(srcAudio, hfToken, msg => {
              useProjectStore.getState().setAnalysisStatus(msg)
            })
            usedWhisperX = true
            log('WhisperX diarize done')
          } catch (e) {
            log(`WhisperX failed, falling back to Ollama: ${e}`)
          }
        }
      }

      // 回退到 Ollama 文字识别说话人
      if (!usedWhisperX) {
        const ollamaModel = await detectOllama()
        if (ollamaModel) {
          log(`diarize: using Ollama ${ollamaModel}`)
          diarized = await diarizeWithOllama(baseChunks, ollamaModel, msg => {
            useProjectStore.getState().setAnalysisStatus(msg)
          })
          log('Ollama diarize done')
        }
      }

      // 生成说话人分轨（后台并行）— 只要有说话人标注就分轨
      const hasDiarization = diarized.some(c => c.speaker !== 's0')
      if (isTauri() && hasDiarization) {
        const dir = srcAudio.substring(0, srcAudio.lastIndexOf('/'))
        const s1Segs = diarized.filter(c => c.speaker === 's1').map(c => [c.t_start, c.t_end] as [number, number])
        const s2Segs = diarized.filter(c => c.speaker === 's2').map(c => [c.t_start, c.t_end] as [number, number])
        const { invoke } = await import('@tauri-apps/api/core')
        Promise.all([
          invoke('split_audio_track', { inputPath: srcAudio, segments: s1Segs, outputPath: `${dir}/track_s1.wav` }),
          invoke('split_audio_track', { inputPath: srcAudio, segments: s2Segs, outputPath: `${dir}/track_s2.wav` }),
        ]).then(() => {
          log('split_audio_track done')
          useProjectStore.setState(s => ({
            project: s.project ? { ...s.project, track_s1: `${dir}/track_s1.wav`, track_s2: `${dir}/track_s2.wav` } : null
          }))
        }).catch(e => log(`split_audio_track error: ${e}`))
      }

      const result = await analyzeWithClaude(diarized, apiKey, msg => {
        useProjectStore.getState().setAnalysisStatus(msg)
      })
      log(`analysis done: ${result.sections.length} sections, ${result.moveOps.length} moveOps`)
      useProjectStore.getState().setAnalysisResult(result)
    } catch (err) {
      log(`analysis/diarize error: ${err}`)
      useProjectStore.getState().setAnalysisResult({ sections: [], chunks: baseChunks, moveOps: [] })
    }
  }

  // ── 恢复会话：_needsReanalysis 时重跑分析 ─────────────────────────
  useEffect(() => {
    if (!_needsReanalysis || !project) return
    clearResumeFlag()
    if (!isTauri()) return

    // 如果 chunks 已有（analyzing 阶段中断），直接用；
    // 如果只有 chunks_partial（transcribing 中断），先合并
    const base = project.chunks.length > 0
      ? project.chunks
      : mergeFragments(project.chunks_partial as RawChunk[])
    const silenced = project.silences.length > 0 && project.chunks.length === 0
      ? markSilentChunks(base as RawChunk[], project.silences) as Chunk[]
      : base

    const srcAudio = project.audio_path ?? project.source_video
    runAnalysisPipeline(silenced, srcAudio)
  }, [_needsReanalysis])

  // ── 启动处理流程 (must be before any conditional return) ──────────
  useEffect(() => {
    if (!project || project.stage !== 'idle' || project.chunks.length > 0) return

    if (import.meta.env.DEV) {
      // DEV 模式：流式 mock（首条 300ms 内出现）
      startMockTranscription()
      return
    }

    if (!isTauri()) return

    // ── Tauri 真实流程 ────────────────────────────────────────────
    ;(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')
      const t0 = Date.now()
      const log = (msg: string) => console.log(`[Pipeline +${Date.now()-t0}ms] ${msg}`)

      // 1. 快速获取时长（仅读 metadata，< 1s）
      // 失败时传 0 给 Rust，由 Rust 侧 probe_duration 兜底重探
      setStage('extracting')
      log('get_audio_duration START, file=' + project.source_video)
      const duration = await invoke<number>('get_audio_duration', {
        path: project.source_video
      }).catch(e => { log('get_audio_duration ERROR (Rust will re-probe): ' + e); return 0 })
      log(`get_audio_duration DONE: ${duration}s${duration <= 0 ? ' (fallback: Rust will re-probe)' : ''}`)
      if (duration > 0) useProjectStore.getState().setTotalDuration(duration)

      // 2. 检查模型，如未下载则先下载（~1.5GB，首次需要）
      const MODEL = 'large-v3-turbo'
      const hasModel = await invoke<boolean>('check_model', { model: MODEL })
        .catch(() => false)
      if (!hasModel) {
        log('model not found, downloading...')
        useProjectStore.getState().setModelStatus('正在下载 Whisper 模型（large-v3, ~3GB）…首次下载约需 5–15 分钟。', 0)
        const unDlProgress = await listen<{ downloaded: number; total: number; ratio: number }>(
          'model_download_progress', e => {
            const pct = Math.round(e.payload.ratio * 100)
            const mb = Math.round(e.payload.downloaded / 1024 / 1024)
            const total = Math.round(e.payload.total / 1024 / 1024)
            log(`model download: ${pct}% (${mb}/${total}MB)`)
            useProjectStore.getState().setModelStatus(
              `正在下载 Whisper 模型（${mb}MB / ${total}MB）`,
              e.payload.ratio
            )
          }
        )
        await invoke('download_model', { model: MODEL })
          .catch(e => {
            useProjectStore.getState().setModelStatus(undefined)
            useProjectStore.getState().setTranscriptionError('模型下载失败：' + e)
            throw e
          })
        unDlProgress()
        useProjectStore.getState().setModelStatus(undefined)
        log('model download done')
      }

      // 3. 切换到转写阶段，监听流式事件
      setStage('transcribing')
      log('stage → transcribing')
      const unChunk = await listen<Chunk>('transcription_chunk', e => {
        useProjectStore.getState().appendChunk(e.payload)
      })
      const unProgress = await listen<{ processed: number; total: number }>(
        'transcription_progress', e => {
          useProjectStore.getState().setTranscriptionProgress(
            e.payload.processed / e.payload.total
          )
        }
      )
      const unDone = await listen('transcription_complete', async () => {
        log('transcription_complete received')
        const store = useProjectStore.getState()
        const partial = store.project?.chunks_partial ?? []
        if (partial.length === 0) {
          log('ERROR: 0 chunks received')
        } else {
          log(`mergeFragments: ${partial.length} raw → merging`)
          const merged = mergeFragments(partial as RawChunk[])
          const silences = store.project?.silences ?? []
          const silenced = silences.length > 0
            ? markSilentChunks(merged as RawChunk[], silences) as typeof merged
            : merged
          log(`mergeFragments done: ${silenced.length} chunks`)

          store.beginAnalysis(silenced)

          const srcAudio = store.project?.audio_path ?? project.source_video
          await runAnalysisPipeline(silenced, srcAudio)
        }
        unChunk(); unProgress(); unDone(); unErr()
      })
      const unErr = await listen<{ code: string; message: string }>('transcription_error', e => {
        log('transcription_error: ' + e.payload.code + ' — ' + e.payload.message)
        useProjectStore.getState().setTranscriptionError(e.payload.message)
      })

      // 4. 直接从原始文件转写（不需要先全量提取）
      log('transcribe_streaming INVOKE START')
      invoke('transcribe_streaming', {
        audioPath: project.source_video,
        totalSeconds: duration,
        model: MODEL,
      }).then(() => log('transcribe_streaming DONE'))
        .catch(e => log('transcribe_streaming ERROR: ' + e))

      // 5. 后台并行：① 提取完整音频用于播放  ② 检测静音段
      const audioPath = project.source_video.replace(/\.[^.]+$/, '_audio.wav')
      log('extract_audio BACKGROUND START')
      invoke('extract_audio', { input: project.source_video, output: audioPath })
        .then(() => {
          log('extract_audio BACKGROUND DONE')
          useProjectStore.setState(s => ({
            project: s.project ? { ...s.project, audio_path: audioPath } : null
          }))
        })
        .catch(e => log('extract_audio BACKGROUND ERROR: ' + e))

      log('detect_silences BACKGROUND START')
      invoke<Array<{ start: number; end: number }>>('detect_silences', {
        audioPath: project.source_video,
        noiseDb: -40,
        minDur: 2.0,
      }).then(silences => {
        log(`detect_silences DONE: ${silences.length} regions`)
        useProjectStore.getState().applySilences(silences)
      }).catch(e => log('detect_silences ERROR: ' + e))
    })()
  }, [])

  if (!project) return null

  const isEditing = project.stage === 'editing'
  const isProcessing = project.stage === 'extracting' || project.stage === 'transcribing' || project.stage === 'analyzing'
  const pendingOps = project.move_ops.filter(o => o.status === 'pending').length

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: 'var(--bg)', overflow: 'hidden'
    }}>
      {/* ── 顶部导航栏 ── */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '0 20px', height: '48px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-raised)',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AppIcon size={24} />
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>PodCut</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>v{__APP_VERSION__}</span>
        </div>
        <div style={{ width: '1px', height: '16px', background: 'var(--border)' }} />
        <EditableTitle
          value={project.name}
          onChange={(name) => useProjectStore.getState().setProjectName(name)}
        />
        <StageTag stage={project.stage} />
        {pendingOps > 0 && (
          <span style={{
            fontSize: '11px', padding: '2px 8px',
            background: 'var(--red-dim)', color: 'var(--red)',
            borderRadius: '20px', fontWeight: 500
          }}>
            {pendingOps} 处折返
          </span>
        )}
        <div style={{ flex: 1 }} />
        {/* ── 工程文件操作（所有阶段可用，除 idle / processing） ── */}
        {(project.stage === 'rough_cut' || isEditing) && (
          <>
            <HeaderBtn onClick={() => loadProjectFile()}>
              打开
            </HeaderBtn>
            <HeaderBtn onClick={() => saveProjectFile(savedPath ?? undefined).then(p => { if (p) setSavedPath(p) })}>
              {savedPath ? '保存' : '另存为'}
            </HeaderBtn>
          </>
        )}
        {isEditing && (
          <>
            <HeaderBtn onClick={() => { console.log('[Workspace] backToRoughCut clicked'); backToRoughCut() }}>
              ← 返回粗剪
            </HeaderBtn>
            <HeaderBtn
              onClick={() => useProjectStore.getState().undoLastMove()}
              disabled={project.undo_stack.length === 0}
            >
              撤销
            </HeaderBtn>
            <HeaderBtn
              onClick={() => useProjectStore.getState().redoLastMove()}
              disabled={project.redo_stack.length === 0}
            >
              重做
            </HeaderBtn>
            <HeaderBtn onClick={() => setShowExport(true)}>导出</HeaderBtn>
          </>
        )}
        {isProcessing && (
          <HeaderBtn onClick={() => useProjectStore.getState().reset()}>
            ← 重新选择
          </HeaderBtn>
        )}
        {project.stage === 'rough_cut' && (
          <>
            <HeaderBtn onClick={() => useProjectStore.getState().reset()}>
              ← 重新选择
            </HeaderBtn>
            <HeaderBtn
              onClick={() => useProjectStore.getState().undoLastMove()}
              disabled={project.undo_stack.length === 0}
            >
              撤销
            </HeaderBtn>
            <HeaderBtn
              onClick={() => useProjectStore.getState().redoLastMove()}
              disabled={project.redo_stack.length === 0}
            >
              重做
            </HeaderBtn>
          </>
        )}
      </header>

      {/* ── 主内容区 ── */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* 提取 & 转写：流式进度视图 */}
        {isProcessing && <ProcessingView />}

        {/* 粗剪 */}
        {project.stage === 'rough_cut' && <RoughCut />}

        {/* 精剪工作台 */}
        {isEditing && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <AudioWorkbench
              onTimeUpdate={setAudioTime}
              seekTo={seekRequest}
            />
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <TranscriptPanel
                audioTime={audioTime}
                sectionFilter={sectionFilter}
                onChunkClick={t => setSeekRequest({ t, id: Date.now() })}
              />
            </div>
            <ChapterNav
              currentTime={audioTime}
              activeSection={sectionFilter}
              onSectionFilter={setSectionFilter}
            />
          </div>
        )}
      </main>

      {/* 导出面板（精剪阶段可用） */}
      {showExport && <ExportPanel onClose={() => setShowExport(false)} />}
    </div>
  )
}

// ── 小组件 ───────────────────────────────────────────────────────────

function EditableTitle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  function commit() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onChange(trimmed)
    else setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false) } }}
        style={{
          fontSize: '13px', color: 'var(--text)', fontWeight: 400,
          background: 'transparent', border: 'none',
          borderBottom: '1px solid var(--accent)',
          outline: 'none', padding: '0 2px', width: Math.max(80, draft.length * 8 + 20),
        }}
      />
    )
  }

  return (
    <span
      onClick={() => { setDraft(value); setEditing(true) }}
      title="点击改名"
      style={{
        fontSize: '13px', color: 'var(--text)', fontWeight: 400,
        cursor: 'text', borderBottom: '1px solid transparent',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.borderBottom = '1px dashed var(--border-mid)'}
      onMouseLeave={e => e.currentTarget.style.borderBottom = '1px solid transparent'}
    >
      {value}
    </span>
  )
}

function HeaderBtn({ children, onClick, disabled }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '5px 12px', fontSize: '12px',
      background: 'transparent', border: '1px solid var(--border)',
      borderRadius: 'var(--r-sm)',
      color: disabled ? 'var(--text-muted)' : 'var(--text-sub)',
      cursor: disabled ? 'default' : 'pointer',
      transition: 'border-color 0.15s, color 0.15s'
    }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--border-mid)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
    >
      {children}
    </button>
  )
}

function StageTag({ stage }: { stage: string }) {
  const map: Record<string, { label: string; color: string }> = {
    idle:         { label: '待处理',   color: 'var(--text-muted)' },
    extracting:   { label: '提取音频', color: 'var(--blue)' },
    transcribing: { label: '转写中',   color: 'var(--blue)' },
    analyzing:    { label: 'AI 分析中', color: 'var(--accent)' },
    rough_cut:    { label: '粗剪',     color: 'var(--amber)' },
    editing:      { label: '精剪',     color: 'var(--green)' },
    exporting:    { label: '导出中',   color: 'var(--text-muted)' },
  }
  const info = map[stage] ?? { label: stage, color: 'var(--text-muted)' }
  return (
    <span style={{ fontSize: '11px', color: info.color, fontWeight: 500 }}>
      {info.label}
    </span>
  )
}

