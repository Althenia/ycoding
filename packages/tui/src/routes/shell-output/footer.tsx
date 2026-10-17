import { Show } from "solid-js"
import type { ShellInfo } from "@ycoding-ai/client"
import { useTheme } from "../../context/theme"

export function ShellOutputFooter(props: {
  shell: ShellInfo
  owner: string
  onKill?: () => void
  onBack: () => void
}) {
  const { theme } = useTheme()

  return (
    <box flexDirection="row" gap={2} paddingLeft={3} paddingRight={3} paddingTop={1} height={3} flexShrink={0}>
      <text wrapMode="none" fg={theme.text.hint}>
        {props.shell.id}
      </text>
      <Show when={props.shell.pid !== undefined}>
        <text wrapMode="none" fg={theme.text.hint}>
          pid {props.shell.pid}
        </text>
      </Show>
      <text wrapMode="none" fg={theme.text.hint}>
        {props.owner}
      </text>
      <box flexGrow={1} />
      <box flexDirection="row" gap={1}>
        <Show when={props.shell.status === "running"}>
          <text wrapMode="none" fg={theme.text.feedback.info.default} onMouseUp={props.onKill}>
            ⌃x k kill ·
          </text>
        </Show>
        <text wrapMode="none" fg={theme.text.feedback.info.default} onMouseUp={props.onBack}>
          Esc back
        </text>
      </box>
    </box>
  )
}
