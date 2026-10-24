import type { SessionAutonomyView } from "@ycoding-ai/client"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"
import { readableForeground } from "../../theme/component"
import { autonomyAutomated, autonomyModeParts, autonomyRows } from "../../util/session-autonomy"

export type ModeChip = {
  key: "goal" | "autonomy" | "permissions" | "guardrails" | "answers" | "sleep" | "review"
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
  const asleep = parts.includes("asleep")
  const automated = autonomyAutomated(input.autonomy)
  return [
    {
      key: "goal",
      label: active ? "goal" : "goal off",
      tone: active ? "on" : "off",
    },
    ...(automated
      ? autonomyRows(input.autonomy).flatMap((row) =>
          row.effective === undefined || row.effective === "manual"
            ? []
            : [
                {
                  key: row.category,
                  label: `${row.category} ${row.effective}${row.inherited ? " (inherited)" : ""}`,
                  tone: row.effective === "yolo" ? ("danger" as const) : ("warning" as const),
                },
              ],
        )
      : [
          {
            key: "autonomy" as const,
            label: automated === false ? "autonomy manual" : "autonomy unknown",
            tone: "off" as const,
          },
        ]),
    ...(asleep
      ? [
          {
            key: "sleep" as const,
            label: input.machineAwake === false ? "asleep · machine may sleep" : "asleep",
            tone: input.machineAwake === false ? ("warning" as const) : ("on" as const),
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
