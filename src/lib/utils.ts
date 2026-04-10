// ── Shared utilities ────────────────────────────────────────────────

/** Format seconds as M:SS */
export function fmt(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** Is the app running inside Tauri? */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI__' in window

/** Strip extension and directory from a file path/name */
export function fileBaseName(path: string): string {
  return path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'untitled'
}

/** Cap an array to the most-recent `max` items (used for undo stack) */
export function cappedPush<T>(arr: T[], item: T, max = 50): T[] {
  const next = [...arr, item]
  return next.length > max ? next.slice(next.length - max) : next
}
