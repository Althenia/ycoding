import { Plugin } from "@ycoding-ai/plugin/tui"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { mcpStatusPresentation, type McpTone } from "../../mcp-presentation"
import { RailSection } from "../../routes/session/rail-section"

function View(props: { context: Plugin.Context; sessionID: string }) {
  const { themeV2 } = useTheme()
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const list = createMemo(() => props.context.data.location.mcp.server.list(session()?.location) ?? [])
  const on = createMemo(() => list().filter((item) => item.status.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status.status === "failed" ||
          item.status.status === "needs_auth" ||
          item.status.status === "needs_client_registration",
      ).length,
  )
  const summary = createMemo(() => `${on()} active${bad() > 0 ? `, ${bad()} error${bad() > 1 ? "s" : ""}` : ""}`)

  const color = (tone: McpTone) => {
    if (tone === "success") return themeV2.text.feedback.success.default
    if (tone === "warning") return themeV2.text.feedback.warning.default
    if (tone === "error") return themeV2.text.feedback.error.default
    return themeV2.text.subdued
  }

  return (
    <Show when={list().length > 0}>
      <RailSection section="mcp" title="MCP" summary={summary()} attention={bad() > 0}>
        <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: color(mcpStatusPresentation(item.status.status).tone),
                  }}
                >
                  •
                </text>
                <text fg={themeV2.text.default} wrapMode="word">
                  {item.name}{" "}
                  <span style={{ fg: themeV2.text.subdued }}>
                    <Switch fallback={mcpStatusPresentation(item.status.status).label}>
                      <Match when={item.status.status === "failed"}>
                        <i>{item.status.status === "failed" ? item.status.error : undefined}</i>
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
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
