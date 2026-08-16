import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

export function ShellOutputStream(props: { text: string; loading: boolean }) {
  const { themeV2 } = useTheme()
  return (
    <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }} paddingLeft={3} paddingRight={3} paddingTop={3}>
      <Show
        when={props.text}
        fallback={
          <text fg={themeV2.text.subdued}>{props.loading ? "Loading output..." : "No captured output"}</text>
        }
      >
        <text fg={themeV2.text.default}>{props.text}</text>
      </Show>
    </scrollbox>
  )
}
