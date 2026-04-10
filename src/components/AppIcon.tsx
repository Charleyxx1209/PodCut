/**
 * PodCut 应用图标
 * 概念：音频波形 + 剪辑切割线
 * 可用于 Welcome 标题区 / Workspace header / 导出报告头部
 */
export default function AppIcon({ size = 32 }: { size?: number }) {
  const r = Math.round(size * 0.22)   // 圆角半径
  const pad = size * 0.18             // 内边距

  // 波形：5 根竖条，各自高度占满区域比例
  const bars = [0.45, 0.85, 0.62, 1.0, 0.55]
  const innerW = size - pad * 2
  const innerH = size - pad * 2
  const barW = innerW / bars.length * 0.44
  const gap  = innerW / bars.length

  return (
    <svg
      width={size} height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 背景 */}
      <rect width={size} height={size} rx={r} fill="#1A1918" />

      {/* 波形竖条 */}
      {bars.map((h, i) => {
        const barH = innerH * h
        const x = pad + i * gap + (gap - barW) / 2
        const y = pad + (innerH - barH) / 2
        return (
          <rect
            key={i}
            x={x} y={y}
            width={barW} height={barH}
            rx={barW / 2}
            fill="white"
            opacity={0.5 + h * 0.5}
          />
        )
      })}

      {/* 剪辑切割线：斜线穿过波形，橙红色 */}
      <line
        x1={pad * 0.6}          y1={size * 0.72}
        x2={size - pad * 0.6}   y2={size * 0.28}
        stroke="#CF4500"
        strokeWidth={size * 0.065}
        strokeLinecap="round"
      />
    </svg>
  )
}
