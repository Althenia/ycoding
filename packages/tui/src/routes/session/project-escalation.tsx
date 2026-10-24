import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { escapeTerminalText } from "../../util/terminal-text"

export function ProjectEscalation(props: {
  value?: { readonly reasons: readonly { readonly sessionID: string; readonly reason: string }[] }
}) {
  const { theme } = useTheme()
  return (
    <Show when={props.value}>
      {(value) => (
        <box flexDirection="column">
          <text fg={theme.text.feedback.warning.default} wrapMode="word">
            Project escalation
          </text>
          <For each={value().reasons}>
            {(entry) => (
              <text fg={theme.text.subdued} wrapMode="word">
                {escapeTerminalText(entry.reason)}
              </text>
            )}
          </For>
        </box>
      )}
    </Show>
  )
}
