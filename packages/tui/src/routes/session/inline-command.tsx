/** @jsxImportSource @opentui/solid */
import { Show, createMemo } from "solid-js"
import { useTheme } from "../../context/theme"
import { RGBA } from "@opentui/core"

export type InlineCommandResult =
  | { pass: number; fail: number }
  | { errors: number }

export function parseInlineCommandResult(output: string) {
  const tests = /(\d+) pass(?:\s*·\s*|\s+)(\d+) fail\b/.exec(output)
  if (tests) return { pass: Number(tests[1]), fail: Number(tests[2]) }
  const errors = /\b(\d+) errors?\b/.exec(output)
  if (errors) return { errors: Number(errors[1]) }
  return undefined
}

export function InlineCommand(props: {
  command: string
  icon: string
  iconColor?: RGBA
  color?: RGBA
  pass?: number
  fail?: number
  errors?: number
  failed?: boolean
  complete?: boolean
}) {
  const { themeV2 } = useTheme()

  const statusColor = createMemo(() => {
    if (props.errors) return themeV2.text.feedback.error.default
    if (props.fail) return themeV2.text.feedback.error.default
    return themeV2.text.feedback.success.default
  })

  const statusText = createMemo(() => {
    if (props.errors !== undefined) return `${props.errors} ${props.errors === 1 ? "error" : "errors"}`
    if (props.pass !== undefined || props.fail !== undefined) return `${props.pass ?? 0} pass · ${props.fail ?? 0} fail`
    return ""
  })

  return (
    <box width="100%" paddingLeft={3} flexDirection="row">
      <text flexShrink={1} wrapMode="word" fg={props.failed ? themeV2.text.feedback.error.default : props.color}>
        <Show when={props.complete ?? true} fallback={<span style={{ fg: themeV2.text.subdued }}>… </span>}>
          <span style={{ fg: props.iconColor ?? props.color }}>{props.icon} </span>
        </Show>
        {props.command}
      </text>
      <box flexGrow={1} />
      <CommandStatusBadge color={statusColor()}>{statusText()}</CommandStatusBadge>
    </box>
  )
}

function CommandStatusBadge(props: { children: string; color?: RGBA }) {
  const { themeV2 } = useTheme()
  return (
    <Show when={props.children}>
      <text flexShrink={0} bg={themeV2.raise(themeV2.background.default)} fg={props.color ?? themeV2.text.subdued}>
        {" "}
        {props.children}{" "}
      </text>
    </Show>
  )
}
