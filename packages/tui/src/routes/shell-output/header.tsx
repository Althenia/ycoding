import { Show } from "solid-js"
import type { ShellInfo } from "@ycoding-ai/client"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { statusColor } from "./util"
import { formatShellElapsed } from "../session/composer/shell-tab"

export function ShellOutputHeader(props: { shell: ShellInfo; owner: string; now: number }) {
  const { themeV2 } = useTheme()
  return (
    <box flexDirection="row" gap={1} paddingLeft={3} paddingRight={3} paddingTop={1} height={3} flexShrink={0}>
      <text wrapMode="none" fg={themeV2.text.feedback.success.default}>
        y. ycoding
      </text>
      <text wrapMode="none" fg={themeV2.text.subdued} attributes={TextAttributes.BOLD}>
        {props.shell.command}
      </text>
      <text wrapMode="none" fg={themeV2.text.hint}>·</text>
      <text wrapMode="none" fg={themeV2.text.feedback.info.default}>
        {props.owner}
      </text>
      <text wrapMode="none" fg={themeV2.text.hint}>·</text>
      <text wrapMode="none" fg={themeV2.text.subdued}>
        <Show when={props.shell.pid !== undefined}>pid {props.shell.pid}</Show>
      </text>
      <box flexGrow={1} />
      <text wrapMode="none" fg={statusColor(props.shell.status, themeV2)}>
        {props.shell.status} {formatShellElapsed(props.shell, props.now)}
      </text>
    </box>
  )
}
