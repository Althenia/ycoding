import { Show } from "solid-js"
import type { ShellInfo } from "@ycoding-ai/client"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { statusColor } from "./util"

export function ShellOutputHeader(props: { shell: ShellInfo; owner: string }) {
  const { themeV2 } = useTheme()
  return (
    <box flexDirection="row" gap={2} paddingLeft={2} paddingTop={1} height={3} flexShrink={0}>
      <text wrapMode="none" fg={themeV2.text.subdued}>
        y. ycoding
      </text>
      <text wrapMode="none" fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
        {props.shell.command}
      </text>
      <text wrapMode="none" fg={themeV2.text.subdued}>
        {props.owner}
      </text>
      <Show when={props.shell.pid !== undefined}>
        <text wrapMode="none" fg={themeV2.text.hint}>
          pid {props.shell.pid}
        </text>
      </Show>
      <text wrapMode="none" fg={statusColor(props.shell.status, themeV2)}>
        {props.shell.status}
      </text>
    </box>
  )
}
