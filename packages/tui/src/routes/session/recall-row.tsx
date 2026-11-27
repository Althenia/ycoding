import type { BoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { recallDetails, recallSummary, type RecallEntry, type RecallItemDetail, type RecallTarget } from "@ycoding-ai/client/cue-recall"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { getGlyph } from "../../ui/glyph"
import { stringWidth } from "../../util/string-width"

function ItemDetail(props: { item: RecallItemDetail; onInspect?: (target: RecallTarget) => void }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.text.default} wrapMode="word">{props.item.title}</text>
        <Show when={props.onInspect}>
          {(inspect) => (
            <text
              fg={theme.text.action.primary.default}
              onMouseUp={(event: { stopPropagation: () => void }) => {
                event.stopPropagation()
                inspect()(props.item.target)
              }}
            >
              {"  inspect"}
            </text>
          )}
        </Show>
      </box>
      <For each={props.item.rows}>
        {(line) => (
          <text fg={theme.text.subdued} wrapMode="word">
            {"  "}
            <span style={{ fg: theme.text.label }}>{line.label}</span> {line.value}
          </text>
        )}
      </For>
    </box>
  )
}

export function SessionRecallRow(props: {
  entry: RecallEntry
  width?: number
  onInspect?: (target: RecallTarget) => void
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)
  const [withheld, setWithheld] = createSignal(false)
  const summary = createMemo(() => recallSummary(props.entry))
  const details = createMemo(() => recallDetails(props.entry))
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
        <text width={2} flexShrink={0} fg={theme.text.feedback.info.default}>{getGlyph("recall").glyph}</text>
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
          <For each={details().header}>
            {(line) => (
              <text fg={theme.text.subdued} wrapMode="word">
                <span style={{ fg: theme.text.label }}>{line.label}</span> {line.value}
              </text>
            )}
          </For>
          <For each={details().items}>{(item) => <ItemDetail item={item} onInspect={props.onInspect} />}</For>
          <Show when={details().withheld.length > 0}>
            <text
              fg={theme.text.subdued}
              onMouseUp={(event: { stopPropagation: () => void }) => {
                event.stopPropagation()
                setWithheld((value) => !value)
              }}
            >
              {withheld() ? "-" : "+"} {details().withheld.length} not injected · {details().counts.candidates} candidates ·{" "}
              {details().counts.selected} selected · {details().counts.injected} injected
            </text>
            <Show when={withheld()}>
              <For each={details().withheld}>{(item) => <ItemDetail item={item} />}</For>
            </Show>
          </Show>
        </box>
      </Show>
    </box>
  )
}
