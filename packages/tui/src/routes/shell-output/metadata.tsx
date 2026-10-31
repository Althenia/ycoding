import type { ShellInfo } from "@ycoding-ai/client"
import { useTheme } from "../../context/theme"
import { formatShellElapsed } from "../session/composer/shell-tab"
import { statusColor } from "./util"
import { SplitBorder } from "../../ui/border"

export function ShellOutputMetadata(props: { shell: ShellInfo; owner: string; now: number }) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={1}
      border={["left"]}
      borderColor={statusColor(props.shell.status, theme)}
      customBorderChars={SplitBorder.customBorderChars}
      flexShrink={0}
      backgroundColor={theme.background.surface.offset}
    >
      <text wrapMode="word"><span style={{ fg: theme.text.subdued }}>Owner </span>{props.owner}</text>
      <text wrapMode="word"><span style={{ fg: theme.text.subdued }}>Status </span><span style={{ fg: statusColor(props.shell.status, theme) }}>{props.shell.status}</span></text>
      <text wrapMode="word"><span style={{ fg: theme.text.subdued }}>Started </span>{formatShellElapsed(props.shell, props.now)} ago</text>
      <text wrapMode="word"><span style={{ fg: theme.text.subdued }}>Capture </span><span style={{ fg: theme.text.feedback.info.default }}>{props.shell.file}</span></text>
    </box>
  )
}
