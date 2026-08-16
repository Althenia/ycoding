import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import type { SubagentEconomics } from "./subagent-footer"

export function SubagentEconomicsSurface(props: { economics?: SubagentEconomics }) {
  const { themeV2 } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const columns = () => [
    ["Context", props.economics?.context],
    ["Cache hit", props.economics?.cacheHit],
    ["Reads", props.economics?.reads],
    ["Writes", props.economics?.writes],
    ["Spent", props.economics?.spent],
    ["Rolls up to", props.economics?.rollsUpTo],
  ] as const

  return (
    <Show when={props.economics}>
      <box height={7} flexDirection="column" flexShrink={0}>
        <text fg={themeV2.border.default} wrapMode="none">
          {"─".repeat(dimensions().width)}
        </text>
        <box paddingLeft={3} flexDirection="column">
          <text fg={themeV2.text.feedback.info.default} wrapMode="none">
            <b>SUBAGENT ECONOMICS</b>
          </text>
          <box height={1} />
          <box flexDirection="row">
            <For each={columns()}>
              {([label], index) => (
                <box
                  width={index() === 0 || index() === 4 ? 28 : index() < 5 ? 27 : undefined}
                  flexGrow={index() === 5 ? 1 : 0}
                  flexShrink={0}
                >
                  <text fg={themeV2.text.subdued} wrapMode="none">{label}</text>
                </box>
              )}
            </For>
          </box>
          <box height={1} />
          <box flexDirection="row">
            <For each={columns()}>
              {([, value], index) => (
                <box
                  width={index() === 0 || index() === 4 ? 28 : index() < 5 ? 27 : undefined}
                  flexGrow={index() === 5 ? 1 : 0}
                  flexShrink={0}
                >
                  <text fg={themeV2.text.default} wrapMode="none">{value ?? "unreported"}</text>
                </box>
              )}
            </For>
          </box>
        </box>
      </box>
    </Show>
  )
}
