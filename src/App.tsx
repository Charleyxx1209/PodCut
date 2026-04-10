import { useEffect, useState } from 'react'
import { useProjectStore, type Project } from '@/store/project'
import Workspace from '@/components/Workspace'
import Welcome from '@/components/Welcome'
import SetupScreen from '@/components/SetupScreen'

const isTauri = () => typeof window !== 'undefined' && '__TAURI__' in window

type AppPhase = 'checking' | 'setup' | 'ready'

export default function App() {
  const { project, prepareForResume, reset } = useProjectStore()
  const [phase, setPhase] = useState<AppPhase>('checking')
  const [showResume, setShowResume] = useState(false)

  useEffect(() => {
    if (!isTauri()) {
      setPhase('ready')
      return
    }
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const status = await invoke<{ ffmpeg_ok: boolean; whisper_ok: boolean }>('setup_status')
        console.log('[App] setup_status:', status)
        if (status.ffmpeg_ok && status.whisper_ok) {
          setPhase('ready')
        } else {
          setPhase('setup')
        }
      } catch (e) {
        console.error('[App] setup_status failed:', e)
        setPhase('ready')
      }
    })()
  }, [])

  // 有保存的未完成项目时弹出询问
  useEffect(() => {
    if (phase === 'ready' && project && project.stage !== 'idle') {
      setShowResume(true)
    }
  }, [phase])

  if (phase === 'checking') return <SplashScreen />
  if (phase === 'setup') return <SetupScreen onComplete={() => setPhase('ready')} />

  if (showResume && project) {
    return (
      <ResumeDialog
        project={project}
        onResume={() => { prepareForResume(); setShowResume(false) }}
        onDiscard={() => { reset(); setShowResume(false) }}
      />
    )
  }

  return project ? <Workspace /> : <Welcome />
}

// ── 恢复会话对话框 ────────────────────────────────────────────────

function stageHint(p: Project): string {
  switch (p.stage) {
    case 'rough_cut': return '粗剪进行中'
    case 'editing':   return '精剪进行中'
    case 'exporting': return '导出阶段'
    case 'analyzing': return 'AI 分析中断 — 将重新运行分析'
    case 'transcribing':
      return p.chunks_partial.length > 0
        ? `转写中断（已完成 ${Math.round(p.transcription_progress * 100)}%）— 将重新分析`
        : '转写被中断 — 将从头重新转写'
    case 'extracting': return '处理被中断 — 将从头重新转写'
    default: return p.stage
  }
}

function ResumeDialog({ project, onResume, onDiscard }: {
  project: Project
  onResume: () => void
  onDiscard: () => void
}) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        width: 380,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        padding: '32px 28px',
        display: 'flex', flexDirection: 'column', gap: 20,
      }}>
        <div>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 8px' }}>发现上次未完成的工作</p>
          <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
            {project.name}
          </p>
          <p style={{ fontSize: '12px', color: 'var(--text-sub)', margin: '6px 0 0' }}>
            {stageHint(project)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onDiscard}
            style={{
              flex: 1, padding: '9px 0', fontSize: '13px',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            重新开始
          </button>
          <button
            onClick={onResume}
            style={{
              flex: 2, padding: '9px 0', fontSize: '13px', fontWeight: 500,
              background: 'var(--text)',
              border: 'none',
              borderRadius: 'var(--r-sm)',
              color: 'var(--bg)', cursor: 'pointer',
            }}
          >
            继续上次
          </button>
        </div>
      </div>
    </div>
  )
}

// 启动检查期间显示简单 logo（< 500ms 通常看不到）
function SplashScreen() {
  return (
    <div style={{
      height: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        width: '32px', height: '32px',
        border: '2px solid var(--border)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
    </div>
  )
}
