import { Match, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import type { SessionRow } from "./rows"

type ActivityRow = Extract<SessionRow, { type: "guardrail" | "subagent" | "task" }>

export function SessionActivityRow(props: {
  row: ActivityRow
  width?: number
  onGuardrail?: (requestID: string) => void
  onSubagent?: (sessionID: string) => void
}) {
  const { themeV2 } = useTheme()
  const markerColor = () => {
    if (props.row.type === "guardrail") return themeV2.text.feedback.warning.default
    if (props.row.type === "subagent") return themeV2.text.feedback.info.default
    if (props.row.status === "completed") return themeV2.text.feedback.success.default
    return themeV2.text.subdued
  }
  const statusColor = () => {
    if (props.row.type === "guardrail") return themeV2.text.feedback.warning.default
    if (props.row.type === "subagent") return themeV2.text.feedback.info.default
    if (props.row.status === "completed") return themeV2.text.subdued
    return themeV2.text.feedback.success.default
  }
  const open = () => {
    if (props.row.type === "guardrail") props.onGuardrail?.(props.row.requestID)
    if (props.row.type === "subagent") props.onSubagent?.(props.row.sessionID)
  }

  return (
    <box
      width={props.width ?? "100%"}
      flexDirection="row"
      paddingLeft={1}
      marginTop={props.row.type === "guardrail" || (props.row.type === "task" && props.row.status === "completed") ? 2 : 1}
      marginBottom={
        props.row.type === "subagent"
          ? 1
          : props.row.type === "task"
            ? props.row.status === "completed"
              ? 1
              : 2
            : 0
      }
      onMouseUp={open}
    >
      <text width={2} flexShrink={0} fg={markerColor()}>
        {props.row.type === "guardrail"
          ? "!!"
          : props.row.type === "subagent"
            ? "◦"
            : props.row.status === "completed"
              ? "ok"
              : ".."}
      </text>
      <box width={5} flexShrink={0} />
      <Switch>
        <Match when={props.row.type === "guardrail" ? props.row : undefined}>
          {(row) => (
            <>
              <text flexShrink={0} fg={themeV2.text.default}>guardrail</text>
              <text flexShrink={1} wrapMode="none" overflow="hidden" fg={themeV2.text.subdued}>
                {" · "}{row().reason}
              </text>
            </>
          )}
        </Match>
        <Match when={props.row.type === "subagent" ? props.row : undefined}>
          {(row) => (
            <>
              <text flexShrink={0} fg={themeV2.text.default}>subagent</text>
              <text flexShrink={1} wrapMode="none" overflow="hidden" fg={themeV2.text.subdued}>
                {" "}{row().agent}
              </text>
            </>
          )}
        </Match>
        <Match when={props.row.type === "task" ? props.row : undefined}>
          {(row) => (
            <text flexShrink={1} wrapMode="none" overflow="hidden" fg={themeV2.text.default}>
              {row().content}
            </text>
          )}
        </Match>
      </Switch>
      <box flexGrow={1} />
      <text flexShrink={0} fg={statusColor()}>
        <Switch>
          <Match when={props.row.type === "guardrail"}>needs approval</Match>
          <Match when={props.row.type === "subagent" ? props.row : undefined}>
            {(row) => `running ${Locale.duration(Math.max(0, Date.now() - row().created))} · ↓ open`}
          </Match>
          <Match when={props.row.type === "task" ? props.row : undefined}>
            {(row) => row().status === "completed" ? "done" : "active"}
          </Match>
        </Switch>
      </text>
    </box>
  )
}

export function SessionToolActivityRow(props: { tool: string; detail: string; status: string; width?: number }) {
  const { themeV2 } = useTheme()
  return (
    <box width={props.width ?? "100%"} flexDirection="row" paddingLeft={1}>
      <text width={2} flexShrink={0} fg={themeV2.text.feedback.success.default}>ok</text>
      <box width={5} flexShrink={0} />
      <text flexShrink={0} fg={themeV2.text.default}>{props.tool}</text>
      <text flexShrink={1} wrapMode="none" overflow="hidden" fg={themeV2.text.subdued}>
        {" "}{props.detail}
      </text>
      <box flexGrow={1} />
      <text flexShrink={0} fg={themeV2.text.subdued}>{props.status}</text>
    </box>
  )
}
