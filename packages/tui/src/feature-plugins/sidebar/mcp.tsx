import { Plugin } from "@ycoding-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { mcpStatusPresentation, type McpTone } from "../../mcp-presentation"
import { RailRow, RailSection } from "../../routes/session/rail-section"

function View(props: { context: Plugin.Context; sessionID: string }) {
  const { themeV2 } = useTheme()
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const list = createMemo(() => props.context.data.location.mcp.server.list(session()?.location) ?? [])
  const summary = createMemo(() => {
    const l = list()
    const connected = l.filter((item) => item.status.status === "connected").length
    const failed = l.filter((item) => item.status.status === "failed").length
    return `${connected}/${l.length} connected${failed ? ` · ${failed} failed` : ""}`
  })

  const color = (tone: McpTone) => {
    if (tone === "success") return themeV2.text.feedback.success.default
    if (tone === "warning") return themeV2.text.feedback.warning.default
    if (tone === "error") return themeV2.text.feedback.error.default
    return themeV2.text.subdued
  }

  return (
    <Show when={list().length > 0}>
      <RailSection section="mcp" title="MCP" summary={summary()}>
        <For each={list()}>
          {(item) => (
            <RailRow
              label={item.name}
              value={mcpStatusPresentation(item.status.status).label}
              valueColor={color(mcpStatusPresentation(item.status.status).tone)}
            />
          )}
        </For>
      </RailSection>
    </Show>
  )
}

export default Plugin.define({
  id: "internal:sidebar-mcp",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})
