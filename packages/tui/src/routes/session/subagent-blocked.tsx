import { createMemo, Show } from "solid-js"
import { Prompt } from "../../component/prompt"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"

export function SubagentBlockedSurface(props: {
  title: string
  body?: string
  activity?: string
  blockedAt?: number
  question: string
}) {
  const { themeV2 } = useTheme()
  const activity = createMemo(() => {
    const match = /^(.*?)\s{2,}(\d+\s+\S+)$/.exec(props.activity ?? "")
    return { description: match?.[1] ?? props.activity, result: match?.[2] }
  })
  const blocked = createMemo(() =>
    props.blockedAt === undefined ? undefined : Locale.duration(Math.max(0, Date.now() - props.blockedAt)),
  )

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={1} flexShrink={0}>
      <text fg={themeV2.text.feedback.info.default}>
        <b>{props.title.toUpperCase()} SUBAGENT</b>
      </text>
      <Show when={props.body}>
        {(body) => (
          <box marginTop={1}>
            <text fg={themeV2.text.default}>{body()}</text>
          </box>
        )}
      </Show>
      <Show when={props.activity}>
        <box height={1} marginTop={3} flexDirection="row">
          <text fg={themeV2.text.feedback.success.default}>ok</text>
          <box width={5} flexShrink={0} />
          <text fg={themeV2.text.default}>{activity().description}</text>
          <Show when={activity().result}>
            {(result) => (
              <>
                <box flexGrow={1} />
                <text fg={themeV2.text.subdued}>{result()}</text>
              </>
            )}
          </Show>
        </box>
      </Show>
      <box height={1} marginTop={2} flexDirection="row">
        <text fg={themeV2.text.feedback.warning.default}>?</text>
        <box width={5} flexShrink={0} />
        <text fg={themeV2.text.default}>awaiting decision</text>
        <Show when={blocked()}>
          {(duration) => (
            <>
              <box flexGrow={1} />
              <text fg={themeV2.text.feedback.warning.default}>blocked {duration()}</text>
            </>
          )}
        </Show>
      </box>
      <box marginTop={5} paddingLeft={3}>
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
    <box>
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
