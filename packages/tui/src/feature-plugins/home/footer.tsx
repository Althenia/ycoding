import { Plugin } from "@ycoding-ai/plugin/tui"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { createMemo, Match, Show, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiPaths } from "../../context/runtime"
import { useTheme } from "../../context/theme"
import { abbreviateHome } from "../../runtime"
import { FilePath } from "../../ui/file-path"
import { stringWidth } from "../../util/string-width"
import { mcpSummary } from "../../mcp-presentation"

function Directory(props: { context: Plugin.Context; maxWidth: number }) {
  const { themeV2 } = useTheme()
  const paths = useTuiPaths()
  const directory = createMemo(() =>
    props.context.location ? abbreviateHome(props.context.location.directory, paths.home) : undefined,
  )

  return (
    <Show when={directory()}>
      {(value) => <FilePath value={value()} maxWidth={props.maxWidth} fg={themeV2.text.subdued} />}
    </Show>
  )
}

function Mcp(props: { context: Plugin.Context }) {
  const { themeV2 } = useTheme()
  const list = createMemo(() => props.context.data.location.mcp.server.list(props.context.location) ?? [])
  const summary = createMemo(() => mcpSummary(list()))

  return (
    <Show when={list().length}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={themeV2.text.default}>
          <Switch>
            <Match when={summary().attention > 0}>
              <span style={{ fg: themeV2.text.feedback.error.default }}>⊙ </span>
            </Match>
            <Match when={summary().pending > 0}>
              <span style={{ fg: themeV2.text.feedback.warning.default }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span
                style={{
                  fg: summary().connected > 0 ? themeV2.text.feedback.success.default : themeV2.text.subdued,
                }}
              >
                ⊙{" "}
              </span>
            </Match>
          </Switch>
          {summary().label}
        </text>
        <text fg={themeV2.text.subdued}>/status</text>
      </box>
    </Show>
  )
}

function View(props: { context: Plugin.Context }) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const mcpWidth = createMemo(() => {
    const list = props.context.data.location.mcp.server.list(props.context.location) ?? []
    if (list.length === 0) return 0
    return stringWidth(`⊙ ${mcpSummary(list).label} /status`) + 2
  })

  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory
        context={props.context}
        maxWidth={Math.max(2, dimensions().width - 8 - stringWidth(InstallationVersion) - mcpWidth())}
      />
      <Mcp context={props.context} />
      <box flexGrow={1} />
      <box flexShrink={0}>
        <text fg={themeV2.text.subdued}>{InstallationVersion}</text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "ycoding.home-footer",
  setup(context) {
    context.ui.slot("home.footer", () => <View context={context} />)
  },
})
