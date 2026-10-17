import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import type { SubagentEconomics } from "./subagent-footer"

export function SubagentEconomicsSurface(props: { economics?: SubagentEconomics }) {
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const columns = () => [
    ["Context", props.economics?.context],
    ["Speed", props.economics?.speed],
    ["Cache hit", props.economics?.cacheHit],
    ["Reads", props.economics?.reads],
    ["Writes", props.economics?.writes],
    ["Spent", props.economics?.spent],
    ["Rolls up to", props.economics?.rollsUpTo],
  ].filter(([label, value]) => label !== "Speed" || value !== undefined)
  const columnWidth = () => Math.floor((dimensions().width - 6) / Math.max(1, Math.min(7, Math.floor((dimensions().width - 6) / 22))))

  return (
    <Show when={props.economics}>
      <box flexDirection="column" flexShrink={0}>
        <text fg={theme.border.default} wrapMode="none">
          {"─".repeat(dimensions().width)}
        </text>
        <box paddingLeft={3} flexDirection="column">
          <text fg={theme.text.feedback.info.default} wrapMode="none">
            <b>SUBAGENT ECONOMICS</b>
          </text>
          <box height={1} />
          <box flexDirection="row" flexWrap="wrap">
            <For each={columns()}>
              {([label, value]) => (
                <box width={columnWidth()} flexDirection="column" paddingBottom={1} flexShrink={0}>
                  <text fg={theme.text.subdued} wrapMode="none">{label}</text>
                  <box height={1} />
                  <text fg={theme.text.default} wrapMode="none">{value ?? "unreported"}</text>
                </box>
              )}
            </For>
          </box>
        </box>
      </box>
    </Show>
  )
}
