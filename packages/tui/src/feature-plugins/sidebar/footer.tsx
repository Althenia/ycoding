import { Plugin } from "@ycoding-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { useTuiPaths } from "../../context/runtime"
import { useTheme } from "../../context/theme"
import { abbreviateHome } from "../../runtime"
import { FilePath } from "../../ui/file-path"

function View(props: { context: Plugin.Context }) {
  const { themeV2 } = useTheme()
  const paths = useTuiPaths()
  const directory = createMemo(() =>
    props.context.location ? formatSidebarFooterPath(props.context.location.directory, paths.home) : undefined,
  )
  return (
    <Show when={directory()}>{(value) => <FilePath value={value()} maxWidth={38} fg={themeV2.text.subdued} />}</Show>
  )
}

export function formatSidebarFooterPath(directory: string, home: string) {
  const abbreviated = abbreviateHome(directory, home)
  if (abbreviated !== directory) return abbreviated
  const inferred = directory.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/)?.[0]
  return inferred ? abbreviateHome(directory, inferred) : directory
}

export default Plugin.define({
  id: "ycoding.sidebar-footer",
  setup(context) {
    context.ui.slot("sidebar.footer", () => <View context={context} />)
  },
})
