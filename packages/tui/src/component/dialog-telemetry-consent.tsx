import { For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { dialogMessageLines } from "../ui/dialog"

export function DialogTelemetryConsent(props: { onSelect: (enabled: boolean) => void }) {
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const width = () => Math.max(1, Math.min(76, dimensions().width - 4))
  const copy = dialogMessageLines(
    "Save usage, speed, and latency for each provider, model, and profile on this machine only. Nothing leaves your machine. You can change this anytime from the command palette.",
    Math.max(1, width() - 6),
  )

  return (
    <box
      position="absolute"
      top={4}
      left={Math.max(0, Math.floor((dimensions().width - width()) / 2))}
      width={width()}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.background.surface.offset}
      zIndex={3000}
      onMouseUp={(event: { stopPropagation(): void }) => event.stopPropagation()}
    >
      <box paddingLeft={3} paddingRight={3}>
        <text attributes={TextAttributes.BOLD}>Help improve YCoding</text>
      </box>
      <box paddingTop={1} paddingLeft={3} paddingRight={3}>
        <For each={copy}>{(line) => <box height={1}><text fg={theme.text.subdued}>{line}</text></box>}</For>
      </box>
      <box paddingTop={1} paddingLeft={3} flexDirection="row" gap={4}>
        <text fg={theme.text.feedback.info.default} onMouseUp={() => props.onSelect(true)}>Agree</text>
        <text fg={theme.text.subdued} onMouseUp={() => props.onSelect(false)}>Not now</text>
      </box>
      <box paddingTop={1} paddingLeft={3}><text fg={theme.text.subdued}>You can also choose from the command palette.</text></box>
    </box>
  )
}
