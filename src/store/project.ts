import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { assignSpeakers, markSilentChunks, type RawChunk, type SilenceRange } from '@/lib/speakers'
import { fmt, cappedPush } from '@/lib/utils'

// ─── 核心数据结构 ───────────────────────────────────────────────

export interface Chunk {
  id: string            // chunk_001, chunk_002 ...
  text: string          // ASR 识别文本
  speaker: string       // 说话人标签
  t_start: number       // 秒，对应原始音频时间戳
  t_end: number
  section_id?: string   // LLM 归属章节（第二轮后填入）
  cut_status: 'keep' | 'discard' | 'maybe'
  cut_reason?: string
}

export interface Section {
  id: string
  title: string
  keywords: string[]
  confirmed: boolean
}

export interface MoveOp {
  chunk_id: string
  from_index: number
  to_section: string
  to_index_hint: number
  confidence: number
  reason: string
  status: 'pending' | 'accepted' | 'rejected' | 'custom'
}

// 配乐轨道（片头 / 片尾）
export interface MusicTrack {
  type: 'intro' | 'outro'
  title: string       // e.g. "轻音乐 - 清晨"
  duration: number    // 秒
  fadeIn: number      // 淡入时长（秒）
  fadeOut: number     // 淡出时长（秒）
}

// 消音标记（敏感词位置）
export interface BeepMark {
  id: string
  chunkId: string
  text: string        // 被消音的文字
  tStart: number      // 音频时间戳
  tEnd: number
}

export interface Project {
  name: string
  source_video: string
  audio_path?: string
  track_s1?: string   // 说话人1 独立轨道路径
  track_s2?: string   // 说话人2 独立轨道路径
  chunks: Chunk[]
  chunks_original: Chunk[]
  chunks_pre_edit?: Chunk[]          // 进精剪前的全量快照，用于「返回粗剪」
  // ── 转写流式缓冲 ──────────────────────────────────
  chunks_partial: Chunk[]          // 转写中逐条追加，完成后提升为 chunks
  transcription_progress: number   // 0.0 – 1.0
  total_duration_seconds: number   // ffprobe 获取的总时长
  transcription_error?: string     // 转写失败时的错误信息（红色框）
  model_status?: string            // 模型下载进度等信息（蓝色进度条）
  model_download_ratio?: number    // 0-1，下载进度
  analysis_status?: string         // Claude 分析阶段的状态文字
  // ─────────────────────────────────────────────────
  sections: Section[]
  move_ops: MoveOp[]
  undo_stack: Chunk[][]
  stage: ProjectStage
  silences: SilenceRange[]           // 静音段列表，detect_silences 结果
  speakerNames: Record<string, string>  // id → 用户自定义显示名（覆盖调色板默认）
  // 精剪
  musicTracks: { intro?: MusicTrack; outro?: MusicTrack }
  beepMarks: BeepMark[]
}

export type ProjectStage =
  | 'idle'
  | 'extracting'
  | 'transcribing'
  | 'analyzing'    // 转写完成，正在 Claude 分析章节
  | 'rough_cut'
  | 'editing'
  | 'exporting'

// ─── Store ──────────────────────────────────────────────────────

interface ProjectStore {
  project: Project | null
  _needsReanalysis: boolean   // 恢复会话时需要重跑 analysis（不持久化）
  createProject: (name: string, videoPath: string) => void
  setStage: (stage: ProjectStage) => void
  setChunks: (chunks: Chunk[]) => void
  setSections: (sections: Section[]) => void
  setChunkCutStatus: (id: string, status: 'keep' | 'discard' | 'maybe') => void
  confirmRoughCut: () => void
  backToRoughCut: () => void
  applyMoveOp: (op_id: string, status: 'accepted' | 'rejected' | 'custom', custom_index?: number) => void
  undoLastMove: () => void
  exportMarkdown: () => string
  exportJSON: () => string
  reset: () => void
  // ── 流式转写 ─────────────────────────────────────
  setTotalDuration: (seconds: number) => void
  appendChunk: (chunk: Chunk) => void
  setTranscriptionProgress: (ratio: number) => void
  finalizeTranscription: () => void   // 转写完成：partial → chunks，进入 rough_cut
  skipToRoughCut: () => void          // 用户手动跳过，用已有 partial 数据
  setTranscriptionError: (msg: string | undefined) => void
  setModelStatus: (msg: string | undefined, ratio?: number) => void
  applySilences: (silences: SilenceRange[]) => void   // 静音结果注入 → 重新标记 chunks
  setSpeakerName: (id: string, name: string) => void  // 自定义说话人显示名
  // 真实流程后处理
  beginAnalysis: (mergedChunks: Chunk[]) => void
  setAnalysisStatus: (msg: string) => void
  setAnalysisResult: (result: { sections: Section[]; chunks: Chunk[]; moveOps: MoveOp[] }) => void
  // 精剪
  setMusicTrack: (track: MusicTrack) => void
  removeMusicTrack: (type: 'intro' | 'outro') => void
  addBeepMark: (mark: Omit<BeepMark, 'id'>) => void
  removeBeepMark: (id: string) => void
  // 断点续传
  prepareForResume: () => void
  clearResumeFlag: () => void
}

export const useProjectStore = create<ProjectStore>()(
  persist(
  (set, get) => ({
  project: null,
  _needsReanalysis: false,

  createProject: (name, videoPath) => set({
    project: {
      name,
      source_video: videoPath,
      chunks: [],
      chunks_original: [],
      chunks_partial: [],
      transcription_progress: 0,
      total_duration_seconds: 0,
      transcription_error: undefined,
      model_status: undefined,
      model_download_ratio: undefined,
      sections: [],
      move_ops: [],
      undo_stack: [],
      stage: 'idle',
      silences: [],
      speakerNames: {},
      musicTracks: {},
      beepMarks: [],
    }
  }),

  setStage: (stage) => set(s => ({
    project: s.project ? { ...s.project, stage } : null
  })),

  setChunks: (chunks) => set(s => ({
    project: s.project ? {
      ...s.project,
      chunks,
      chunks_original: s.project.chunks_original.length === 0 ? chunks : s.project.chunks_original
    } : null
  })),

  setSections: (sections) => set(s => ({
    project: s.project ? { ...s.project, sections } : null
  })),

  setChunkCutStatus: (id, status) => set(s => ({
    project: s.project ? {
      ...s.project,
      chunks: s.project.chunks.map(c => c.id === id ? { ...c, cut_status: status } : c)
    } : null
  })),

  confirmRoughCut: () => set(s => {
    if (!s.project) return {}
    const kept = s.project.chunks.filter(c => c.cut_status !== 'discard')
    return {
      project: {
        ...s.project,
        chunks_pre_edit: s.project.chunks, // 保留全量快照，供「返回粗剪」恢复
        chunks: kept,
        chunks_original: kept,
        stage: 'editing',
      }
    }
  }),

  backToRoughCut: () => set(s => {
    if (!s.project) { console.warn('[Store] backToRoughCut: no project'); return {} }
    // 恢复进精剪前的全量数据（包含 discard 标记）
    const hasPreEdit = !!s.project.chunks_pre_edit
    const restored = s.project.chunks_pre_edit ?? s.project.chunks_original
    console.log(`[Store] backToRoughCut: hasPreEdit=${hasPreEdit}, restored=${restored.length} chunks, was stage=${s.project.stage}`)
    return {
      project: {
        ...s.project,
        chunks: restored,
        chunks_original: restored,
        chunks_pre_edit: undefined,
        stage: 'rough_cut' as const,
        undo_stack: [],
      }
    }
  }),

  applyMoveOp: (chunk_id, status, custom_index) => set(s => {
    if (!s.project) return {}
    const p = s.project
    const op = p.move_ops.find(o => o.chunk_id === chunk_id)
    if (!op || status === 'rejected') {
      return {
        project: {
          ...p,
          move_ops: p.move_ops.map(o => o.chunk_id === chunk_id ? { ...o, status: 'rejected' } : o)
        }
      }
    }
    const snapshot = [...p.chunks]
    const chunk = p.chunks.find(c => c.id === chunk_id)!
    const without = p.chunks.filter(c => c.id !== chunk_id)
    const target = custom_index ?? op.to_index_hint
    const newChunks = [...without.slice(0, target), chunk, ...without.slice(target)]
    return {
      project: {
        ...p,
        chunks: newChunks,
        undo_stack: cappedPush(p.undo_stack, snapshot),
        move_ops: p.move_ops.map(o => o.chunk_id === chunk_id ? { ...o, status } : o)
      }
    }
  }),

  undoLastMove: () => set(s => {
    if (!s.project || s.project.undo_stack.length === 0) return {}
    const stack = [...s.project.undo_stack]
    const prev = stack.pop()!
    return { project: { ...s.project, chunks: prev, undo_stack: stack } }
  }),

  // ── 流式转写 actions ──────────────────────────────

  setTotalDuration: (seconds) => set(s => ({
    project: s.project ? { ...s.project, total_duration_seconds: seconds } : null
  })),

  appendChunk: (chunk) => set(s => ({
    project: s.project ? {
      ...s.project,
      chunks_partial: [...s.project.chunks_partial, chunk]
    } : null
  })),

  setTranscriptionProgress: (ratio) => set(s => ({
    project: s.project ? { ...s.project, transcription_progress: Math.min(1, ratio) } : null
  })),

  finalizeTranscription: () => set(s => {
    if (!s.project) return {}
    // 1. 按停顿分配说话人（s1 ↔ s2 交替）
    const withSpeakers = assignSpeakers(s.project.chunks_partial as RawChunk[]) as Chunk[]
    // 2. 如果已有静音数据，立刻标记无声段
    const done = s.project.silences.length > 0
      ? markSilentChunks(withSpeakers as RawChunk[], s.project.silences) as Chunk[]
      : withSpeakers
    return {
      project: {
        ...s.project,
        chunks: done,
        chunks_original: done,
        chunks_partial: [],
        transcription_progress: 1,
        stage: 'rough_cut'
      }
    }
  }),

  setTranscriptionError: (msg) => set(s => ({
    project: s.project ? { ...s.project, transcription_error: msg } : null
  })),

  setModelStatus: (msg, ratio) => set(s => ({
    project: s.project ? {
      ...s.project,
      model_status: msg,
      model_download_ratio: ratio
    } : null
  })),

  skipToRoughCut: () => set(s => {
    if (!s.project) return {}
    const raw = s.project.chunks_partial.length > 0 ? s.project.chunks_partial : s.project.chunks
    const withSpeakers = assignSpeakers(raw as RawChunk[]) as Chunk[]
    const fallback = s.project.silences.length > 0
      ? markSilentChunks(withSpeakers as RawChunk[], s.project.silences) as Chunk[]
      : withSpeakers
    return {
      project: {
        ...s.project,
        chunks: fallback,
        chunks_original: fallback,
        chunks_partial: [],
        stage: 'rough_cut'
      }
    }
  }),

  // ── 导出 ─────────────────────────────────────────

  exportMarkdown: () => {
    const p = get().project
    if (!p) return ''
    const sectionMap: Record<string, Chunk[]> = {}
    const unsectioned: Chunk[] = []
    for (const c of p.chunks) {
      if (c.section_id) sectionMap[c.section_id] = [...(sectionMap[c.section_id] ?? []), c]
      else unsectioned.push(c)
    }
    let md = `# ${p.name} — 剪辑指南\n\n> 生成时间：${new Date().toLocaleString('zh-CN')}\n\n`
    for (const sec of p.sections) {
      md += `## ${sec.title}（${sec.id}）\n关键词：${sec.keywords.join('、')}\n\n`
      for (const c of sectionMap[sec.id] ?? []) {
        const flag = p.move_ops.find(o => o.chunk_id === c.id && o.status === 'accepted') ? ' ✦ 已移位' : ''
        md += `- **[${fmt(c.t_start)}]** \`${c.speaker}\`${flag}\n  ${c.text}\n`
      }
      md += '\n'
    }
    if (unsectioned.length) {
      md += `## 未分类\n\n`
      for (const c of unsectioned) md += `- **[${fmt(c.t_start)}]** \`${c.speaker}\`\n  ${c.text}\n`
    }
    return md
  },

  exportJSON: () => {
    const p = get().project
    if (!p) return '{}'
    return JSON.stringify({
      name: p.name,
      exported_at: new Date().toISOString(),
      sections: p.sections,
      chunks: p.chunks,
      move_ops: p.move_ops.filter(o => o.status !== 'pending')
    }, null, 2)
  },

  // 静音段注入：如果 chunks 已存在（rough_cut 阶段），立刻重新标记；
  // 否则只存储，等 finalizeTranscription 时用
  applySilences: (silences) => set(s => {
    if (!s.project) return {}
    const p = { ...s.project, silences }
    if (p.stage === 'rough_cut' && p.chunks.length > 0) {
      const remarked = markSilentChunks(p.chunks as RawChunk[], silences) as Chunk[]
      return { project: { ...p, chunks: remarked } }
    }
    return { project: p }
  }),

  setSpeakerName: (id, name) => set(s => ({
    project: s.project
      ? { ...s.project, speakerNames: { ...s.project.speakerNames, [id]: name.trim() || undefined as any } }
      : null
  })),

  setMusicTrack: (track) => set(s => ({
    project: s.project ? {
      ...s.project,
      musicTracks: { ...s.project.musicTracks, [track.type]: track }
    } : null
  })),

  removeMusicTrack: (type) => set(s => {
    if (!s.project) return {}
    const { [type]: _, ...rest } = s.project.musicTracks
    return { project: { ...s.project, musicTracks: rest } }
  }),

  addBeepMark: (mark) => set(s => ({
    project: s.project ? {
      ...s.project,
      beepMarks: [...s.project.beepMarks, { ...mark, id: `beep_${Date.now()}` }]
    } : null
  })),

  removeBeepMark: (id) => set(s => ({
    project: s.project ? {
      ...s.project,
      beepMarks: s.project.beepMarks.filter(b => b.id !== id)
    } : null
  })),

  // ── 真实流程后处理 ────────────────────────────────

  setAnalysisStatus: (msg) => set(s => ({
    project: s.project ? { ...s.project, analysis_status: msg } : null
  })),

  // 接收 Claude 分析结果，应用到 store 并进入粗剪
  setAnalysisResult: ({ sections, chunks, moveOps }) => set(s => ({
    project: s.project ? {
      ...s.project,
      sections,
      chunks,
      chunks_original: chunks,
      move_ops: moveOps,
      stage: 'rough_cut',
      analysis_status: undefined,
    } : null
  })),

  // 转写完成后进入 analyzing 阶段（由 Workspace.tsx 调用，已完成 mergeFragments）
  beginAnalysis: (mergedChunks: Chunk[]) => set(s => ({
    project: s.project ? {
      ...s.project,
      chunks: mergedChunks,
      chunks_original: mergedChunks,
      chunks_partial: [],
      transcription_progress: 1,
      stage: 'analyzing',
      analysis_status: 'AI 正在分析话题结构…',
    } : null
  })),

  reset: () => set({ project: null, _needsReanalysis: false }),

  // ── 断点续传 ──────────────────────────────────────
  // 规整中断时的 stage，标记是否需要重跑分析
  prepareForResume: () => set(s => {
    if (!s.project) return {}
    const p = s.project
    const clean = {
      ...p,
      transcription_error: undefined,
      model_status: undefined,
      model_download_ratio: undefined,
      analysis_status: undefined,
    }
    // 已完成阶段：直接恢复
    if (p.stage === 'rough_cut' || p.stage === 'editing' || p.stage === 'exporting') {
      return { project: clean, _needsReanalysis: false }
    }
    // 分析阶段中断 OR 转写有部分数据：切到 analyzing，Workspace 重跑
    if ((p.stage === 'analyzing' && p.chunks.length > 0) ||
        (p.stage === 'transcribing' && p.chunks_partial.length > 0)) {
      return {
        project: { ...clean, stage: 'analyzing', analysis_status: 'AI 正在分析话题结构…' },
        _needsReanalysis: true,
      }
    }
    // 无法恢复：保留 source_video，从头转写
    return {
      project: {
        ...clean,
        stage: 'idle',
        chunks: [], chunks_original: [], chunks_partial: [],
        transcription_progress: 0,
        sections: [], move_ops: [], undo_stack: [],
      },
      _needsReanalysis: false,
    }
  }),

  clearResumeFlag: () => set({ _needsReanalysis: false }),
  }),
  {
    name: 'podcut-project',
    // 只持久化 project，运行时状态不存盘
    partialize: (state) => ({ project: state.project }),
  }
))

// DEV: expose store to window for preview/testing
if (import.meta.env.DEV) {
  ;(window as any).__store = useProjectStore
}
