import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useData } from "../../context/data"
import { PromptFooterIdentity } from "../../component/prompt"
import { ModeChips } from "../../component/prompt/mode-chips"
import { Keymap } from "../../context/keymap"
import { useRoute } from "../../context/route"
import { groupSessionShells } from "../../util/session"
import type { SessionAutonomyState } from "@ycoding-ai/client"

export function Footer(props: {
  branch?: string
  sessionID: string
  autonomy: SessionAutonomyState
  subagent?: boolean
}) {
  const { themeV2 } = useTheme()
  const data = useData()
  const route = useRoute()
  const paletteShortcut = Keymap.useShortcut("command.palette.show")
  const usageShortcut = Keymap.useShortcut("session.provider-usage.open")
  const subagents = createMemo(() => data.session.subagent.summary(props.sessionID)?.active ?? 0)
  const shells = createMemo(() => {
    const session = data.session.get(props.sessionID)
    if (!session) return 0
    return groupSessionShells(data.shell.list(session.location), data.session.list(), session.id).reduce(
      (count, group) => count + group.shells.length,
      0,
    )
  })
  const openUsage = () => route.navigate({ type: "provider-usage", sessionID: props.sessionID })
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.provider-usage.open",
        title: "Open provider usage",
        group: "Session",
        bind: "<leader>shift+u",
        run: openUsage,
      },
    ],
    bindings: ["session.provider-usage.open"],
  }))

  return (
    <box
      width="100%"
      height={props.subagent ? 1 : 3}
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      paddingLeft={3}
      paddingRight={3}
      backgroundColor={themeV2.background.chrome}
    >
      <box flexDirection="row" gap={3} flexGrow={1} minWidth={0}>
        <PromptFooterIdentity branch={props.branch} />
        <ModeChips autonomy={props.autonomy} />
        <text fg={themeV2.text.subdued} wrapMode="none" flexShrink={0}>
          subagents {subagents()}
        </text>
        <text fg={themeV2.text.subdued} wrapMode="none" truncate flexShrink={1}>
          shells {shells()}
        </text>
        <text fg={themeV2.text.action.primary.default} wrapMode="none" flexShrink={0} onMouseUp={openUsage}>
          <Show when={usageShortcut()}>{(shortcut) => `${shortcut().replaceAll("ctrl+", "⌃")} `}</Show>usage
        </text>
      </box>
      <Show when={paletteShortcut()}>
        {(shortcut) => (
          <text fg={themeV2.text.default} wrapMode="none" flexShrink={0}>
            {shortcut().replaceAll("ctrl+", "⌃")} <span style={{ fg: themeV2.text.subdued }}>commands</span>
          </text>
        )}
      </Show>
    </box>
  )
}
