import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
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

export function SubagentQuestionNotice(props: {
  task: SessionOrchestrationTask
  onAnswer?: () => void
  stale?: boolean
  answering?: boolean
}) {
  const { theme } = useTheme()
  const route = useRoute()
  const shortcut = Keymap.useShortcut("session.child.first")
  let details: ScrollBoxRenderable | undefined
  Keymap.createLayer(() => ({
    mode: "subagent-answer",
    priority: 1,
    enabled: () => Boolean(props.answering),
    commands: [
      {
        bind: "pageup",
        title: "Previous question page",
        run: () => details?.scrollBy(-Math.max(1, details.viewport.height)),
      },
      {
        bind: "pagedown",
        title: "Next question page",
        run: () => details?.scrollBy(Math.max(1, details.viewport.height)),
      },
    ],
  }))
  return (
    <box paddingLeft={3} paddingRight={2} paddingBottom={1} flexShrink={0}>
      <text
        fg={theme.text.feedback.warning.default}
        onMouseUp={() => route.navigate({ type: "session", sessionID: props.task.sessionID })}
      >
        ? {props.task.agent} {props.stale ? "question changed or resolved" : "awaiting input"}{" "}
        <span style={{ fg: theme.text.subdued }}>· {shortcut()?.replaceAll("ctrl+", "⌃")} subagents</span>
      </text>
      <scrollbox
        maxHeight={6}
        minHeight={1}
        flexShrink={0}
        scrollX={false}
        contentOptions={{ flexShrink: 0, minHeight: 0 }}
        scrollbarOptions={{ visible: false }}
        ref={(value: ScrollBoxRenderable) => {
          details = value
        }}
      >
        <text flexShrink={0} fg={theme.text.feedback.warning.default}>
          {props.task.question?.text}
        </text>
      </scrollbox>
      <Show when={props.answering}>
        <text fg={theme.text.subdued}>pgup/pgdn question</text>
      </Show>
      <Show when={props.onAnswer}>
        <text
          fg={theme.text.action.primary.default}
          onMouseUp={(event) => {
            event.stopPropagation()
            props.onAnswer?.()
          }}
        >
          Answer
        </text>
      </Show>
    </box>
  )
}

export function SubagentAnswerComposer(props: {
  task: SessionOrchestrationTask
  enabled?: boolean
  onClose?: () => void
  onAnswered?: () => void
}) {
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

  createEffect(() => {
    if (props.enabled === false) return
    onCleanup(keymap.mode.push("subagent-answer"))
  })
  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (props.enabled === false || dialog.stack.length > 0) return textarea.blur()
    textarea.focus()
  })

  async function submit() {
    if (
      props.enabled === false ||
      submitting() ||
      answered ||
      dialog.stack.length > 0 ||
      !textarea ||
      textarea.isDestroyed ||
      !textarea.plainText.trim()
    )
      return
    if (props.task.state !== "waiting" || !questionID || props.task.question?.id !== questionID) {
      setFeedback("Question changed or resolved · answer retained")
      return
    }
    const parentID = props.task.parentID
    const childID = props.task.sessionID
    const text = textarea.plainText
    setSubmitting(true)
    setFeedback(undefined)
    const result = await client.api.session.subagent
      .answer({
        parentID,
        childID,
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
    const unchanged = !textarea.isDestroyed && textarea.plainText === text
    if (unchanged) textarea.clear()
    setFeedback("Answer sent")
    data.session.subagent.invalidate(parentID)
    void data.session.subagent
      .sync(parentID)
      .catch((error: unknown) => setFeedback(`Answer sent · refresh failed: ${errorMessage(error)}`))
    if (unchanged) props.onAnswered?.()
  }

  Keymap.createLayer(() => ({
    mode: "subagent-answer",
    enabled: () => props.enabled !== false,
    commands: [
      { id: "prompt.submit", title: "Submit subagent answer", run: () => void submit() },
      ...(props.onClose ? [{ bind: "escape", title: "Return to parent draft", run: () => props.onClose?.() }] : []),
    ],
    bindings: ["prompt.submit"],
  }))

  return (
    <box visible={props.enabled !== false} paddingLeft={3} paddingRight={2} paddingTop={1} flexShrink={0}>
      <textarea
        ref={(value: TextareaRenderable) => {
          textarea = value
          value.traits = { status: "ANSWER" }
          if (props.enabled !== false) value.focus()
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
      <Show when={props.onClose}>
        <text fg={theme.text.subdued} onMouseUp={() => props.onClose?.()}>
          esc return to draft · enter send answer
        </text>
      </Show>
    </box>
  )
}
