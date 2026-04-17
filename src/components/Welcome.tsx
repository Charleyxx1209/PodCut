import { useRef, useState, useEffect } from 'react'
import { useProjectStore } from '@/store/project'
import AppIcon from './AppIcon'
import { detectOllama, detectWhisperX } from '@/lib/postProcess'
import { isTauri, fileBaseName } from '@/lib/utils'
import { loadProjectFile } from '@/lib/projectFile'

export default function Welcome() {
  const createProject = useProjectStore(s => s.createProject)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)
  const [filename, setFilename] = useState('')
  const [dragging, setDragging] = useState(false)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('podcut_api_key') ?? '')
  const [hfToken, setHfToken] = useState(() => localStorage.getItem('podcut_hf_token') ?? '')
  const [ollamaModel, setOllamaModel] = useState<string | null | 'checking'>('checking')
  const [whisperxInfo, setWhisperxInfo] = useState<{ available: boolean; version?: string } | 'checking'>('checking')

  function saveApiKey(val: string) {
    setApiKey(val)
    if (val.trim()) localStorage.setItem('podcut_api_key', val.trim())
    else localStorage.removeItem('podcut_api_key')
  }

  function saveHfToken(val: string) {
    setHfToken(val)
    if (val.trim()) localStorage.setItem('podcut_hf_token', val.trim())
    else localStorage.removeItem('podcut_hf_token')
  }

  useEffect(() => {
    let alive = true
    detectOllama().then(m => { if (alive) setOllamaModel(m) })
    detectWhisperX().then(info => { if (alive) setWhisperxInfo(info) })
    return () => { alive = false }
  }, [])

  // Tauri：原生文件对话框（异步）
  async function handleTauriImport() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      filters: [{ name: '飞书会议录制', extensions: ['mp4', 'mov', 'webm', 'mp3', 'wav', 'aac'] }],
      multiple: false
    })
    if (!selected || typeof selected !== 'string') return
    const name = fileBaseName(selected)
    createProject(name, selected)
  }

  // 浏览器：同步触发 file input，必须在用户手势内同步调用
  function handleBrowserImport() {
    setPicking(true)
    fileInputRef.current?.click()
    // 500ms 后如果仍未选文件（用户取消/浏览器限制），恢复按钮状态
    setTimeout(() => setPicking(false), 800)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) { setPicking(false); return }
    setFilename(file.name)
    const path = URL.createObjectURL(file)
    const name = fileBaseName(file.name)
    createProject(name, path)
  }

  function handleImportClick() {
    if (isTauri()) handleTauriImport()
    else handleBrowserImport()
  }

  // Tauri 2 原生拖拽：使用 getCurrentWebview().onDragDropEvent()
  useEffect(() => {
    if (!isTauri()) return
    let cleanup: (() => void) | undefined
    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
      getCurrentWebview().onDragDropEvent(async (event) => {
        const type = event.payload.type
        console.log('[DragDrop]', type, event.payload)
        if (type === 'enter' || type === 'over') {
          setDragging(true)
        } else if (type === 'leave') {
          setDragging(false)
        } else if (type === 'drop') {
          setDragging(false)
          // Tauri 2: payload.paths 是绝对路径数组
          const paths = (event.payload as unknown as { paths: string[] }).paths
          const filePath = paths?.[0]
          console.log('[DragDrop] dropped filePath:', filePath)
          if (filePath) {
            // .podcut 文件 → 打开工程
            if (filePath.endsWith('.podcut')) {
              const { readTextFile } = await import('@tauri-apps/plugin-fs')
              const { deserializeProject } = await import('@/lib/projectFile')
              try {
                const content = await readTextFile(filePath)
                const project = deserializeProject(content)
                useProjectStore.setState({ project })
              } catch (e) {
                console.error('[DragDrop] .podcut parse error:', e)
              }
              return
            }
            // 音视频文件 → 新建项目
            const name = fileBaseName(filePath)
            createProject(name, filePath)
          }
        }
      }).then(fn => { cleanup = fn })
    }).catch(e => console.error('[DragDrop] webview import failed:', e))
    return () => { cleanup?.() }
  }, [])

  // 拖拽文件导入（浏览器 HTML5）
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragging(true)
  }
  function handleDragLeave(e: React.DragEvent) {
    // 只在离开整个区域时取消，避免子元素触发 flicker
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    setFilename(file.name)
    const path = URL.createObjectURL(file)
    const name = fileBaseName(file.name)
    createProject(name, path)
  }

  const btnLabel = picking
    ? '选择文件中…'
    : filename
    ? `已选：${filename.slice(0, 20)}${filename.length > 20 ? '…' : ''}`
    : '导入视频 / 音频'

  return (
    <div style={{
      height: '100vh',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      background: 'var(--bg)'
    }}>
      {/* 隐藏 file input — 支持视频 + 音频全格式 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp4,.mov,.webm,.mp3,.wav,.aac,.m4a,.flac"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* 左半：品牌区（支持拖拽导入） */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          display: 'flex', flexDirection: 'column',
          justifyContent: 'center', padding: '80px 72px',
          borderRight: '1px solid var(--border)',
          transition: 'background 0.15s',
          background: dragging ? 'var(--bg-subtle)' : 'var(--bg)',
          outline: dragging ? '2px dashed var(--border-mid)' : '2px dashed transparent',
          outlineOffset: '-12px',
        }}
      >
        {/* 节目标识 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '48px'
        }}>
          <AppIcon size={32} />
          <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text)' }}>
            PodCut
          </span>
        </div>

        <h1 style={{
          fontSize: '42px', fontWeight: 600, lineHeight: 1.2,
          color: 'var(--text)', marginBottom: '20px',
          letterSpacing: '-0.5px'
        }}>
          播客智能<br />剪辑工作台
        </h1>

        <p style={{
          fontSize: '15px', color: 'var(--text-sub)',
          lineHeight: 1.8, maxWidth: '360px', marginBottom: '48px'
        }}>
          导入录制文件，AI 自动转写并按话题切分，逐段审阅粗剪，多轨精剪后一键导出发布。
        </p>

        {/* 导入区域 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
          <button
            onClick={handleImportClick}
            disabled={picking}
            style={{
              padding: '12px 28px',
              background: picking ? 'var(--border)' : 'var(--text)',
              color: picking ? 'var(--text-muted)' : 'var(--bg)',
              border: 'none', borderRadius: 'var(--r-md)',
              fontSize: '14px', fontWeight: 500,
              letterSpacing: '0.01em',
              cursor: picking ? 'default' : 'pointer',
              transition: 'background 0.2s, color 0.2s'
            }}
            onMouseEnter={e => { if (!picking) e.currentTarget.style.opacity = '0.85' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
          >
            {btnLabel}
          </button>

          <button
            onClick={() => loadProjectFile()}
            style={{
              padding: '10px 24px',
              background: 'transparent',
              color: 'var(--text-sub)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)',
              fontSize: '13px', fontWeight: 500,
              cursor: 'pointer',
              transition: 'border-color 0.2s, color 0.2s'
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-mid)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-sub)' }}
          >
            打开工程文件
          </button>

          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            支持 .mp4 · .mov · .webm · .mp3 · .wav · .m4a · .podcut
          </span>

          {import.meta.env.DEV && (
            <button
              onClick={() => createProject('不可计算EP42_mock', '/mock/video.mp4')}
              style={{
                padding: '7px 16px',
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                fontSize: '12px',
                marginTop: '2px'
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-sub)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              ⚡ 快速测试（Mock 数据）
            </button>
          )}
        </div>
      </div>

      {/* 右半：流程说明 */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        justifyContent: 'center', padding: '80px 72px',
        background: 'var(--bg-subtle)'
      }}>
        <div style={{
          fontSize: '11px', color: 'var(--text-muted)',
          letterSpacing: '0.12em', textTransform: 'uppercase',
          marginBottom: '32px'
        }}>
          工作流程
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
          {[
            { step: '01', title: '粗剪', desc: 'AI 转写并按话题切分章节，审阅每轮对话，标记保留或舍弃，处理折返内容' },
            { step: '02', title: '精剪', desc: '多轨波形精细控制，配乐淡入淡出，敏感词消音处理' },
            { step: '03', title: '导出', desc: '导出常见音频格式，一键关联小宇宙账号上传发布' },
          ].map((item, i) => (
            <div key={i} style={{
              display: 'flex', gap: '20px', alignItems: 'flex-start',
              padding: '20px 0',
              borderBottom: i < 2 ? '1px solid var(--border)' : 'none'
            }}>
              <span style={{
                fontSize: '11px', color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums', paddingTop: '2px',
                flexShrink: 0
              }}>
                {item.step}
              </span>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text)', marginBottom: '4px' }}>
                  {item.title}
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-sub)', lineHeight: 1.6 }}>
                  {item.desc}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* AI 分析引擎状态 */}
        <div style={{
          marginTop: '40px', paddingTop: '24px',
          borderTop: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px', letterSpacing: '0.04em' }}>
            AI 分析引擎
          </div>

          {/* WhisperX 状态 */}
          {whisperxInfo !== 'checking' && whisperxInfo.available && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '8px 12px', borderRadius: 6, marginBottom: '8px',
              background: 'rgba(100,130,180,0.08)', border: '1px solid rgba(100,130,180,0.2)',
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue, #5b8abf)', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)' }}>
                  WhisperX v{whisperxInfo.version}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {hfToken ? '已就绪，将优先用于说话人分离' : '需配置 HuggingFace Token'}
                </div>
              </div>
            </div>
          )}

          {/* WhisperX HF Token 输入 */}
          {whisperxInfo !== 'checking' && whisperxInfo.available && !hfToken && (
            <div style={{ marginBottom: '8px' }}>
              <input
                type="password"
                value={hfToken}
                onChange={e => saveHfToken(e.target.value)}
                placeholder="hf_…（HuggingFace Access Token）"
                style={{
                  width: '100%', padding: '8px 12px',
                  fontSize: '12px', fontFamily: 'var(--font-ui)',
                  border: '1px solid var(--border)',
                  borderRadius: 6, background: 'var(--bg)',
                  color: 'var(--text)', outline: 'none',
                  boxSizing: 'border-box',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-mid)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                说话人分离需要 HuggingFace Token（huggingface.co/settings/tokens）
              </div>
            </div>
          )}
          {whisperxInfo !== 'checking' && whisperxInfo.available && hfToken && (
            <div style={{ fontSize: '11px', color: 'var(--green)', marginBottom: '8px' }}>
              HF Token 已配置
              <button
                onClick={() => saveHfToken('')}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-muted)',
                  fontSize: '11px', cursor: 'pointer', marginLeft: '8px', textDecoration: 'underline',
                }}
              >
                清除
              </button>
            </div>
          )}

          {/* WhisperX 未安装提示 */}
          {whisperxInfo !== 'checking' && !whisperxInfo.available && (
            <details style={{ marginBottom: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
              <summary style={{ cursor: 'pointer', marginBottom: '6px' }}>
                WhisperX 未安装（可选，精确说话人分离）
              </summary>
              <div style={{
                padding: '8px 12px', borderRadius: 6,
                background: 'var(--bg)', border: '1px solid var(--border)',
                fontSize: '11px', lineHeight: 1.7, fontFamily: 'var(--font-mono, monospace)',
              }}>
                pip install whisperx<br />
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>
                  安装后重启 PodCut 即可自动检测。需要 Python 3.8+ 和 PyTorch。
                </span>
              </div>
            </details>
          )}

          {/* Ollama 状态 */}
          {ollamaModel === 'checking' && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>检测本地模型…</div>
          )}
          {ollamaModel && ollamaModel !== 'checking' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '8px 12px', borderRadius: 6,
              background: 'rgba(120,140,93,0.08)', border: '1px solid rgba(120,140,93,0.2)',
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)' }}>
                  本地 Ollama · {ollamaModel}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>已就绪，无需 API Key</div>
              </div>
            </div>
          )}
          {ollamaModel === null && (
            <>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                未检测到本地 Ollama，可配置 Anthropic API Key 备用
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={e => saveApiKey(e.target.value)}
                placeholder="sk-ant-…"
                style={{
                  width: '100%', padding: '8px 12px',
                  fontSize: '12px', fontFamily: 'var(--font-ui)',
                  border: '1px solid var(--border)',
                  borderRadius: 6, background: 'var(--bg)',
                  color: 'var(--text)', outline: 'none',
                  boxSizing: 'border-box',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-mid)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
              {apiKey && (
                <div style={{ fontSize: '11px', color: 'var(--green)', marginTop: '5px' }}>
                  ✓ 已配置 Claude API Key
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ marginTop: '20px', fontSize: '12px', color: 'var(--text-muted)' }}>
          不可计算 · 播客工作台
          <span style={{ marginLeft: '8px', opacity: 0.5 }}>v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  )
}
