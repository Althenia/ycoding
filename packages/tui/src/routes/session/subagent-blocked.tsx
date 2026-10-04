import type { TextareaRenderable } from "@opentui/core"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { useRoute } from "../../context/route"
import { useDialog } from "../../ui/dialog"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"

export function SubagentBlockedSurface(props: {
  title: string
  body?: string
  activity?: string
  blockedAt?: number
  question: string
}) {
  const { theme } = useTheme()
  const activity = createMemo(() => {
    const match = /^(.*?)\s{2,}(\d+\s+\S+)$/.exec(props.activity ?? "")
    return { description: match?.[1] ?? props.activity, result: match?.[2] }
  })
  const blocked = createMemo(() =>
    props.blockedAt === undefined ? undefined : Locale.duration(Math.max(0, Date.now() - props.blockedAt)),
  )

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={1} flexShrink={0}>
      <text fg={theme.text.feedback.info.default}>
        <b>{props.title.toUpperCase()} SUBAGENT</b>
      </text>
      <Show when={props.body}>
        {(body) => (
          <box marginTop={1}>
            <text fg={theme.text.default}>{body()}</text>
          </box>
        )}
      </Show>
      <Show when={props.activity}>
        <box height={1} marginTop={3} flexDirection="row">
          <text fg={theme.text.feedback.success.default}>ok</text>
          <box width={5} flexShrink={0} />
          <text fg={theme.text.default}>{activity().description}</text>
          <Show when={activity().result}>
            {(result) => (
              <>
                <box flexGrow={1} />
                <text fg={theme.text.subdued}>{result()}</text>
              </>
            )}
          </Show>
        </box>
      </Show>
      <box height={1} marginTop={2} flexDirection="row">
        <text fg={theme.text.feedback.warning.default}>?</text>
        <box width={5} flexShrink={0} />
        <text fg={theme.text.default}>awaiting decision</text>
        <Show when={blocked()}>
          {(duration) => (
            <>
              <box flexGrow={1} />
              <text fg={theme.text.feedback.warning.default}>blocked {duration()}</text>
            </>
          )}
        </Show>
      </box>
      <box marginTop={5} paddingLeft={3}>
        <text fg={theme.text.feedback.warning.default}>{props.question}</text>
      </box>
    </box>
  )
}

export function SubagentQuestionNotice(props: { task: SessionOrchestrationTask }) {
  const { theme } = useTheme()
  const route = useRoute()
  const shortcut = Keymap.useShortcut("session.child.first")
  return (
    <box
      paddingLeft={3}
      paddingRight={2}
      paddingBottom={1}
      flexShrink={0}
      onMouseUp={() => route.navigate({ type: "session", sessionID: props.task.sessionID })}
    >
      <text fg={theme.text.feedback.warning.default}>
        ? {props.task.agent} awaiting input{" "}
        <span style={{ fg: theme.text.subdued }}>· {shortcut()?.replaceAll("ctrl+", "⌃")} subagents</span>
      </text>
      <text fg={theme.text.feedback.warning.default}>{props.task.question?.text}</text>
    </box>
  )
}

export function SubagentAnswerComposer(props: { task: SessionOrchestrationTask }) {
  const { theme } = useTheme()
  const client = useClient()
  const data = useData()
  const dialog = useDialog()
  const keymap = Keymap.use()
  const questionID = props.task.question?.id
  const [submitting, setSubmitting] = createSignal(false)
  const [feedback, setFeedback] = createSignal<string>()
  let textarea: TextareaRenderable | undefined
  let answered = false

  onMount(() => onCleanup(keymap.mode.push("subagent-answer")))
  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (dialog.stack.length > 0) return textarea.blur()
    textarea.focus()
  })

  async function submit() {
    if (submitting() || answered || dialog.stack.length > 0 || !textarea?.plainText.trim()) return
    if (props.task.state !== "waiting" || !questionID || props.task.question?.id !== questionID) {
      setFeedback("Question changed or resolved · answer retained")
      return
    }
    const text = textarea.plainText
    setSubmitting(true)
    setFeedback(undefined)
    const result = await client.api.session.subagent
      .answer({
        parentID: props.task.parentID,
        childID: props.task.sessionID,
        questionID,
        text,
      })
      .then(
        () => ({ sent: true }) as const,
        (error: unknown) => ({ sent: false, error }) as const,
      )
    setSubmitting(false)
    if (!result.sent) {
      setFeedback(`Answer not sent · draft retained: ${errorMessage(result.error)}`)
      return
    }
    answered = true
    if (!textarea.isDestroyed && textarea.plainText === text) textarea.clear()
    setFeedback("Answer sent")
    data.session.subagent.invalidate(props.task.parentID)
    void data.session.subagent
      .sync(props.task.parentID)
      .catch((error: unknown) => setFeedback(`Answer sent · refresh failed: ${errorMessage(error)}`))
  }

  Keymap.createLayer(() => ({
    mode: "subagent-answer",
    commands: [{ id: "prompt.submit", title: "Submit subagent answer", run: () => void submit() }],
    bindings: ["prompt.submit"],
  }))

  return (
    <box paddingLeft={3} paddingRight={2} paddingTop={1} flexShrink={0}>
      <textarea
        ref={(value: TextareaRenderable) => {
          textarea = value
          value.traits = { status: "ANSWER" }
          value.focus()
        }}
        placeholder="Enter answer"
        placeholderColor={theme.text.subdued}
        textColor={theme.text.default}
        focusedTextColor={theme.text.default}
        cursorColor={theme.text.default}
        focusedBackgroundColor="transparent"
        minHeight={1}
        maxHeight={6}
        onSubmit={() => void submit()}
      />
      <Show when={submitting() || feedback()}>
        <text fg={theme.text.subdued}>{submitting() ? "Sending answer…" : feedback()}</text>
      </Show>
    </box>
  )
}
