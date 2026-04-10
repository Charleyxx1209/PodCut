/**
 * Speaker 系统 — 颜色、头像、名称管理
 * 色调：克制、高级，参考 Linear / Vercel / Stripe 设计语言
 */

export interface SpeakerConfig {
  id: string
  name: string
  initial: string
  color: string       // 主色（文字、边框）
  rgb: string         // "r, g, b" 格式，用于 rgba()
}

// 四位 Speaker 调色板 — Claude 品牌三色 + 中灰
// 来源：Anthropic Brand Guidelines
// Orange #d97757 / Blue #6a9bcc / Green #788c5d / Mid Gray #b0aea5
export const SPEAKER_PALETTE: SpeakerConfig[] = [
  { id: 's1', name: '主持人', initial: '主', color: '#d97757', rgb: '217,119,87'  },
  { id: 's2', name: '嘉宾',   initial: '嘉', color: '#6a9bcc', rgb: '106,155,204' },
  { id: 's3', name: '嘉宾 2', initial: '宾', color: '#788c5d', rgb: '120,140,93'  },
  { id: 's4', name: '嘉宾 3', initial: '客', color: '#b0aea5', rgb: '176,174,165' },
]

export function getSpeakerConfig(speakerId: string): SpeakerConfig {
  const direct = SPEAKER_PALETTE.find(c => c.id === speakerId)
  if (direct) return direct

  const numMatch = speakerId.match(/\d+/)
  if (numMatch) {
    return SPEAKER_PALETTE[(parseInt(numMatch[0], 10) - 1) % SPEAKER_PALETTE.length]
  }

  const hash = Array.from(speakerId).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)
  return SPEAKER_PALETTE[Math.abs(hash) % SPEAKER_PALETTE.length]
}

export function colorWithAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Resolve display name: custom override → palette default */
export function getSpeakerDisplayName(
  speakerId: string,
  customNames?: Record<string, string>,
): string {
  return customNames?.[speakerId] ?? getSpeakerConfig(speakerId).name
}

// ─── 转写后处理：按停顿分配 Speaker ────────────────────────────────────
// 规则：静音 > PAUSE_THRESHOLD 秒 → 切换说话人（在主持人/嘉宾间交替）
// 适用于 2 人播客（最常见场景）；多人支持后续扩展
export const SPEAKER_CHANGE_PAUSE_SEC = 1.5

export interface RawChunk {
  id: string; text: string; speaker: string
  t_start: number; t_end: number
  cut_status: 'keep' | 'discard' | 'maybe'
  section_id?: string; cut_reason?: string
}

export function assignSpeakers(chunks: RawChunk[]): RawChunk[] {
  if (!chunks.length) return chunks
  let speakerIdx = 0
  return chunks.map((chunk, i) => {
    const prev = chunks[i - 1]
    if (prev && chunk.t_start - prev.t_end > SPEAKER_CHANGE_PAUSE_SEC) {
      speakerIdx = (speakerIdx + 1) % 2   // 两人节目：s1 ↔ s2
    }
    return { ...chunk, speaker: `s${speakerIdx + 1}` }
  })
}

// ─── 静音段自动丢弃 ────────────────────────────────────────────────────
export interface SilenceRange { start: number; end: number }

export function markSilentChunks(chunks: RawChunk[], silences: SilenceRange[]): RawChunk[] {
  if (!silences.length) return chunks
  return chunks.map(c => {
    const mid = (c.t_start + c.t_end) / 2
    const inSilence = silences.some(s => mid >= s.start && mid <= s.end)
    if (inSilence && c.cut_status === 'keep') {
      return { ...c, cut_status: 'discard', cut_reason: '自动检测：静音段' }
    }
    return c
  })
}
