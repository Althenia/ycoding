import type { ShellInfo } from "@ycoding-ai/client"
import type { useTheme } from "../../context/theme"

export function statusColor(status: ShellInfo["status"], theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "running") return theme.text.feedback.success.default
  if (status === "exited") return theme.text.feedback.success.default
  if (status === "timeout") return theme.text.feedback.warning.default
  return theme.text.feedback.error.default
}

export const SHELL_OUTPUT_TAIL_LIMIT = 256 * 1024

export function appendShellOutputTail(current: string, page: string, limit: number = SHELL_OUTPUT_TAIL_LIMIT): string {
  const text = current + page
  if (text.length <= limit) return text
  const tail = text.slice(-limit)
  const newline = tail.indexOf("\n")
  return newline > 0 && newline < limit / 2 ? tail.slice(newline + 1) : tail
}
