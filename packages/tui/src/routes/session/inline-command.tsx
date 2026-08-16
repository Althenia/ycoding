/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import { createMemo } from "solid-js"
import { SessionToolActivityRow } from "./activity-row"

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
  paddingLeft?: number
  width?: number
}) {
  const statusText = createMemo(() => {
    if (props.errors !== undefined) return `${props.errors} ${props.errors === 1 ? "error" : "errors"}`
    if (props.pass !== undefined || props.fail !== undefined) return `${props.pass ?? 0} pass · ${props.fail ?? 0} fail`
    return props.complete === false ? "running" : "done"
  })

  return (
    <SessionToolActivityRow
      tool={props.command}
      detail=""
      status={statusText()}
      variant={props.failed || props.errors || props.fail ? "error" : props.complete === false ? "running" : "success"}
      width={props.width}
    />
  )
}
