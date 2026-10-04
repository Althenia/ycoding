import type { ShellInfo } from "@ycoding-ai/client"
import type { useTheme } from "../../context/theme"

export function statusColor(
  status: ShellInfo["status"],
  theme: ReturnType<typeof useTheme>["theme"],
) {
  if (status === "running") return theme.text.feedback.success.default
  if (status === "exited") return theme.text.feedback.success.default
  if (status === "timeout") return theme.text.feedback.warning.default
  return theme.text.feedback.error.default
}