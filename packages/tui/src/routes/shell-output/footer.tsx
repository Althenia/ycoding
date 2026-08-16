import { createMemo, Show } from "solid-js"
import type { ShellInfo } from "@ycoding-ai/client"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"

export function ShellOutputFooter(props: {
  shell: ShellInfo
  owner: string
  onKill?: () => void
  onBack: () => void
}) {
  const { themeV2 } = useTheme()
  const backShortcut = Keymap.useShortcut("shell-output.back")
  const killShortcut = Keymap.useShortcut("shell-output.kill")
  const back = createMemo(() => backShortcut())
  const kill = createMemo(() => killShortcut())

  return (
    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} height={3} flexShrink={0}>
      <text wrapMode="none" fg={themeV2.text.hint}>
        {props.shell.id}
      </text>
      <Show when={props.shell.pid !== undefined}>
        <text wrapMode="none" fg={themeV2.text.hint}>
          pid {props.shell.pid}
        </text>
      </Show>
      <text wrapMode="none" fg={themeV2.text.hint}>
        {props.owner}
      </text>
      <Show when={props.shell.status === "running"}>
        <text wrapMode="none" fg={themeV2.text.feedback.error.default} onMouseUp={props.onKill}>
          {kill() ?? ""} kill
        </text>
      </Show>
      <text wrapMode="none" fg={themeV2.text.default} onMouseUp={props.onBack}>
        {back() ?? ""} back
      </text>
    </box>
  )
}
