import type { SessionTodoInfo } from "@ycoding-ai/client"
import { useTheme } from "../context/theme"

export function TodoItem(props: SessionTodoInfo) {
  const { themeV2 } = useTheme()
  const active = () => props.status === "in_progress"
  return (
    <box flexDirection="row" gap={1}>
      <text flexShrink={0} fg={active() ? themeV2.text.feedback.warning.default : themeV2.text.subdued}>
        {props.status === "completed"
          ? "[x]"
          : props.status === "in_progress"
            ? "[>]"
            : props.status === "cancelled"
              ? "[-]"
              : "[ ]"}
      </text>
      <text flexGrow={1} wrapMode="word" fg={active() ? themeV2.text.feedback.warning.default : themeV2.text.subdued}>
        {props.content}
      </text>
    </box>
  )
}
