import type { SessionAutonomyState } from "@ycoding-ai/client"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"

export type ModeChip = { key: "goal" | "yolo"; label: string; tone: "off" | "on" | "danger" }

/**
 * Autonomy chips for the composer status row. Off states stay muted and on states invert, because an
 * active autonomy mode is the most consequential fact on screen and YOLO auto-approves.
 */
export function modeChips(input: { autonomy?: SessionAutonomyState }): ModeChip[] {
  const goal = input.autonomy?.goal
  const active = goal?.status === "active"
  return [
    {
      key: "goal",
      label: active ? `goal ${goal.noProgress}/${goal.maxNoProgress}` : goal ? `goal ${goal.status}` : "goal off",
      tone: active ? "on" : "off",
    },
    {
      key: "yolo",
      label: input.autonomy?.mode === "yolo" ? "YOLO" : "YOLO off",
      tone: input.autonomy?.mode === "yolo" ? "danger" : "off",
    },
  ]
}

export function ModeChips(props: { autonomy?: SessionAutonomyState }) {
  const { themeV2 } = useTheme()
  const style = (tone: ModeChip["tone"]) => {
    if (tone === "danger")
      return {
        fg: themeV2.text.action.destructive.default,
        bg: themeV2.background.action.destructive.default,
      }
    if (tone === "on")
      return { fg: themeV2.text.action.primary.focused, bg: themeV2.background.action.primary.focused }
    return { fg: themeV2.text.subdued }
  }

  return (
    <For each={modeChips({ autonomy: props.autonomy })}>
      {(chip) => (
        <text wrapMode="none" flexShrink={0}>
          <span style={style(chip.tone)}>{chip.tone === "off" ? chip.label : ` ${chip.label} `}</span>
        </text>
      )}
    </For>
  )
}
