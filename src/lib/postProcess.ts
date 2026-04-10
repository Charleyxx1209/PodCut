/**
 * postProcess — 转写后处理流水线
 *
 * Step 1: mergeFragments    — 合并 Whisper 碎片为句子级 Chunk（保留 s0 占位，不做说话人判断）
 * Step 2: diarizeWithOllama — Qwen 文字识别说话人（分批，每批 120 段）
 * Step 3: analyzeWithClaude — Qwen / Claude 生成章节 + 折返标注 + 丢弃建议
 */

import type { Chunk, Section, MoveOp } from '@/store/project'
import { isTauri } from '@/lib/utils'

// ── 常量 ─────────────────────────────────────────────────────────────
const MERGE_GAP_SEC = 0.6   // 间隔 < 此值 → 合并到同一句
const MAX_CHUNK_SEC = 45    // 单句最长不超过此值（超过则断句）
const DIARIZE_BATCH = 100   // 每批送给 Qwen 的段落数（降低以提升准确度）
const DIARIZE_OVERLAP = 15  // 批次重叠段数（增大以保持上下文连贯）
const MAX_SAME_SPEAKER_CHUNKS = 30  // 连续同 speaker 超过此数触发修正

// ── Step 1: 碎片合并 ─────────────────────────────────────────────────
// 只做合并，不分说话人（speaker 暂设 "s0"，等 Step 2 覆盖）
export function mergeFragments(rawChunks: Chunk[]): Chunk[] {
  if (!rawChunks.length) return []

  const merged: Chunk[] = []
  let parts: string[] = []
  let gId = '', gStart = 0, gEnd = 0

  function flush() {
    if (!parts.length) return
    merged.push({
      id: gId, text: parts.join(' '),
      speaker: 's0', t_start: gStart, t_end: gEnd, cut_status: 'keep',
    })
    parts = []
  }

  for (const c of rawChunks) {
    if (!parts.length) {
      gId = c.id; gStart = c.t_start; gEnd = c.t_end; parts = [c.text.trim()]
      continue
    }
    const gap = c.t_start - gEnd
    const tooLong = (c.t_end - gStart) > MAX_CHUNK_SEC

    if (gap <= MERGE_GAP_SEC && !tooLong) {
      gEnd = c.t_end; parts.push(c.text.trim())
    } else {
      flush()
      gId = c.id; gStart = c.t_start; gEnd = c.t_end; parts = [c.text.trim()]
    }
  }
  flush()

  return merged.map((c, i) => ({
    ...c, id: `chunk_${String(i + 1).padStart(4, '0')}`,
  }))
}

// ── Ollama helper ────────────────────────────────────────────────────

export async function detectOllama(): Promise<string | null> {
  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) return null
    const data = await resp.json() as { models: Array<{ name: string }> }
    const qwen = data.models.find(m => m.name.toLowerCase().includes('qwen'))
    return qwen?.name ?? data.models[0]?.name ?? null
  } catch { return null }
}

async function callOllama(model: string, prompt: string, maxTokens = 4096): Promise<string> {
  const resp = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0.05, num_predict: maxTokens },
    }),
  })
  const data = await resp.json() as { choices: Array<{ message: { content: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

async function callClaude(apiKey: string, bodyJson: string): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<string>('call_claude_api', { apiKey, bodyJson })
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json', 'anthropic-dangerous-request-header': 'true',
    },
    body: bodyJson,
  })
  return resp.text()
}

// ── 解析 JSON 数组辅助 ──────────────────────────────────────────────
function parseSpeakerJSON(raw: string): Array<{ id: string; speaker: string }> {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as Array<{ id: string; speaker: string }>
    return arr.filter(r => r.id && (r.speaker === 's1' || r.speaker === 's2'))
  } catch { return [] }
}

// ── Step 2: Qwen 文字说话人识别 ───────────────────────────────────────
// 策略：
//   ① 先用前 60 段让 Qwen 描述两个说话人的说话特征（主持人 vs 嘉宾）
//   ② 再分批（每批 DIARIZE_BATCH 段，带 DIARIZE_OVERLAP 段重叠）让 Qwen 打标签
//   ③ 对 Qwen 没有返回的 id，用停顿+语义启发式补全
//   ④ 后处理：修正连续过长的单人片段

export async function diarizeWithOllama(
  chunks: Chunk[],
  model: string,
  onStatus?: (msg: string) => void,
): Promise<Chunk[]> {
  onStatus?.('Qwen 识别说话人特征…')

  // ── ① 特征描述 + 首批标注（前 60 段）
  const sampleChunks = chunks.slice(0, 60)
  const sampleLines = sampleChunks
    .map(c => `[${c.id}] ${c.text}`)
    .join('\n')

  const featurePrompt = `你是播客说话人识别专家。以下是一期中文播客的逐字稿片段，有两位说话人：s1（主持人）和 s2（嘉宾）。

请分析每段文字的说话风格（提问/回答、语气、用词），判断说话人。

规则：
- 提问、引导话题、衔接转场的通常是 s1（主持人）
- 回答、分享经历、详细阐述的通常是 s2（嘉宾）
- 注意对话中说话人交替：一段结束后另一个人接话
- 停顿间隔 > 2 秒时，很可能说话人切换了

只输出 JSON 数组，不输出任何其他文字：
[{"id":"chunk_0001","speaker":"s1"},{"id":"chunk_0002","speaker":"s2"},...]

片段：
${sampleLines}`

  const speakerMap = new Map<string, string>()
  let featureRaw = ''
  try {
    featureRaw = await callOllama(model, featurePrompt, 3072)
    parseSpeakerJSON(featureRaw).forEach(r => speakerMap.set(r.id, r.speaker))
  } catch { /* ignore */ }

  // ── ② 分批标注全部段落
  const total = chunks.length

  for (let start = 0; start < total; start += DIARIZE_BATCH - DIARIZE_OVERLAP) {
    const end = Math.min(start + DIARIZE_BATCH, total)
    const batch = chunks.slice(start, end)
    onStatus?.(`Qwen 识别说话人… ${Math.min(end, total)}/${total}`)

    // 上下文：上一批末尾 5 条的结果
    const contextEntries: string[] = []
    for (let i = Math.max(0, start - 5); i < start; i++) {
      const sp = speakerMap.get(chunks[i].id)
      if (sp) contextEntries.push(`[${chunks[i].id}] → ${sp}`)
    }
    const contextHint = contextEntries.length > 0
      ? `\n参考（已确认的上文说话人）：\n${contextEntries.join('\n')}\n`
      : ''

    const lines = batch.map(c => `[${c.id}] ${c.text}`).join('\n')
    const batchPrompt = `播客逐字稿说话人标注。两位说话人：s1（主持人，负责提问、引导）、s2（嘉宾，负责回答、分享）。
${contextHint}
对以下每段标注说话人。注意说话人在对话中交替出现，不会一人连续说太久。
只输出 JSON 数组 [{"id":"...","speaker":"s1或s2"}]，不输出任何其他文字：

${lines}`

    // 尝试最多 2 次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await callOllama(model, batchPrompt, DIARIZE_BATCH * 30)
        const parsed = parseSpeakerJSON(raw)
        if (parsed.length >= batch.length * 0.5) {
          // 成功：超过一半的 chunk 有结果
          parsed.forEach(r => speakerMap.set(r.id, r.speaker))
          break
        }
        // 结果太少，重试
        if (attempt === 0) continue
        // 第二次也不够，用有的结果
        parsed.forEach(r => speakerMap.set(r.id, r.speaker))
      } catch {
        if (attempt === 1) {
          // 两次都失败：用启发式补全（基于停顿间隔交替）
          let prev = speakerMap.get(chunks[Math.max(0, start - 1)]?.id) ?? 's1'
          for (const c of batch) {
            if (speakerMap.has(c.id)) { prev = speakerMap.get(c.id)!; continue }
            // 间隔 > 1.5s → 认为换人
            const prevChunk = chunks[chunks.indexOf(c) - 1]
            if (prevChunk && c.t_start - prevChunk.t_end > 1.5) {
              prev = prev === 's1' ? 's2' : 's1'
            }
            speakerMap.set(c.id, prev)
          }
        }
      }
    }

    await new Promise(r => setTimeout(r, 0))
  }

  // ── ③ 将标签写回 chunks，未标注的沿用前一段
  let lastSpeaker = 's1'
  const result = chunks.map(c => {
    const sp = speakerMap.get(c.id) ?? lastSpeaker
    lastSpeaker = sp
    return { ...c, speaker: sp }
  })

  // ── ④ 后处理：修正连续过长的单人片段
  // 如果同一 speaker 连续超过 MAX_SAME_SPEAKER_CHUNKS 段，
  // 在停顿最长的位置插入说话人切换
  return fixLongRuns(result)
}

function fixLongRuns(chunks: Chunk[]): Chunk[] {
  const result = chunks.map(c => ({ ...c }))
  let runStart = 0

  for (let i = 1; i <= result.length; i++) {
    if (i < result.length && result[i].speaker === result[runStart].speaker) continue

    const runLen = i - runStart
    if (runLen > MAX_SAME_SPEAKER_CHUNKS) {
      // 在这段连续 speaker 中找停顿最长的位置，切换说话人
      const currentSp = result[runStart].speaker

      // 找所有可能的切换点（停顿 > 0.8s）
      const breakpoints: Array<{ idx: number; gap: number }> = []
      for (let j = runStart + 1; j < i; j++) {
        const gap = result[j].t_start - result[j - 1].t_end
        if (gap > 0.8) breakpoints.push({ idx: j, gap })
      }

      if (breakpoints.length > 0) {
        // 按停顿时长排序，取间隔分布均匀的点
        breakpoints.sort((a, b) => b.gap - a.gap)
        // 每 MAX_SAME_SPEAKER_CHUNKS 个 chunk 至少切一次
        const numBreaks = Math.min(
          breakpoints.length,
          Math.ceil(runLen / MAX_SAME_SPEAKER_CHUNKS) - 1
        )
        const breaks = breakpoints.slice(0, numBreaks)
          .sort((a, b) => a.idx - b.idx)

        let sp = currentSp
        for (const bp of breaks) {
          sp = sp === 's1' ? 's2' : 's1'
          for (let j = bp.idx; j < i; j++) {
            const nextBp = breaks.find(b => b.idx > bp.idx)
            if (nextBp && j >= nextBp.idx) break
            result[j] = { ...result[j], speaker: sp }
          }
        }
      }
    }
    runStart = i
  }

  return result
}

// ── Step 3: AI 章节分析 ──────────────────────────────────────────────
export interface AnalysisResult {
  sections: Section[]
  chunks: Chunk[]
  moveOps: MoveOp[]
}

function buildAnalysisPrompt(chunks: Chunk[]): string {
  // 最多采样 500 段，均匀分布
  const sample = chunks.length > 500
    ? chunks.filter((_, i) => i % Math.ceil(chunks.length / 500) === 0)
    : chunks

  const lines = sample.map(c => {
    const t = c.text.length > 120 ? c.text.slice(0, 120) + '…' : c.text
    return `[${c.id}|${c.speaker}] ${t}`
  }).join('\n')

  return `你是专业播客剪辑助手。下面是一期播客逐字稿（句子级），格式 [chunk_id|speaker] text。

任务1（章节划分）：将内容分为 3-8 个话题章节，按时间顺序，用 firstChunkId/lastChunkId 标明范围。
任务2（话题折返）：找出语义不属于当前章节的段落（置信度>0.75），建议移到正确章节。可以为空。
任务3（建议丢弃）：标记应删除的段落（口头禅、重复、跑题闲聊、无意义的语气词段落）。给出简短理由。

只输出合法 JSON，不加其他文字：
{
  "sections":[{"id":"sec_1","title":"标题5-10字","keywords":["词1","词2"],"firstChunkId":"chunk_0001","lastChunkId":"chunk_0050"}],
  "moveOps":[{"chunkId":"chunk_0042","toSectionId":"sec_1","confidence":0.88,"reason":"原因"}],
  "discards":[{"chunkId":"chunk_0015","reason":"重复表述"}]
}

逐字稿（共${chunks.length}段，展示${sample.length}段）：
${lines}`
}

function parseAnalysisJSON(raw: string) {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('返回中没有 JSON')
  return JSON.parse(m[0]) as {
    sections: Array<{ id: string; title: string; keywords: string[]; firstChunkId: string; lastChunkId: string }>
    moveOps:  Array<{ chunkId: string; toSectionId: string; confidence: number; reason: string }>
    discards?: Array<{ chunkId: string; reason: string }>
  }
}

function applyAnalysis(chunks: Chunk[], parsed: ReturnType<typeof parseAnalysisJSON>): AnalysisResult {
  const sections: Section[] = (parsed.sections ?? []).map(s => ({
    id: s.id, title: s.title, keywords: s.keywords ?? [], confirmed: false,
  }))

  const idxMap = new Map(chunks.map((c, i) => [c.id, i]))
  const updatedChunks = chunks.map(c => ({ ...c }))

  // 应用章节标注
  for (const sec of parsed.sections ?? []) {
    const start = idxMap.get(sec.firstChunkId) ?? 0
    const end   = idxMap.get(sec.lastChunkId)   ?? chunks.length - 1
    for (let i = start; i <= end; i++) {
      if (updatedChunks[i]) updatedChunks[i] = { ...updatedChunks[i], section_id: sec.id }
    }
  }

  // 应用丢弃建议
  for (const d of parsed.discards ?? []) {
    const idx = idxMap.get(d.chunkId)
    if (idx !== undefined && updatedChunks[idx]) {
      updatedChunks[idx] = {
        ...updatedChunks[idx],
        cut_status: 'discard',
        cut_reason: d.reason,
      }
    }
  }

  const moveOps: MoveOp[] = (parsed.moveOps ?? []).map(op => {
    const fromIdx   = idxMap.get(op.chunkId) ?? 0
    const targetSec = (parsed.sections ?? []).find(s => s.id === op.toSectionId)
    const hintIdx   = targetSec ? (idxMap.get(targetSec.lastChunkId) ?? fromIdx) + 1 : fromIdx
    return {
      chunk_id: op.chunkId, from_index: fromIdx,
      to_section: op.toSectionId, to_index_hint: hintIdx,
      confidence: op.confidence ?? 0.8, reason: op.reason ?? '',
      status: 'pending' as const,
    }
  })

  return { sections, chunks: updatedChunks, moveOps }
}

// 主入口：章节分析（Ollama 优先，备选 Claude API）
export async function analyzeWithClaude(
  chunks: Chunk[],
  apiKey: string,
  onStatus?: (msg: string) => void,
): Promise<AnalysisResult> {
  const prompt = buildAnalysisPrompt(chunks)

  const ollamaModel = await detectOllama()
  if (ollamaModel) {
    onStatus?.(`Qwen 分析话题章节…`)
    const raw = await callOllama(ollamaModel, prompt, 4096)
    onStatus?.('解析分析结果…')
    try {
      return applyAnalysis(chunks, parseAnalysisJSON(raw))
    } catch {
      // Qwen 返回格式出错 → 不分章节直接进粗剪
      return { sections: [], chunks, moveOps: [] }
    }
  }

  if (!apiKey) return { sections: [], chunks, moveOps: [] }
  onStatus?.('Claude 分析话题章节…')
  const bodyJson = JSON.stringify({
    model: 'claude-haiku-4-5', max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  const respText = await callClaude(apiKey, bodyJson)
  onStatus?.('解析分析结果…')
  try {
    const data = JSON.parse(respText)
    if (data.error) throw new Error(data.error.message)
    return applyAnalysis(chunks, parseAnalysisJSON(data.content?.[0]?.text ?? ''))
  } catch {
    return { sections: [], chunks, moveOps: [] }
  }
}
