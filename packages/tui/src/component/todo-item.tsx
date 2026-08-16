import type { SessionTodoInfo } from "@ycoding-ai/client"
import { useTheme } from "../context/theme"

export function TodoItem(props: SessionTodoInfo) {
  const { themeV2 } = useTheme()
  const markerColor = () => {
    if (props.status === "completed") return themeV2.text.feedback.success.default
    if (props.status === "in_progress") return themeV2.text.feedback.warning.default
    if (props.status === "cancelled") return themeV2.text.feedback.error.default
    return themeV2.text.subdued
  }
  const contentColor = () => (props.status === "completed" ? themeV2.text.subdued : markerColor())
  // Design row 41 reads "ok   Verify baseline": a two-column marker then three spaces, so the
  // content column lands at 6.
  return (
    <box flexDirection="row" gap={3}>
      <text flexShrink={0} fg={markerColor()}>
        {/* Design markers, measured on boards 11 and 12: "ok" for done, ".." for active. The design
            never shows a pending or cancelled todo, so those keep the same two-column width the
            content alignment depends on. */}
        {props.status === "completed"
          ? "ok"
          : props.status === "in_progress"
            ? ".."
            : props.status === "cancelled"
              ? "xx"
              : "--"}
      </text>
      <text flexGrow={1} wrapMode="word" fg={contentColor()}>
        {props.content}
      </text>
    </box>
  )
}
