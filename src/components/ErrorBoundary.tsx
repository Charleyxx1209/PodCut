import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useProjectStore } from '@/store/project'

interface Props { children: ReactNode }
interface State { hasError: boolean; error?: Error }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined })
  }

  handleFullReset = () => {
    useProjectStore.getState().reset()
    localStorage.removeItem('podcut-project')
    this.setState({ hasError: false, error: undefined })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#faf9f5', fontFamily: 'system-ui, sans-serif',
      }}>
        <div style={{ maxWidth: 480, textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>:/</div>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: '#141413', margin: '0 0 8px' }}>
            PodCut 遇到了问题
          </h2>
          <p style={{ fontSize: 13, color: '#6b6860', margin: '0 0 20px', lineHeight: 1.6 }}>
            应用遇到了意外错误。你可以尝试恢复，或重置项目数据后重新开始。
          </p>

          {this.state.error && (
            <pre style={{
              fontSize: 11, color: '#b0aea5', margin: '0 0 20px',
              padding: '10px 14px', background: '#f0ede4', borderRadius: 8,
              textAlign: 'left', overflow: 'auto', maxHeight: 120,
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {this.state.error.message}
            </pre>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={this.handleReset} style={{
              padding: '8px 20px', fontSize: 13, fontWeight: 500,
              background: '#141413', color: '#faf9f5',
              border: 'none', borderRadius: 6, cursor: 'pointer',
            }}>
              尝试恢复
            </button>
            <button onClick={this.handleFullReset} style={{
              padding: '8px 20px', fontSize: 13,
              background: 'transparent', color: '#6b6860',
              border: '1px solid #e8e6dc', borderRadius: 6, cursor: 'pointer',
            }}>
              重置项目
            </button>
          </div>
        </div>
      </div>
    )
  }
}
