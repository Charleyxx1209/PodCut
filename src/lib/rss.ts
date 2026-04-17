/**
 * RSS XML 生成器 — 标准播客 RSS 2.0 + iTunes/Podcast 2.0 章节标记
 *
 * 用途：导出后用户可自行上传音频到 OSS/CDN，将 RSS 提交给小宇宙认领。
 * 小宇宙会自动同步 RSS feed 中的新 episode。
 */

import type { Project, Section } from '@/store/project'
import { fmt } from './utils'

export interface RssConfig {
  /** 播客名称 */
  podcastTitle: string
  /** 播客描述 */
  podcastDescription?: string
  /** 播客封面图 URL */
  imageUrl?: string
  /** 本集标题 */
  episodeTitle: string
  /** 本集描述（可选，默认从 sections 生成） */
  episodeDescription?: string
  /** 音频文件公开 URL（用户上传后填写） */
  audioUrl: string
  /** 音频文件大小（字节），可选 */
  audioSize?: number
  /** 音频格式 */
  audioType?: 'audio/mpeg' | 'audio/x-m4a' | 'audio/wav' | 'audio/flac'
  /** 作者名 */
  author?: string
  /** 语言 */
  language?: string
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 秒 → HH:MM:SS */
function hhmmss(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 从项目的 sections + chunks 生成章节列表 */
function buildChapters(project: Project): { title: string; startTime: number }[] {
  if (!project.sections.length) return []
  return project.sections.map(sec => ({
    title: sec.title,
    startTime: findSectionStart(project, sec),
  }))
}

function findSectionStart(project: Project, section: Section): number {
  const chunk = project.chunks.find(c => c.section_id === section.id && c.cut_status !== 'discard')
  return chunk?.t_start ?? 0
}

/** 从 sections 生成 show notes 描述 */
function generateDescription(project: Project): string {
  if (!project.sections.length) return project.name
  const lines = project.sections.map((sec) => {
    const start = findSectionStart(project, sec)
    return `${fmt(start)} ${sec.title}${sec.keywords.length ? ' — ' + sec.keywords.join('、') : ''}`
  })
  return lines.join('\n')
}

/**
 * 生成标准播客 RSS 2.0 XML
 */
export function generateRssXml(project: Project, config: RssConfig): string {
  const now = new Date().toUTCString()
  const lang = config.language || 'zh-cn'
  const author = config.author || ''
  const description = config.episodeDescription || generateDescription(project)
  const chapters = buildChapters(project)
  const keptChunks = project.chunks.filter(c => c.cut_status !== 'discard')
  const totalDuration = keptChunks.length
    ? keptChunks[keptChunks.length - 1].t_end - keptChunks[0].t_start
    : 0

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">

  <channel>
    <title>${escapeXml(config.podcastTitle)}</title>
    <description>${escapeXml(config.podcastDescription || config.podcastTitle)}</description>
    <language>${lang}</language>
    <generator>PodCut</generator>
    <lastBuildDate>${now}</lastBuildDate>
    ${config.imageUrl ? `<itunes:image href="${escapeXml(config.imageUrl)}" />` : ''}
    ${author ? `<itunes:author>${escapeXml(author)}</itunes:author>` : ''}
    <itunes:explicit>false</itunes:explicit>

    <item>
      <title>${escapeXml(config.episodeTitle)}</title>
      <description>${escapeXml(description)}</description>
      <content:encoded><![CDATA[${description.replace(/\n/g, '<br/>')}]]></content:encoded>
      <enclosure
        url="${escapeXml(config.audioUrl)}"
        length="${config.audioSize || 0}"
        type="${config.audioType || 'audio/mpeg'}" />
      <itunes:duration>${hhmmss(totalDuration)}</itunes:duration>
      ${author ? `<itunes:author>${escapeXml(author)}</itunes:author>` : ''}
      <pubDate>${now}</pubDate>
      <guid isPermaLink="false">${escapeXml(`podcut-${project.name}-${Date.now()}`)}</guid>
${chapters.map(ch => `      <!-- chapter: ${escapeXml(ch.title)} @ ${fmt(ch.startTime)} -->
      <psc:chapter xmlns:psc="http://podlove.org/simple-chapters" start="${hhmmss(ch.startTime)}" title="${escapeXml(ch.title)}" />`).join('\n')}
    </item>

  </channel>
</rss>`

  return xml
}
