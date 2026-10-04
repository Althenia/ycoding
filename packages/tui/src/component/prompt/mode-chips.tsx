import type { SessionAutonomyState } from "@ycoding-ai/client"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"
import { readableForeground } from "../../theme/component"
import { yoloLevel } from "../../util/session-autonomy"

export type ModeChip = { key: "goal" | "yolo"; label: string; tone: "off" | "on" | "warning" | "danger" }

/**
 * Autonomy chips for the composer status row. Off states stay muted and on states invert, because an
 * active autonomy mode is the most consequential fact on screen. Guardrails require YOLO 3.
 */
export function modeChips(input: { autonomy?: SessionAutonomyState; guardrailPending?: boolean }): ModeChip[] {
  const active = input.autonomy?.goal?.status === "active"
  const level = yoloLevel(input.autonomy ?? { yolo: 0 })
  const blocked = level > 0 && level < 3 && !!input.guardrailPending
  return [
    {
      key: "goal",
      label: blocked ? "guardrail blocked" : active ? "goal" : "goal off",
      tone: blocked ? "warning" : active ? "on" : "off",
    },
    {
      key: "yolo",
      label: level > 0 ? `YOLO ${level}` : "YOLO off",
      tone: level > 0 ? "danger" : "off",
    },
  ]
}

export function ModeChips(props: { autonomy?: SessionAutonomyState; guardrailPending?: boolean }) {
  const { theme } = useTheme()
  const style = (tone: ModeChip["tone"]) => {
    if (tone === "danger")
      return {
        fg: readableForeground(theme.text.action.destructive.default, theme.background.action.destructive.default),
        bg: theme.background.action.destructive.default,
      }
    if (tone === "on") return { fg: theme.text.action.primary.focused, bg: theme.background.action.primary.focused }
    if (tone === "warning")
      return {
        fg: readableForeground(theme.text.action.primary.focused, theme.text.feedback.warning.default),
        bg: theme.text.feedback.warning.default,
      }
    return { fg: theme.text.subdued }
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

function FilledWarningChip(props: { label: string }) {
  const { theme } = useTheme()
  const style = {
    fg: readableForeground(theme.text.action.primary.focused, theme.text.feedback.warning.default),
    bg: theme.text.feedback.warning.default,
  }
  return (
    <text wrapMode="none" flexShrink={0} fg={style.fg}>
      <span style={style}> {props.label} </span>
    </text>
  )
}
