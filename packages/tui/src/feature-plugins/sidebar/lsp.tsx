import { Plugin } from "@ycoding-ai/plugin/tui"
import { useTheme } from "../../context/theme"
import { RailRow, RailSection } from "../../routes/session/rail-section"

function View() {
  const { themeV2 } = useTheme()
  return (
    <RailSection section="lsp" title="LSP" summary="unavailable">
      <RailRow label="Status" value="unavailable" valueColor={themeV2.text.subdued} />
    </RailSection>
  )
}

export default Plugin.define({
  id: "ycoding.sidebar-lsp",
  setup(context) {
    context.ui.slot("sidebar.content", () => <View />)
  },
})
