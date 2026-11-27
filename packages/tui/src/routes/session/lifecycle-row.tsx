import type { BoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { lifecycleDetails, lifecycleSummary, type LifecycleEntry } from "@ycoding-ai/client/lifecycle"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { getGlyph } from "../../ui/glyph"
import { stringWidth } from "../../util/string-width"

export function SessionLifecycleRow(props: { entry: LifecycleEntry; width?: number }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)
  const summary = createMemo(() => lifecycleSummary(props.entry))
  const details = createMemo(() => lifecycleDetails(props.entry))
  const labelWidth = () =>
    Math.max(1, (props.width ?? dimensions().width) - 1 - 2 - 5 - 1 - stringWidth(summary().meta))
  let element: BoxRenderable | undefined
  const toggle = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    setExpanded((value) => !value)
  }
  return (
    <box
      ref={(value: BoxRenderable) => (element = value)}
      width={props.width ?? "100%"}
      flexDirection="column"
      paddingLeft={1}
      focusable={true}
      onMouseDown={() => element?.focus()}
      onMouseUp={toggle}
      onKeyDown={(key: { name: string }) => {
        if (key.name === "return" || key.name === "space") setExpanded((value) => !value)
      }}
    >
      <box width="100%" border={["top"]} borderColor={theme.border.default} flexDirection="row">
        <text width={2} flexShrink={0} fg={theme.text.feedback.info.default}>{getGlyph("lifecycle").glyph}</text>
        <box width={5} flexShrink={0} flexDirection="row">
          <text width={2} flexShrink={0} fg={theme.text.subdued}>{expanded() ? "-" : "+"}</text>
        </box>
        <text width={labelWidth()} flexShrink={1} wrapMode="none" truncate={true} fg={theme.text.default}>
          {summary().title}
        </text>
        <box flexGrow={1} />
        <text flexShrink={0} fg={theme.text.subdued}>{summary().meta}</text>
      </box>
      <Show when={expanded()}>
        <box flexDirection="column" flexShrink={0} paddingLeft={7} paddingTop={1}>
          <For each={details()}>
            {(line) => (
              <text fg={theme.text.subdued} wrapMode="word">
                <span style={{ fg: theme.text.label }}>{line.label}</span> {line.value}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
