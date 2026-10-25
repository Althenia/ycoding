import { createMemo, For, Show } from "solid-js"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useData } from "../../context/data"
import { PromptFooterIdentity } from "../../component/prompt"
import { Keymap } from "../../context/keymap"
import { useRoute } from "../../context/route"
import { groupSessionShells } from "../../util/session"
import { autonomyModeWord, autonomyRows } from "../../util/session-autonomy"

export function FooterAutonomy(props: { autonomy?: SessionAutonomyView }) {
  const { theme } = useTheme()
  return (
    <box width="100%" flexDirection="row" flexWrap="wrap" columnGap={2} flexShrink={0}>
      <For each={autonomyRows(props.autonomy)}>
        {(row) => (
          <text
            wrapMode="word"
            maxWidth="100%"
            flexShrink={0}
            fg={row.effective === undefined
              ? theme.text.subdued
              : row.effective === "manual"
                ? theme.text.feedback.success.default
                : theme.text.feedback.warning.default}
          >
            {row.title} {row.effective ? autonomyModeWord(row.effective) : "unknown"}{row.inherited ? " · inherited" : ""}
            {row.category === "guardrails" && row.effective && props.autonomy?.effective?.guardrailsEnabled === false ? " · disabled" : ""}
          </text>
        )}
      </For>
      <Show when={props.autonomy?.effective?.asleep === true}>
        <text fg={theme.text.feedback.warning.default} wrapMode="none" flexShrink={0}>asleep</text>
      </Show>
    </box>
  )
}

export function Footer(props: {
  branch?: string
  sessionID: string
  subagent?: boolean
  project?: boolean
}) {
  const { theme } = useTheme()
  const data = useData()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const compact = () => dimensions().width < 80 && !props.subagent
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
      <box
        width="100%"
        height={compact() ? 2 : props.subagent || props.project ? 1 : 2}
        flexShrink={0}
        flexDirection={compact() ? "column" : "row"}
        justifyContent={compact() ? "center" : "space-between"}
        alignItems={compact() ? "stretch" : "center"}
      >
        <box flexDirection="row" gap={3} flexGrow={compact() ? 0 : 1} minWidth={0} marginRight={compact() ? 0 : 3}>
          <PromptFooterIdentity branch={props.branch} />
          <text fg={theme.text.subdued} wrapMode="none" flexShrink={0}>
            subagents {subagents()}
          </text>
          <text fg={theme.text.subdued} wrapMode="none" truncate flexShrink={1}>
            shells {shells()}
          </text>
        </box>
        <box flexDirection="row" gap={3} flexShrink={0} justifyContent="flex-end">
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
