import type { ShellInfo } from "@ycoding-ai/client"
import { useTheme } from "../../context/theme"
import { formatShellElapsed } from "../session/composer/shell-tab"
import { statusColor } from "./util"

export function ShellOutputMetadata(props: { shell: ShellInfo; owner: string; now: number }) {
  const { themeV2 } = useTheme()
  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={3}
      height={11}
      flexShrink={0}
      backgroundColor={themeV2.background.surface.offset}
    >
      <box flexDirection="row">
        <box width={48} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={themeV2.text.subdued}>Owner</text>
          <text wrapMode="none" fg={themeV2.text.default}>{props.owner}</text>
        </box>
        <box width={47} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={themeV2.text.subdued}>Status</text>
          <text wrapMode="none" fg={statusColor(props.shell.status, themeV2)}>{props.shell.status}</text>
        </box>
        <box width={47} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={themeV2.text.subdued}>Started</text>
          <text wrapMode="none" fg={themeV2.text.default}>{formatShellElapsed(props.shell, props.now)} ago</text>
        </box>
        <box flexGrow={1} flexDirection="column" gap={1}>
          <text wrapMode="none" fg={themeV2.text.subdued}>Capture</text>
          <text wrapMode="none" fg={themeV2.text.feedback.info.default}>{props.shell.file}</text>
        </box>
      </box>
    </box>
  )
}
