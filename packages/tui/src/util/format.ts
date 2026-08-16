export function formatDuration(secs: number) {
  const seconds = Math.floor(secs)
  if (seconds <= 0) return ""
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const remaining = seconds % 60
    return `${mins}m${String(remaining).padStart(2, "0")}s`
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600)
    const remaining = Math.floor((seconds % 3600) / 60)
    return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`
  }
  if (seconds < 604800) {
    const days = Math.floor(seconds / 86400)
    return days === 1 ? "~1 day" : `~${days} days`
  }
  const weeks = Math.floor(seconds / 604800)
  return weeks === 1 ? "~1 week" : `~${weeks} weeks`
}
