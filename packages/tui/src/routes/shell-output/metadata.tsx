import type { ShellInfo } from "@ycoding-ai/client"
import { useTheme } from "../../context/theme"
import { formatShellElapsed } from "../session/composer/shell-tab"
import { statusColor } from "./util"

export function ShellOutputMetadata(props: { shell: ShellInfo; owner: string; now: number }) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={3}
      height={11}
      flexShrink={0}
      backgroundColor={theme.background.surface.offset}
    >
      <box flexDirection="row">
        <box width={48} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={theme.text.subdued}>Owner</text>
          <text wrapMode="none" fg={theme.text.default}>{props.owner}</text>
        </box>
        <box width={47} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={theme.text.subdued}>Status</text>
          <text wrapMode="none" fg={statusColor(props.shell.status, theme)}>{props.shell.status}</text>
        </box>
        <box width={47} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={theme.text.subdued}>Started</text>
          <text wrapMode="none" fg={theme.text.default}>{formatShellElapsed(props.shell, props.now)} ago</text>
        </box>
        <box flexGrow={1} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={theme.text.subdued}>Capture</text>
          <text wrapMode="none" fg={theme.text.feedback.info.default}>{props.shell.file}</text>
        </box>
      </box>
    </box>
  )
}
