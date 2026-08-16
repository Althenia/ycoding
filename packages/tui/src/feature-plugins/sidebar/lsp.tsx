import { Plugin } from "@ycoding-ai/plugin/tui"
import { useTheme } from "../../context/theme"

function View() {
  const { themeV2 } = useTheme()
  return (
    <box>
      <text fg={themeV2.text.default}>
        <b>LSP</b>
      </text>
      <text fg={themeV2.text.subdued}>LSP status unavailable</text>
    </box>
  )
}

export default Plugin.define({
  id: "ycoding.sidebar-lsp",
  setup(context) {
    context.ui.slot("sidebar.content", () => <View />)
  },
})
