import type { ShellInfo } from "@ycoding-ai/client"
import type { useTheme } from "../../context/theme"

export function statusColor(
  status: ShellInfo["status"],
  themeV2: ReturnType<typeof useTheme>["themeV2"],
) {
  if (status === "running") return themeV2.text.feedback.success.default
  if (status === "exited") return themeV2.text.feedback.success.default
  if (status === "timeout") return themeV2.text.feedback.warning.default
  return themeV2.text.feedback.error.default
}