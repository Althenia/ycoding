import { RGBA, TextAttributes } from "@opentui/core"
import { createSignal, For, Show, type JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import { logo, terminal } from "../logo"
import mark from "../../../../assets/brand/ycoding-mark-256.png" with { type: "file" }

export function TerminalLogo(props: { fg: RGBA }) {
  return (
    <box flexDirection="column">
      <For each={terminal}>
        {(line) => (
          <text fg={props.fg} selectable={false}>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

// The bitmap mark needs a real terminal image protocol; ImageRenderable degrades to block glyphs on
// its own, and the terminal fallback covers hosts where decoding or loading fails outright.
export function BrandMark(props: { width?: number; height?: number }) {
  const { themeV2 } = useTheme()
  const [failed, setFailed] = createSignal(false)
  return (
    <Show when={!failed()} fallback={<TerminalLogo fg={themeV2.text.feedback.success.default} />}>
      <box width={props.width ?? 12} height={props.height ?? 6} flexShrink={0}>
        <image source={mark} fit="fit" onError={() => setFailed(true)} />
      </box>
    </Show>
  )
}

export function Logo() {
  const { themeV2 } = useTheme()

  const renderLine = (line: string, fg: RGBA, bold: boolean): JSX.Element[] => {
    const shadow = tint(themeV2.background.default, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char) => {
      if (char === "_") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            {" "}
          </text>
        )
      }
      if (char === "^") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === "~") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === ",") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▄
          </text>
        )
      }
      return (
        <text fg={fg} attributes={attrs} selectable={false}>
          {char}
        </text>
      )
    })
  }

  return (
    <box>
      <For each={logo.left}>
        {(line, index) => (
          <box flexDirection="row" gap={1}>
            <box flexDirection="row">{renderLine(line, themeV2.text.subdued, false)}</box>
            <box flexDirection="row">{renderLine(logo.right[index()], themeV2.text.default, true)}</box>
          </box>
        )}
      </For>
    </box>
  )
}
