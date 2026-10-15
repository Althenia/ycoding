import type { SessionAutonomyState } from "@ycoding-ai/client"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"
import { readableForeground } from "../../theme/component"
import { guardrailDecisionEnabled, isAsleep, yoloLevel } from "../../util/session-autonomy"

export type ModeChip = {
  key: "goal" | "yolo" | "guardrailDecision" | "sleep"
  label: string;
  tone: "off" | "on" | "warning" | "danger"
}

/**
 * Autonomy chips for the composer status row. Off states stay muted and on states invert, because an
 * active autonomy mode is the most consequential fact on screen. A review still waiting while autonomy is on marks
 * the goal chip as blocked: hard reviews at any level, or ordinary reviews under a goal at YOLO 0.
 */
export function modeChips(input: {
  autonomy?: SessionAutonomyState;
  guardrailPending?: boolean
  machineAwake?: boolean
}): ModeChip[] {
  const active = input.autonomy?.goal?.status === "active"
  const level = yoloLevel(input.autonomy ?? { yolo: 0 })
  const blocked = (level > 0 || active) && !!input.guardrailPending
  const guardrailDecision = input.autonomy ? guardrailDecisionEnabled(input.autonomy) : false
  const asleep = input.autonomy ? isAsleep(input.autonomy) : false
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
    {
      key: "guardrailDecision",
      label: guardrailDecision ? "guardrail decision" : "guardrail decision off",
      tone: guardrailDecision ? "danger" : "off",
    },
    ...(asleep
      ? [
          {
            key: "sleep" as const,
            label: input.machineAwake === false ? "asleep · machine may sleep" : "asleep",
            tone: input.machineAwake === false ? ("warning" as const) : ("on" as const),
          },
        ]
      : []),
  ]
}

export function ModeChips(props: {
  autonomy?: SessionAutonomyState;
  guardrailPending?: boolean
  machineAwake?: boolean
}) {
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
    <For
      each={modeChips({
        autonomy: props.autonomy,
        guardrailPending: props.guardrailPending,
        machineAwake: props.machineAwake,
      })}
    >
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
