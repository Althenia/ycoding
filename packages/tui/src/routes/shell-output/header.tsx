import { Show } from "solid-js"
import type { ShellInfo } from "@ycoding-ai/client"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { statusColor } from "./util"
import { formatShellElapsed } from "../session/composer/shell-tab"

export function ShellOutputHeader(props: { shell: ShellInfo; owner: string; now: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} paddingLeft={3} paddingRight={3} paddingTop={1} height={3} flexShrink={0}>
      <text wrapMode="none" fg={theme.text.feedback.success.default}>
        y. ycoding
      </text>
      <text wrapMode="none" fg={theme.text.subdued} attributes={TextAttributes.BOLD}>
        {props.shell.command}
      </text>
      <text wrapMode="none" fg={theme.text.hint}>·</text>
      <text wrapMode="none" fg={theme.text.feedback.info.default}>
        {props.owner}
      </text>
      <text wrapMode="none" fg={theme.text.hint}>·</text>
      <text wrapMode="none" fg={theme.text.subdued}>
        <Show when={props.shell.pid !== undefined}>pid {props.shell.pid}</Show>
      </text>
      <box flexGrow={1} />
      <text wrapMode="none" fg={statusColor(props.shell.status, theme)}>
        {props.shell.status} {formatShellElapsed(props.shell, props.now)}
      </text>
    </box>
  )
}
