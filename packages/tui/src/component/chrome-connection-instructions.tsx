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
          Finish setup in the macOS menu bar at YCoding &gt; Connect Chrome.
        </text>
        <text fg={props.fg} wrapMode="word">
          If the menu is missing, run YCoding on macOS 14 or later with the signed YCoding Interaction app beside ycoding and the service listening on 127.0.0.1.
        </text>
        <text fg={props.fg} wrapMode="word">
          In chrome://extensions, turn on Developer mode and use Load unpacked to select ycoding-chrome-extension beside ycoding.
          Reload the extension after an update if it still shows the old popup.
        </text>
        <text fg={props.fg} wrapMode="word">
          Authenticate in the native menu. In the YCoding Interaction popup, enter the Local service address and Pairing code from the native panel, then choose Connect.
        </text>
        <text fg={props.fg} wrapMode="word">
          Pairing connects the Chrome profile. Session control and site access require separate approval.
        </text>
      </box>
    </scrollbox>
  )
}
