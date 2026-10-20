import type { SessionAutonomyView } from "@ycoding-ai/client"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"
import { readableForeground } from "../../theme/component"
import { autoAnswerOn, autonomyModeParts } from "../../util/session-autonomy"

export type ModeChip = {
  key: "goal" | "yolo" | "permissions" | "guardrails" | "sleep" | "review" | "answers"
  label: string;
  tone: "off" | "on" | "warning" | "danger"
}

export function modeChips(input: {
  autonomy?: SessionAutonomyView;
  guardrailPending?: boolean
  machineAwake?: boolean
  review?: number
}): ModeChip[] {
  const parts = autonomyModeParts(input.autonomy)
  const active = parts.includes("goal")
  const yolo = input.autonomy?.effective?.yolo
  const asleep = parts.includes("asleep")
  return [
    {
      key: "goal",
      label: active ? "goal" : "goal off",
      tone: active ? "on" : "off",
    },
    {
      key: "yolo",
      label: parts[0],
      tone: yolo === true ? "danger" : "off",
    },
    ...(input.autonomy?.effective?.permissionsAuto
      ? [{ key: "permissions" as const, label: "permissions auto", tone: "warning" as const }]
      : []),
    ...(input.autonomy?.effective?.ordinaryReviewsAuto
      ? [{ key: "guardrails" as const, label: "guardrails auto", tone: "warning" as const }]
      : []),
    ...(asleep
      ? [
          {
            key: "sleep" as const,
            label: input.machineAwake === false ? "asleep · machine may sleep" : "asleep",
            tone: input.machineAwake === false ? ("warning" as const) : ("on" as const),
          },
        ]
      : []),
    ...(autoAnswerOn(input.autonomy)
      ? [
          {
            key: "answers" as const,
            label: "answers auto",
            tone: "warning" as const,
          },
        ]
      : []),
    ...(input.review
      ? [
          {
            key: "review" as const,
            label: `review ${input.review}`,
            tone: "warning" as const,
          },
        ]
      : []),
  ]
}

export function ModeChips(props: {
  autonomy?: SessionAutonomyView;
  guardrailPending?: boolean
  machineAwake?: boolean
  review?: number
  keys?: readonly ModeChip["key"][]
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
        review: props.review,
      }).filter((chip) => !props.keys || props.keys.includes(chip.key))}
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
