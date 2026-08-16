import { createMemo, Show } from "solid-js"
import { Prompt } from "../../component/prompt"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"

export function SubagentBlockedSurface(props: {
  title: string
  body?: string
  activity?: string
  question: string
}) {
  const { themeV2 } = useTheme()

  return (
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
      <text fg={themeV2.text.feedback.info.default}>
        <b>{props.title.toUpperCase()} SUBAGENT</b>
      </text>
      <Show when={props.body}>
        {(body) => <text fg={themeV2.text.default}>{body()}</text>}
      </Show>
      <Show when={props.activity}>
        {(activity) => (
          <box border={["top", "bottom"]} borderColor={themeV2.border.default} paddingTop={1} paddingBottom={1}>
            <text fg={themeV2.text.feedback.info.default}>task</text>
            <text fg={themeV2.text.subdued}> {activity()}</text>
          </box>
        )}
      </Show>
      <box border={["top", "bottom"]} borderColor={themeV2.border.default} paddingTop={1} paddingBottom={1}>
        <text fg={themeV2.text.feedback.warning.default}>? awaiting decision</text>
      </box>
      <box border={["left"]} borderColor={themeV2.text.feedback.warning.default} paddingLeft={2}>
        <text fg={themeV2.text.feedback.warning.default}>{props.question}</text>
      </box>
    </box>
  )
}

export function SubagentAnswerComposer(props: { sessionID: string; branch?: string }) {
  const { themeV2 } = useTheme()
  const submitShortcut = Keymap.useShortcut("input.submit")
  const hint = createMemo(() => submitShortcut()?.replaceAll("ctrl+", "⌃").replaceAll("enter", "Enter"))

  return (
    <box border={["top"]} borderColor={themeV2.text.feedback.warning.default}>
      <Prompt
        landing
        sessionID={props.sessionID}
        branch={props.branch}
        placeholders={{ normal: ["Enter answer"] }}
        hint={
          <text fg={themeV2.text.subdued}>
            {hint()} answer
          </text>
        }
        right={<text fg={themeV2.text.feedback.warning.default}>answering</text>}
      />
    </box>
  )
}
