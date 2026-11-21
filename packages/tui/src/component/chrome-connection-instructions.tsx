import type { BoxRenderable, ColorInput, ScrollBoxRenderable } from "@opentui/core"
import { createSignal } from "solid-js"

export function ChromeConnectionInstructions(props: {
  inset: number
  maxHeight?: number
  fg?: ColorInput
  ref: (scroll: ScrollBoxRenderable) => void
}) {
  let body: BoxRenderable | undefined
  const [height, setHeight] = createSignal(0)
  return (
    <scrollbox
      ref={(value: ScrollBoxRenderable) => props.ref(value)}
      height={props.maxHeight === undefined ? undefined : Math.min(props.maxHeight, height() || props.maxHeight)}
      flexGrow={props.maxHeight === undefined ? 1 : 0}
      scrollbarOptions={{ visible: false }}
    >
      <box
        ref={(value: BoxRenderable) => {
          body = value
        }}
        onSizeChange={() => setHeight(body?.height ?? 0)}
        paddingX={props.inset}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        flexShrink={0}
        gap={1}
      >
        <text fg={props.fg} wrapMode="word">
          In chrome://extensions, turn on Developer mode and use Load unpacked to select ycoding-chrome-extension beside ycoding.
          Reload the extension after an update if it still shows the old popup.
        </text>
        <text fg={props.fg} wrapMode="word">
          Open the YCoding Interaction popup and choose Connect. When your Mac asks about this Chrome profile, check that it shows the same match code as the popup, then choose Allow.
          If YCoding listens on another local address, set it under Advanced first.
        </text>
        <text fg={props.fg} wrapMode="word">
          Chrome reconnects on its own after that. Use Forget this profile under Advanced in the popup to disconnect it.
        </text>
        <text fg={props.fg} wrapMode="word">
          Connecting needs the signed macOS package with YCoding listening on 127.0.0.1. Session control and site access require separate approval.
        </text>
      </box>
    </scrollbox>
  )
}
