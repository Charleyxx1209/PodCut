/**
 * SetupScreen — 首次启动自动下载必要工具
 * 用户看到的是友好的进度界面，不涉及任何终端命令
 */
import { useEffect, useState } from 'react'
import AppIcon from './AppIcon'

interface ToolStatus {
  id: 'ffmpeg' | 'whisper_cli'
  label: string
  desc: string
  state: 'pending' | 'downloading' | 'done' | 'error'
  progress: number   // 0–1
  error?: string
}

interface SetupScreenProps {
  onComplete: () => void
}

const isTauri = () => typeof window !== 'undefined' && '__TAURI__' in window

export default function SetupScreen({ onComplete }: SetupScreenProps) {
  const [tools, setTools] = useState<ToolStatus[]>([
    { id: 'ffmpeg',      label: '音频处理引擎',  desc: '处理视频、提取音频（ffmpeg）',      state: 'pending', progress: 0 },
    { id: 'whisper_cli', label: 'AI 转写引擎',   desc: '本地语音识别，无需联网（Whisper）', state: 'pending', progress: 0 },
  ])
  const [allDone, setAllDone] = useState(false)

  const setToolState = (id: string, patch: Partial<ToolStatus>) =>
    setTools(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))

  useEffect(() => {
    if (!isTauri()) {
      // 开发环境：模拟下载完成
      setTimeout(() => {
        setTools(prev => prev.map(t => ({ ...t, state: 'done', progress: 1 })))
        setAllDone(true)
      }, 1500)
      return
    }

    let unlistenProgress: (() => void) | null = null
    let unlistenComplete: (() => void) | null = null

    ;(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')

      // 监听进度事件
      unlistenProgress = await listen<{ tool: string; downloaded: number; total: number; ratio: number }>(
        'tool_download_progress', e => {
          const { tool, ratio } = e.payload
          setToolState(tool, { state: 'downloading', progress: ratio })
        }
      )
      unlistenComplete = await listen<{ tool: string }>(
        'tool_download_complete', e => {
          setToolState(e.payload.tool, { state: 'done', progress: 1 })
        }
      )

      // 按顺序下载（先 ffmpeg，再 whisper-cli）
      const downloadTool = async (id: 'ffmpeg' | 'whisper_cli') => {
        setToolState(id, { state: 'downloading', progress: 0 })
        try {
          await invoke('download_tool', { tool: id })
          setToolState(id, { state: 'done', progress: 1 })
        } catch (err) {
          console.error(`[Setup] ${id} download failed:`, err)
          setToolState(id, { state: 'error', error: String(err) })
        }
      }

      await downloadTool('ffmpeg')
      await downloadTool('whisper_cli')

      unlistenProgress?.()
      unlistenComplete?.()
      setAllDone(true)
    })()

    return () => {
      unlistenProgress?.()
      unlistenComplete?.()
    }
  }, [])

  // 全部下载完成后等 0.8s 再跳转（让用户看到完成状态）
  useEffect(() => {
    if (allDone) {
      const t = setTimeout(onComplete, 800)
      return () => clearTimeout(t)
    }
  }, [allDone])

  const hasError = tools.some(t => t.state === 'error')

  return (
    <div style={{
      height: '100vh',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
      gap: '0',
    }}>
      <div style={{ maxWidth: '420px', width: '100%', padding: '0 24px' }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '40px' }}>
          <AppIcon size={28} />
          <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text)' }}>PodCut</span>
        </div>

        {/* 标题 */}
        <h2 style={{
          fontSize: '22px', fontWeight: 600, color: 'var(--text)',
          marginBottom: '8px', letterSpacing: '-0.3px'
        }}>
          {allDone ? '准备完成！' : '正在准备 AI 工具…'}
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '32px', lineHeight: 1.6 }}>
          {allDone
            ? '一切就绪，即将进入工作台。'
            : '首次使用需要下载必要组件，仅需一次，约 1–3 分钟。'
          }
        </p>

        {/* 工具列表 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {tools.map(tool => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>

        {/* 错误时的重试按钮 */}
        {hasError && (
          <div style={{ marginTop: '24px', textAlign: 'center' }}>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              下载遇到问题，请检查网络连接后重试。
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 24px', fontSize: '13px',
                background: 'var(--text)', color: 'var(--bg)',
                border: 'none', borderRadius: 'var(--r-md)',
                cursor: 'pointer', fontWeight: 500
              }}
            >
              重新尝试
            </button>
          </div>
        )}

        {/* 底部说明 */}
        {!allDone && !hasError && (
          <p style={{
            marginTop: '32px', fontSize: '11px',
            color: 'var(--text-muted)', lineHeight: 1.6
          }}>
            所有工具仅保存在您的电脑本地，不上传任何数据。
          </p>
        )}
      </div>
    </div>
  )
}

function ToolRow({ tool }: { tool: ToolStatus }) {
  const { state, label, desc, progress, error } = tool

  const stateColor = {
    pending:     'var(--text-muted)',
    downloading: 'var(--blue)',
    done:        'var(--green)',
    error:       'var(--red)',
  }[state]

  const stateLabel = {
    pending:     '等待中',
    downloading: `${Math.round(progress * 100)}%`,
    done:        '完成',
    error:       '失败',
  }[state]

  const icon = {
    pending:     '○',
    downloading: '↓',
    done:        '✓',
    error:       '✕',
  }[state]

  return (
    <div style={{
      padding: '16px', borderRadius: 'var(--r-md)',
      border: '1px solid var(--border)',
      background: state === 'done' ? 'var(--bg-subtle)' : 'var(--bg)',
      transition: 'background 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '16px', color: stateColor, lineHeight: 1, minWidth: '16px' }}>
            {state === 'downloading'
              ? <Spinner small />
              : icon}
          </span>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>{label}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>{desc}</div>
          </div>
        </div>
        <span style={{ fontSize: '12px', color: stateColor, fontWeight: 500, flexShrink: 0 }}>
          {stateLabel}
        </span>
      </div>

      {/* 进度条 */}
      {(state === 'downloading' || state === 'done') && (
        <div style={{
          height: '3px', borderRadius: '2px',
          background: 'var(--border)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.round(progress * 100)}%`,
            background: state === 'done' ? 'var(--green)' : 'var(--blue)',
            borderRadius: '2px',
            transition: 'width 0.3s ease, background 0.3s',
          }} />
        </div>
      )}

      {/* 错误详情 */}
      {state === 'error' && error && (
        <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '6px' }}>
          {error}
        </div>
      )}
    </div>
  )
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? '14px' : '20px'
  return (
    <span style={{
      display: 'inline-block',
      width: size, height: size,
      border: `2px solid var(--border)`,
      borderTopColor: 'var(--blue)',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      verticalAlign: 'middle',
    }} />
  )
}
