import { Plugin } from "@ycoding-ai/plugin/tui"
import { useTheme } from "../../context/theme"
import { RailSection } from "../../routes/session/rail-section"

function View() {
  const { themeV2 } = useTheme()
  return (
    <RailSection section="lsp" title="LSP" summary="unavailable">
      <text fg={themeV2.text.subdued}>LSP status unavailable</text>
    </RailSection>
  )
}

export default Plugin.define({
  id: "ycoding.sidebar-lsp",
  setup(context) {
    context.ui.slot("sidebar.content", () => <View />)
  },
})
