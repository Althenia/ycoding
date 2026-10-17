import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

export function ShellOutputStream(props: { text: string; loading: boolean; error?: string; onRetry?: () => void }) {
  const { theme } = useTheme()
  return (
    <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }} paddingLeft={3} paddingRight={3} paddingTop={3}>
      <Show when={props.error}>
        {(error) => <box flexDirection="column"><text fg={theme.text.feedback.error.default}>{error()}</text><text fg={theme.text.feedback.info.default} onMouseUp={props.onRetry}>Retry output · r</text></box>}
      </Show>
      <Show
        when={props.text}
        fallback={
          <Show when={!props.error}><text fg={theme.text.subdued}>{props.loading ? "Loading output..." : "No captured output"}</text></Show>
        }
      >
        <text fg={theme.text.default}>{props.text}</text>
      </Show>
    </scrollbox>
  )
}
