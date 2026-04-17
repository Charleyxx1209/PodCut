/**
 * .podcut 工程文件（JSON）读写
 *
 * PRD §3.12：
 *   格式：.podcut（JSON，可 git 版本管理）
 *   包含：原始文件引用、所有编辑操作（删除/排序/重命名）、Speaker 标签、章节划分
 *   设计为幂等：相同工程文件 + 相同原始音频 → 相同输出
 */
import { useProjectStore, type Project } from '@/store/project'
import { isTauri } from '@/lib/utils'

// ── .podcut 文件结构 ─────────────────────────────────────────────
export interface PodcutFile {
  podcut_version: string
  saved_at: string

  // 核心项目数据
  name: string
  source_video: string
  audio_path?: string
  track_s1?: string
  track_s2?: string
  stage: string
  total_duration_seconds: number

  // 内容
  chunks: any[]
  chunks_original: any[]
  chunks_pre_edit?: any[]
  sections: any[]
  move_ops: any[]

  // 标注 & 配乐
  silences: any[]
  speakerNames: Record<string, string>
  musicTracks: any
  beepMarks: any[]
  sensitiveKeywords?: string[]
}

/** 当前 app 版本 */
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.3.0'

/**
 * 从当前 project 状态生成 .podcut JSON 内容
 * 排除瞬态字段（chunks_partial、progress、error、undo_stack 等）
 */
export function serializeProject(project: Project): string {
  const data: PodcutFile = {
    podcut_version: APP_VERSION,
    saved_at: new Date().toISOString(),

    name: project.name,
    source_video: project.source_video,
    audio_path: project.audio_path,
    track_s1: project.track_s1,
    track_s2: project.track_s2,
    stage: project.stage,
    total_duration_seconds: project.total_duration_seconds,

    chunks: project.chunks,
    chunks_original: project.chunks_original,
    chunks_pre_edit: project.chunks_pre_edit,
    sections: project.sections,
    move_ops: project.move_ops,

    silences: project.silences,
    speakerNames: project.speakerNames,
    musicTracks: project.musicTracks,
    beepMarks: project.beepMarks,
    sensitiveKeywords: project.sensitiveKeywords,
  }
  return JSON.stringify(data)
}

/**
 * 从 .podcut JSON 还原 Project 对象
 * 补齐缺失字段，兼容不同版本的文件
 */
export function deserializeProject(json: string): Project {
  const data: PodcutFile = JSON.parse(json)

  return {
    name: data.name || 'untitled',
    source_video: data.source_video || '',
    audio_path: data.audio_path,
    track_s1: data.track_s1,
    track_s2: data.track_s2,
    stage: (data.stage as any) || 'rough_cut',
    total_duration_seconds: data.total_duration_seconds || 0,

    chunks: data.chunks || [],
    chunks_original: data.chunks_original || [],
    chunks_pre_edit: data.chunks_pre_edit,
    sections: data.sections || [],
    move_ops: data.move_ops || [],

    // 瞬态字段重置
    chunks_partial: [],
    transcription_progress: 1,
    transcription_error: undefined,
    model_status: undefined,
    model_download_ratio: undefined,
    analysis_status: undefined,
    undo_stack: [],
    redo_stack: [],

    silences: data.silences || [],
    speakerNames: data.speakerNames || {},
    musicTracks: data.musicTracks || {},
    beepMarks: data.beepMarks || [],
    sensitiveKeywords: data.sensitiveKeywords || [],
  }
}

// ── Tauri 文件操作 ────────────────────────────────────────────────

/** 保存工程文件（弹出保存对话框） */
export async function saveProjectFile(savePath?: string): Promise<string | null> {
  const project = useProjectStore.getState().project
  if (!project) return null

  if (!isTauri()) {
    // Web 端降级：下载文件
    const content = serializeProject(project)
    const blob = new Blob([content], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name}.podcut`
    a.click()
    URL.revokeObjectURL(url)
    return `${project.name}.podcut`
  }

  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')

  // 如果没有指定路径，弹出保存对话框
  const filePath = savePath || await save({
    defaultPath: `${project.name}.podcut`,
    filters: [{ name: 'PodCut 工程文件', extensions: ['podcut'] }],
  })

  if (!filePath) return null

  const content = serializeProject(project)
  await writeTextFile(filePath, content)
  return filePath
}

/** 打开工程文件（弹出打开对话框） */
export async function loadProjectFile(): Promise<string | null> {
  if (!isTauri()) {
    // Web 端降级：通过 input 选择文件
    return new Promise(resolve => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.podcut'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) { resolve(null); return }
        const text = await file.text()
        try {
          const project = deserializeProject(text)
          useProjectStore.setState({ project })
          resolve(file.name)
        } catch (e) {
          console.error('[loadProjectFile] parse error:', e)
          resolve(null)
        }
      }
      input.click()
    })
  }

  const { open } = await import('@tauri-apps/plugin-dialog')
  const { readTextFile } = await import('@tauri-apps/plugin-fs')

  const filePath = await open({
    filters: [{ name: 'PodCut 工程文件', extensions: ['podcut'] }],
    multiple: false,
  })

  if (!filePath || typeof filePath !== 'string') return null

  const content = await readTextFile(filePath)
  const project = deserializeProject(content)
  useProjectStore.setState({ project })
  return filePath
}
