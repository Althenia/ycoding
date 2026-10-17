import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useData } from "../../context/data"
import { PromptFooterIdentity } from "../../component/prompt"
import { ModeChips } from "../../component/prompt/mode-chips"
import { KeepAwakeIndicator, useKeepAwake } from "../../keep-awake"
import { Keymap } from "../../context/keymap"
import { useRoute } from "../../context/route"
import { groupSessionShells } from "../../util/session"
import type { SessionAutonomyView } from "@ycoding-ai/client"

export function Footer(props: {
  branch?: string
  sessionID: string
  autonomy?: SessionAutonomyView
  subagent?: boolean
}) {
  const { theme } = useTheme()
  const keepAwake = useKeepAwake()
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
      {
        id: "session.context-breakdown.open",
        title: "Open context breakdown",
        group: "Session",
        palette: true,
        run: () => route.navigate({ type: "session-context", sessionID: props.sessionID }),
      },
    ],
    bindings: ["session.provider-usage.open"],
  }))

  return (
    <box
      width="100%"
      flexShrink={0}
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      backgroundColor={theme.background.chrome}
    >
      <KeepAwakeIndicator />
      <box
        width="100%"
        height={props.subagent ? 1 : 3}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
      >
        <box flexDirection="row" gap={3} flexGrow={1} minWidth={0}>
          <PromptFooterIdentity branch={props.branch} />
          <ModeChips
            autonomy={props.autonomy}
            machineAwake={keepAwake.status() === undefined ? undefined : keepAwake.status()?.state === "on"}
            review={data.session.review.list(props.sessionID).length}
          />
          <text fg={theme.text.subdued} wrapMode="none" flexShrink={0}>
            subagents {subagents()}
          </text>
          <text fg={theme.text.subdued} wrapMode="none" truncate flexShrink={1}>
            shells {shells()}
          </text>
        </box>
        <box flexDirection="row" gap={3} flexShrink={0}>
          <text fg={theme.text.default} wrapMode="none" flexShrink={0} onMouseUp={openUsage}>
            <Show when={usageShortcut()}>{(shortcut) => `${shortcut().replaceAll("ctrl+", "⌃")} `}</Show>
            <span style={{ fg: theme.text.subdued }}>usage</span>
          </text>
          <Show when={paletteShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default} wrapMode="none" flexShrink={0}>
                {shortcut().replaceAll("ctrl+", "⌃")} <span style={{ fg: theme.text.subdued }}>commands</span>
              </text>
            )}
          </Show>
        </box>
      </box>
    </box>
  )
}
