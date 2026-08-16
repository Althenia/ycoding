import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import type { SubagentEconomics } from "./subagent-footer"

export function SubagentEconomicsSurface(props: { economics?: SubagentEconomics }) {
  const { themeV2 } = useTheme().contextual("elevated")
  const columns = () => [
    ["Context", props.economics?.context],
    ["Cache hit", props.economics?.cacheHit],
    ["Prefix", props.economics?.prefix],
    ["Reads", props.economics?.reads],
    ["Writes", props.economics?.writes],
    ["Spent", props.economics?.spent],
    ["Rolls up to", props.economics?.rollsUpTo],
  ] as const

  return (
    <Show when={props.economics}>
      <box height={7} paddingLeft={1} flexDirection="column" flexShrink={0}>
        <box height={1} />
        <text fg={themeV2.text.feedback.info.default} wrapMode="none">
          <b>SUBAGENT ECONOMICS</b>
        </text>
        <box height={1} />
        <box flexDirection="row">
          <For each={columns()}>
            {([label], index) => (
              <box
                width={index() === 0 || index() === 5 ? 28 : index() < 6 ? 27 : undefined}
                flexGrow={index() === 6 ? 1 : 0}
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
                width={index() === 0 || index() === 5 ? 28 : index() < 6 ? 27 : undefined}
                flexGrow={index() === 6 ? 1 : 0}
                flexShrink={0}
              >
                <text fg={themeV2.text.default} wrapMode="none">{value ?? "unreported"}</text>
              </box>
            )}
          </For>
        </box>
      </box>
    </Show>
  )
}
