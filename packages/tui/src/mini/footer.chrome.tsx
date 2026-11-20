/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { ChromeConnectionInstructions } from "../component/chrome-connection-instructions"
import type { RunFooterTheme } from "./theme"

export function RunChromeConnectionBody(props: { theme: () => RunFooterTheme; onClose: () => void }) {
  let scroll: ScrollBoxRenderable | undefined
  useKeyboard((event) => {
    if (event.name === "escape") {
      event.preventDefault()
      props.onClose()
      return
    }
    if (event.name !== "pageup" && event.name !== "pagedown") return
    event.preventDefault()
    scroll?.scrollBy(Math.max(1, scroll.viewport.height) * (event.name === "pageup" ? -1 : 1))
  })

  return (
    <box flexDirection="column" height="100%" paddingTop={1}>
      <text paddingLeft={2} fg={props.theme().text}>Connect Chrome</text>
      <ChromeConnectionInstructions
        inset={2}
        fg={props.theme().text}
        ref={(value) => { scroll = value }}
      />
      <text paddingLeft={2} fg={props.theme().muted}>Page Up/Page Down scroll · Escape close</text>
    </box>
  )
}
