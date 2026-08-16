import type { ShellInfo } from "@ycoding-ai/client"
import { useTheme } from "../../context/theme"
import { formatShellElapsed } from "../session/composer/shell-tab"

export function ShellOutputMetadata(props: { shell: ShellInfo; owner: string; now: number }) {
  const { themeV2 } = useTheme()
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={3}
      height={11}
      flexShrink={0}
      backgroundColor={themeV2.background.surface.offset}
    >
      <box flexDirection="row" gap={4} height={1}>
        <text wrapMode="none" fg={themeV2.text.subdued}>
          Owner:{" "}
          <span style={{ fg: themeV2.text.default }}>{props.owner}</span>
        </text>
        <text wrapMode="none" fg={themeV2.text.subdued}>
          Status:{" "}
          <span style={{ fg: themeV2.text.default }}>{props.shell.status}</span>
        </text>
        <text wrapMode="none" fg={themeV2.text.subdued}>
          Started:{" "}
          <span style={{ fg: themeV2.text.default }}>{formatShellElapsed(props.shell, props.now)} ago</span>
        </text>
        <text wrapMode="none" fg={themeV2.text.subdued}>
          Capture: <span style={{ fg: themeV2.text.default }}>{props.shell.file}</span>
        </text>
      </box>
    </box>
  )
}
