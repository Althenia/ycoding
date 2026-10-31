import { createEffect } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { stringWidth } from "../../util/string-width"
import { FooterAutonomy } from "./footer"
import { readableTint } from "../../theme/component"

export function BtwContext(props: { parentID: string }) {
  const data = useData()
  const client = useClient()
  const toast = useToast()
  const { theme } = useTheme()
  createEffect(() => {
    if (client.connection.status() !== "connected") return
    void data.session.sync(props.parentID).catch(toast.error)
  })
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
      <text fg={theme.text.subdued} wrapMode="none" truncate>
        Parent context snapshot · read-only · {data.session.get(props.parentID)?.title ?? "main chat"}
      </text>
    </box>
  )
}

export function BtwFooter(props: { sessionID: string; parentID: string; autonomy?: SessionAutonomyView }) {
  const route = useRoute()
  const { theme } = useTheme()
  const shortcuts = Keymap.useShortcuts()
  const paletteShortcut = Keymap.useShortcut("command.palette.show")
  const dimensions = useTerminalDimensions()
  const gap = () => dimensions().width < 40 ? 1 : 2
  const label = () => dimensions().width < 40 ? "↑" : dimensions().width < 60 ? "main" : "Back to main"
  const key = () => dimensions().width >= 120 ? shortcuts.get("session.btw.back")?.replaceAll("ctrl+", "⌃") : undefined
  const palette = () => `${paletteShortcut()?.replaceAll("ctrl+", "⌃") ?? ""}${dimensions().width >= 80 ? " commands" : ""}`
  const quiet = () => readableTint(theme.text.subdued, theme.background.default)
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
      height={1}
      paddingLeft={3}
      paddingRight={3}
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      flexShrink={0}
      backgroundColor={theme.background.default}
      gap={gap()}
    >
      <text fg={theme.text.action.primary.default} onMouseUp={back} wrapMode="none" flexShrink={0}>
        <span style={{ fg: quiet() }}>{key() ? `${key()} ` : ""}</span>{label()}
      </text>
      <FooterAutonomy autonomy={props.autonomy} width={Math.max(19, dimensions().width - 6 - stringWidth(`${key() ? `${key()} ` : ""}${label()}`) - stringWidth(palette()) - gap() * 3)} />
      <box flexGrow={1} minWidth={0} />
      <text fg={theme.text.default} wrapMode="none" flexShrink={0}>
        {paletteShortcut()?.replaceAll("ctrl+", "⌃")}<span style={{ fg: quiet() }}>{dimensions().width >= 80 ? " commands" : ""}</span>
      </text>
    </box>
  )
}
