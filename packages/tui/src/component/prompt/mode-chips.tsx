import type { SessionAutonomyState } from "@ycoding-ai/client"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"

export type ModeChip = { key: "goal" | "yolo"; label: string; tone: "off" | "on" | "warning" | "danger" }

/**
 * Autonomy chips for the composer status row. Off states stay muted and on states invert, because an
 * active autonomy mode is the most consequential fact on screen. Guardrails still require a human in YOLO mode.
 */
export function modeChips(input: { autonomy?: SessionAutonomyState; guardrailPending?: boolean }): ModeChip[] {
  const goal = input.autonomy?.goal
  const active = goal?.status === "active"
  const blocked = input.autonomy?.mode === "yolo" && input.guardrailPending
  return [
    {
      key: "goal",
      label: blocked
        ? active
          ? `goal ${goal.noProgress}/${goal.maxNoProgress} blocked`
          : "guardrail blocked"
        : active
          ? `goal ${goal.noProgress}/${goal.maxNoProgress}`
          : goal
            ? `goal ${goal.status}`
            : "goal off",
      tone: blocked ? "warning" : active ? "on" : "off",
    },
    {
      key: "yolo",
      label: input.autonomy?.mode === "yolo" ? "YOLO" : "YOLO off",
      tone: input.autonomy?.mode === "yolo" ? "danger" : "off",
    },
  ]
}

export function ModeChips(props: { autonomy?: SessionAutonomyState; guardrailPending?: boolean }) {
  const { themeV2 } = useTheme()
  const style = (tone: ModeChip["tone"]) => {
    if (tone === "danger")
      return {
        fg: themeV2.text.action.destructive.default,
        bg: themeV2.background.action.destructive.default,
      }
    if (tone === "on")
      return { fg: themeV2.text.action.primary.focused, bg: themeV2.background.action.primary.focused }
    if (tone === "warning")
    return { fg: themeV2.text.action.primary.focused, bg: themeV2.text.feedback.warning.default }
    return { fg: themeV2.text.subdued }
  }

  return (
    <For each={modeChips({ autonomy: props.autonomy, guardrailPending: props.guardrailPending })}>
      {(chip) => {
        if (chip.tone === "warning") return <FilledWarningChip label={chip.label} />
        return (
          <text wrapMode="none" flexShrink={0} fg={style(chip.tone).fg}>
            <span style={style(chip.tone)}>{chip.tone === "off" ? chip.label : ` ${chip.label} `}</span>
          </text>
        )
      }}
    </For>
  )
}

export function FilledWarningChip(props: { label: string }) {
  const { themeV2 } = useTheme()
  const style = {
    fg: themeV2.text.action.primary.focused,
    bg: themeV2.text.feedback.warning.default,
  }
  return (
    <text wrapMode="none" flexShrink={0} fg={style.fg}>
      <span style={style}> {props.label} </span>
    </text>
  )
}
