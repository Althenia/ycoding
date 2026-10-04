import { TextAttributes } from "@opentui/core"
import { createSignal, For } from "solid-js"
import { useTheme } from "../context/theme"
import { DevTools } from "../devtools"

export function DevToolsSidebar() {
  const { theme, mode, supports, setMode } = useTheme().contextual("elevated")
  const [modeHovered, setModeHovered] = createSignal(false)
  const nextMode = () => (mode() === "dark" ? "light" : "dark")
  const canSwitchMode = () => supports(nextMode())

  return (
    <box
      width={42}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.background.default}
    >
      <box flexShrink={0} marginBottom={1}>
        <box marginBottom={1}>
          <text fg={theme.text.action.primary.default} attributes={TextAttributes.BOLD}>
            Theme
          </text>
        </box>
        <box flexDirection="row">
          <text fg={theme.text.subdued}>Mode</text>
          <box flexGrow={1} />
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={modeHovered() && canSwitchMode() ? theme.background.action.primary.hovered : undefined}
            onMouseOver={() => setModeHovered(canSwitchMode())}
            onMouseOut={() => setModeHovered(false)}
            onMouseUp={canSwitchMode() ? () => setMode(nextMode()) : undefined}
          >
            <text fg={canSwitchMode() ? theme.text.default : theme.text.subdued}>{mode()}</text>
          </box>
        </box>
      </box>
      <For each={DevTools.data()}>
        {(group) => (
          <box flexShrink={0} marginBottom={1}>
            <box marginBottom={1}>
              <text fg={theme.text.action.primary.default} attributes={TextAttributes.BOLD}>
                {group.title}
              </text>
            </box>
            <For each={group.entries}>
              {(entry) => (
                <box flexDirection="row">
                  <text fg={theme.text.subdued}>{entry.key}</text>
                  <box flexGrow={1} />
                  <text fg={theme.text.default}>{String(entry.value)}</text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
