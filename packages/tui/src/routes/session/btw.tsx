import { createEffect } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"

export function BtwContext(props: { parentID: string }) {
  const data = useData()
  const client = useClient()
  const toast = useToast()
  const { themeV2 } = useTheme()
  createEffect(() => {
    if (client.connection.status() !== "connected") return
    void data.session.sync(props.parentID).catch(toast.error)
  })
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
      <text fg={themeV2.text.subdued} wrapMode="none" truncate>
        Parent context snapshot · read-only · {data.session.get(props.parentID)?.title ?? "main chat"}
      </text>
    </box>
  )
}

export function BtwFooter(props: { sessionID: string; parentID: string }) {
  const route = useRoute()
  const { themeV2 } = useTheme()
  const shortcuts = Keymap.useShortcuts()
  const paletteShortcut = Keymap.useShortcut("command.palette.show")
  const back = () => route.navigate({ type: "session", sessionID: props.parentID })
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.btw.back",
        title: "Back to main chat",
        group: "Session",
        bind: "<leader>up",
        run: back,
      },
    ],
  }))
  return (
    <box
      width="100%"
      height={3}
      paddingLeft={3}
      paddingRight={3}
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      flexShrink={0}
      backgroundColor={themeV2.background.chrome}
    >
      <text fg={themeV2.text.action.primary.default} onMouseUp={back}>
        <span style={{ fg: themeV2.text.subdued }}>{shortcuts.get("session.btw.back")?.replaceAll("ctrl+", "⌃")}</span> Back to main
      </text>
      <text fg={themeV2.text.default} wrapMode="none" flexShrink={0}>
        {paletteShortcut()?.replaceAll("ctrl+", "⌃")} <span style={{ fg: themeV2.text.subdued }}>commands</span>
      </text>
    </box>
  )
}
