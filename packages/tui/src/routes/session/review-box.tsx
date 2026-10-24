import type { FormAnswer, FormInfo, QuestionAnswer, SessionReviewDecision, SessionReviewItem } from "@ycoding-ai/client"
import type { SessionReview } from "@ycoding-ai/schema/session-review"
import { GuardrailEscalation } from "../../guardrail-escalation"
import type { BaseRenderable, BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { Keymap } from "../../context/keymap"
import { useDialog } from "../../ui/dialog"
import { errorMessage } from "../../util/error"
import { escapeTerminalText } from "../../util/terminal-text"
import { FormPrompt } from "./form"
import { Prompt } from "./permission"
import { guardrailGradeDetails } from "./guardrail-grades"
import { ProjectEscalation } from "./project-escalation"

export function reviewReasonLabel(reason: SessionReview.Reason) {
  switch (reason) {
    case "disabled":
      return "automatic decisions are disabled"
    case "free_text":
      return "needs a written answer"
    case "refused":
      return "decision model refused"
    case "low_confidence":
      return "decision model was unsure"
    case "escalated":
      return "decision model escalated"
    case "error":
      return "decision model error"
    case "timeout":
      return "decision model timed out"
    case "conflicting_grades":
    case "unavailable":
    case "invalid-request":
    case "provider-failed":
    case "input-too-large":
    case "invalid-output":
    case "truncated-output":
    case "unsupported-output":
      return GuardrailEscalation.text({ reason })
    case "sleep_entry":
      return "deferred when sleep started"
    case "restart":
      return "child restarted during tool execution"
  }
}

export function reviewAttribution(item: SessionReviewItem) {
  if (item.child) return escapeTerminalText(`child · ${item.child.agent} · ${item.child.description}`)
  return escapeTerminalText(item.sessionTitle)
}

function reviewKindLabel(item: SessionReviewItem) {
  switch (item.kind) {
    case "question":
      return item.payload.type === "form"
        ? `${item.payload.questionTool ? "Question" : "Form"} · ${escapeTerminalText(item.payload.title)}`
        : "Questions"
    case "subagent_question":
      return "Subagent question"
    case "guardrail":
      return "Guardrail review"
    case "permission":
      return "Permission"
    case "recovery":
      return "Restart recovery"
  }
}

function reviewProvenance(item: SessionReviewItem) {
  return escapeTerminalText(
    [
      reviewReasonLabel(item.reason),
      item.choice,
      item.confidence === undefined ? undefined : item.confidence.toString(),
    ]
      .filter((part): part is string => part !== undefined && part !== "")
      .join(" · "),
  )
}

export function ReviewBox(props: {
  items: SessionReviewItem[]
  currentSessionID: string
  asleep: boolean
  activeItemID?: string
  pendingItemID?: string
  failed: Record<string, string>
  onOpen: (item: SessionReviewItem) => void
  onJump: (sessionID: string) => void
  onDismiss: (item: SessionReviewItem) => void
  onFocusChange?: (focused: boolean) => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [box, setBox] = createSignal<BoxRenderable>()
  let list: ScrollBoxRenderable | undefined
  let heading: BoxRenderable | undefined
  const [expanded, setExpanded] = createSignal(false)
  createEffect(() => {
    const root = box()
    if (!root) return
    const update = () => {
      let element: BaseRenderable | null = renderer.currentFocusedRenderable
      while (element) {
        if (element === root) {
          props.onFocusChange?.(true)
          return
        }
        element = element.parent
      }
      props.onFocusChange?.(false)
    }
    renderer.on("focused_renderable", update)
    update()
    onCleanup(() => {
      renderer.off("focused_renderable", update)
      props.onFocusChange?.(false)
    })
  })
  createEffect(
    on(
      () => props.asleep,
      (asleep, previous) => {
        if (previous === undefined || previous !== asleep) setExpanded(!asleep)
      },
      { defer: false },
    ),
  )
  createEffect(
    on(
      () => props.activeItemID,
      (active, previous) => {
        if (active) setExpanded(false)
        if (!active && previous && !props.asleep) setExpanded(true)
      },
    ),
  )
  const count = () => props.items.length
  const page = (direction: -1 | 1) => list?.scrollBy(direction * Math.max(1, list.viewport.height))
  Keymap.createLayer(() => ({
    mode: "global",
    target: box,
    priority: 1,
    commands: [
      { bind: "pageup", title: "Previous review page", run: () => page(-1) },
      { bind: "pagedown", title: "Next review page", run: () => page(1) },
    ],
  }))

  return (
    <Show when={count() > 0}>
      <box
        ref={(value: BoxRenderable) => {
          setBox(value)
        }}
        flexDirection="column"
        flexShrink={0}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
      >
        <box
          ref={(value: BoxRenderable) => {
            heading = value
          }}
          focusable={true}
          flexDirection="row"
          onMouseDown={() => heading?.focus()}
          onMouseUp={() => setExpanded((value) => !value)}
          onKeyDown={(key) => {
            if (key.name !== "return" && key.name !== "space") return
            key.preventDefault()
            key.stopPropagation()
            setExpanded((value) => !value)
          }}
        >
          <text width={2} flexShrink={0} fg={theme.text.subdued}>
            {expanded() ? "-" : "+"}
          </text>
          <text fg={theme.text.feedback.warning.default} wrapMode="none">
            Review · {count()} waiting
          </text>
          <box flexGrow={1} />
          <Show when={expanded() && dimensions().width >= 80}>
            <text fg={theme.text.subdued} wrapMode="none">
              pgup/pgdn review
            </text>
          </Show>
        </box>
        <Show when={expanded()}>
          <scrollbox
            ref={(value: ScrollBoxRenderable) => {
              list = value
            }}
            maxHeight={props.activeItemID ? 2 : Math.max(3, Math.floor(dimensions().height / 4))}
            scrollX={false}
            contentOptions={{ flexShrink: 0 }}
            verticalScrollbarOptions={{
              trackOptions: { backgroundColor: "transparent", foregroundColor: theme.scrollbar.default },
            }}
          >
            <For each={props.items}>
              {(item) => (
                <ReviewItemRow
                  item={item}
                  currentSessionID={props.currentSessionID}
                  active={props.activeItemID === item.itemID}
                  disabled={props.pendingItemID !== undefined}
                  failed={props.failed[item.itemID]}
                  onOpen={() => props.onOpen(item)}
                  onJump={() => props.onJump(item.sessionID)}
                  onDismiss={() => props.onDismiss(item)}
                />
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
    </Show>
  )
}

function ReviewItemRow(props: {
  item: SessionReviewItem
  currentSessionID: string
  active: boolean
  disabled: boolean
  failed?: string
  onOpen: () => void
  onJump: () => void
  onDismiss: () => void
}) {
  const { theme } = useTheme()
  const [rowElement, setRowElement] = createSignal<BoxRenderable>()
  const dismissible = () => props.item.kind === "question" || props.item.kind === "subagent_question"
  const action = () =>
    props.failed
      ? "Details"
      : props.item.kind === "guardrail" || props.item.kind === "permission" || props.item.kind === "recovery"
        ? "Decide"
        : "Answer"
  Keymap.createLayer(() => ({
    mode: "global",
    target: rowElement,
    priority: 2,
    enabled: rowElement() !== undefined && props.item.sessionID !== props.currentSessionID,
    commands: [{ bind: "o", title: "Open review Session", run: props.onJump }],
  }))
  const target = () => {
    if (props.item.kind === "guardrail" || props.item.kind === "permission")
      return [props.item.payload.action, ...(props.item.payload.resources ?? [])].filter(Boolean).join(" · ")
    if (props.item.kind === "subagent_question") return props.item.payload.text
    return undefined
  }

  return (
    <box
      ref={setRowElement}
      flexDirection="column"
      paddingLeft={2}
      paddingTop={1}
      focusable={true}
      onMouseDown={() => rowElement()?.focus()}
      onKeyDown={(key) => {
        if (key.name !== "return") return
        key.preventDefault()
        key.stopPropagation()
        if (!props.disabled) props.onOpen()
      }}
    >
      <box flexDirection="row" gap={3}>
        <text fg={theme.text.default} wrapMode="none" truncate flexShrink={1}>
          {reviewKindLabel(props.item)}
        </text>
        <text
          fg={theme.text.subdued}
          wrapMode="none"
          truncate
          flexShrink={1}
          onMouseUp={() => {
            if (props.item.sessionID !== props.currentSessionID) props.onJump()
          }}
        >
          {reviewAttribution(props.item)}
        </text>
        <box flexGrow={1} />
        <Show when={!props.active}>
          <text
            fg={props.disabled ? theme.text.subdued : theme.text.feedback.info.default}
            wrapMode="none"
            flexShrink={0}
            onMouseUp={() => {
              if (!props.disabled) props.onOpen()
            }}
          >
            {action()}
          </text>
        </Show>
        <Show when={dismissible() && !props.active}>
          <text
            fg={props.disabled || props.failed ? theme.text.subdued : theme.text.default}
            wrapMode="none"
            flexShrink={0}
            onMouseUp={() => {
              if (!props.disabled && !props.failed) props.onDismiss()
            }}
          >
            Dismiss
          </text>
        </Show>
        <Show when={props.item.sessionID !== props.currentSessionID}>
          <text fg={theme.text.default} wrapMode="none" flexShrink={0} onMouseUp={props.onJump}>
            o Open
          </text>
        </Show>
      </box>
      <text fg={theme.text.subdued} wrapMode="word">
        {reviewProvenance(props.item)}
      </text>
      <ProjectEscalation value={"coordinationEscalation" in props.item.payload ? props.item.payload.coordinationEscalation : undefined} />
      <Show when={target()}>
        {(value) => (
          <text fg={theme.text.subdued} wrapMode="word">
            {escapeTerminalText(value())}
          </text>
        )}
      </Show>
      <Show when={props.failed}>
        {(message) => (
          <text fg={theme.text.feedback.error.default} wrapMode="word">
            Decision unresolved · {escapeTerminalText(message())}
          </text>
        )}
      </Show>
      <ReviewGrades grades={props.item.grades} choice={props.item.choice} theme={theme} />
    </box>
  )
}

function ReviewGrades(props: {
  grades: SessionReviewItem["grades"]
  choice: SessionReviewItem["choice"]
  theme: ReturnType<typeof useTheme>["theme"]
}) {
  return (
    <For each={guardrailGradeDetails(props.grades, props.choice)}>
      {(line) => (
        <text fg={props.theme.text.subdued} wrapMode="word">
          <span style={{ fg: props.theme.text.label }}>{line.label}</span> {line.value}
        </text>
      )}
    </For>
  )
}

export function ReviewItemEditor(props: {
  item: SessionReviewItem
  disabled: boolean
  error?: string
  onDecide: (item: SessionReviewItem, decision: SessionReviewDecision) => Promise<void>
  onClose: () => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const decide = (decision: SessionReviewDecision) => {
    if (props.disabled) return Promise.reject(new Error("Decision already in flight"))
    return props.onDecide(props.item, decision)
  }
  const dismiss = () => {
    if (props.disabled || (props.item.kind !== "question" && props.item.kind !== "subagent_question")) return
    void decide({ kind: props.item.kind, dismissed: true }).catch(() => undefined)
  }
  Keymap.createLayer(() => ({
    mode: props.item.kind === "question" ? "form" : "review-answer",
    enabled:
      !props.disabled &&
      dialog.stack.length === 0 &&
      (props.item.kind === "question" || props.item.kind === "subagent_question"),
    commands: [{ bind: "ctrl+shift+d", title: "Dismiss review question", run: dismiss }],
  }))
  Keymap.createLayer(() => ({
    mode: "form",
    enabled: props.item.kind === "question" && props.disabled && dialog.stack.length === 0,
    commands: [{ bind: "escape", title: "Close review item", run: props.onClose }],
  }))

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={props.error}>
        {(message) => (
          <box paddingLeft={3}>
            <text fg={theme.text.feedback.error.default}>Decision unresolved · {escapeTerminalText(message())}</text>
          </box>
        )}
      </Show>
      <Show when={props.disabled}>
        <box paddingLeft={3} flexDirection="column">
          <text fg={theme.text.subdued}>Decision controls unavailable</text>
          <Show when={props.item.kind === "question"}>
            <text fg={theme.text.subdued} onMouseUp={props.onClose}>
              esc not now
            </text>
          </Show>
        </box>
      </Show>
      <Switch>
        <Match when={props.item.kind === "guardrail" ? props.item : undefined}>
          {(item) => (
            <ReviewGuardrailEditor
              item={item() as Extract<SessionReviewItem, { kind: "guardrail" }>}
              disabled={props.disabled}
              onDecide={decide}
              onClose={props.onClose}
            />
          )}
        </Match>
        <Match when={props.item.kind === "permission" ? props.item : undefined}>
          {(item) => (
            <ReviewPermissionEditor
              item={item() as Extract<SessionReviewItem, { kind: "permission" }>}
              disabled={props.disabled}
              onDecide={decide}
              onClose={props.onClose}
            />
          )}
        </Match>
        <Match when={props.item.kind === "recovery" ? props.item : undefined}>
          {(item) => (
            <ReviewRecoveryEditor
              item={item() as Extract<SessionReviewItem, { kind: "recovery" }>}
              disabled={props.disabled}
              onDecide={decide}
              onClose={props.onClose}
            />
          )}
        </Match>
        <Match when={props.item.kind === "question" ? props.item : undefined}>
          {(item) => (
            <ReviewQuestionEditor
              item={item() as Extract<SessionReviewItem, { kind: "question" }>}
              disabled={props.disabled}
              onDecide={decide}
              onClose={props.onClose}
            />
          )}
        </Match>
        <Match when={props.item.kind === "subagent_question" ? props.item : undefined}>
          {(item) => (
            <ReviewSubagentEditor
              item={item() as Extract<SessionReviewItem, { kind: "subagent_question" }>}
              disabled={props.disabled}
              onDecide={decide}
              onClose={props.onClose}
            />
          )}
        </Match>
      </Switch>
      <Show when={props.item.kind === "question" || props.item.kind === "subagent_question"}>
        <box paddingLeft={3}>
          <text fg={props.disabled ? theme.text.subdued : theme.text.feedback.info.default} onMouseUp={dismiss}>
            ctrl+shift+d dismiss
          </text>
        </box>
      </Show>
    </box>
  )
}

function ReviewGuardrailEditor(props: {
  item: Extract<SessionReviewItem, { kind: "guardrail" }>
  disabled: boolean
  onDecide: (decision: SessionReviewDecision) => Promise<void>
  onClose: () => void
}) {
  const { theme } = useTheme().contextual("elevated")
  const payload = () => props.item.payload

  return (
    <Prompt
      kind="guardrail"
      hardReview={payload().hardReview}
      title="Guardrail blocked"
      semanticLabel={`guardrail · ${payload().reason}`}
      instance={props.item.itemID}
      escapeKey="later"
      nonMutatingOptions={["later"]}
      disabled={props.disabled}
      defaultOption="reject"
      options={
        payload().hardReview
          ? { reject: "Deny", once: "Allow once", later: "Not now" }
          : payload().directories.length > 0
            ? { reject: "Deny", once: "Allow once", always: "Allow for this session", later: "Not now" }
            : { reject: "Deny", once: "Allow once", later: "Not now" }
      }
      onSelect={(option) => {
        if (option === "later") return props.onClose()
        if (option === "once" || option === "always" || option === "reject")
          void props.onDecide({ kind: "guardrail", reply: option }).catch(() => undefined)
      }}
      body={
        <box flexDirection="column">
          <box paddingLeft={3} paddingRight={3}><ProjectEscalation value={payload().coordinationEscalation} /></box>
          <box paddingLeft={3} paddingRight={3}>
            <text fg={theme.text.feedback.info.default}>{escapeTerminalText(payload().reason)}</text>
          </box>
          <box paddingLeft={3} paddingRight={3}>
            <text fg={theme.text.subdued}>{reviewProvenance(props.item)}</text>
          </box>
          <box paddingLeft={6} paddingRight={3} flexDirection="column">
            <text fg={theme.text.subdued}>Action: {escapeTerminalText(payload().action)}</text>
            <For each={payload().resources}>
              {(value) => <text fg={theme.text.subdued}>Resource: {escapeTerminalText(value)}</text>}
            </For>
            <For each={payload().ruleIDs}>
              {(value) => <text fg={theme.text.subdued}>Rule: {escapeTerminalText(value)}</text>}
            </For>
            <ReviewGrades grades={props.item.grades} choice={props.item.choice} theme={theme} />
          </box>
        </box>
      }
    />
  )
}

function ReviewPermissionEditor(props: {
  item: Extract<SessionReviewItem, { kind: "permission" }>
  disabled: boolean
  onDecide: (decision: SessionReviewDecision) => Promise<void>
  onClose: () => void
}) {
  const { theme } = useTheme().contextual("elevated")
  const payload = () => props.item.payload

  return (
    <Prompt
      kind="permission"
      title="Permission required"
      semanticLabel={`permission · ${payload().action}`}
      instance={props.item.itemID}
      escapeKey="later"
      nonMutatingOptions={["later"]}
      disabled={props.disabled}
      defaultOption="once"
      options={
        payload().save?.length
          ? { once: "Allow once", always: "Allow always", reject: "Deny", later: "Not now" }
          : { once: "Allow once", reject: "Deny", later: "Not now" }
      }
      onSelect={(option) => {
        if (option === "later") return props.onClose()
        if (option === "once" || option === "always" || option === "reject")
          void props.onDecide({ kind: "permission", reply: option }).catch(() => undefined)
      }}
      body={
        <box flexDirection="column" paddingLeft={3} paddingRight={3}>
          <ProjectEscalation value={payload().coordinationEscalation} />
          <text fg={theme.text.subdued}>{reviewProvenance(props.item)}</text>
          <text fg={theme.text.subdued}>Action: {escapeTerminalText(payload().action)}</text>
          <For each={payload().resources}>
            {(value) => <text fg={theme.text.subdued}>Resource: {escapeTerminalText(value)}</text>}
          </For>
        </box>
      }
    />
  )
}

function ReviewRecoveryEditor(props: {
  item: Extract<SessionReviewItem, { kind: "recovery" }>
  disabled: boolean
  onDecide: (decision: SessionReviewDecision) => Promise<void>
  onClose: () => void
}) {
  const { theme } = useTheme().contextual("elevated")

  return (
    <Prompt
      kind="recovery"
      title="Restart recovery"
      semanticLabel={`recovery · ${props.item.itemID}`}
      instance={props.item.itemID}
      escapeKey="later"
      nonMutatingOptions={["later"]}
      disabled={props.disabled}
      defaultOption="later"
      options={{ continue: "Continue", stop: "Stop", later: "Not now" }}
      onSelect={(option) => {
        if (option === "later") return props.onClose()
        void props.onDecide({ kind: "recovery", choice: option }).catch(() => undefined)
      }}
      body={
        <box flexDirection="column" paddingLeft={3} paddingRight={3}>
          <text fg={theme.text.feedback.warning.default} wrapMode="word">
            These tools were running when the child stopped. Their outcome is unknown, and YCoding does not replay them.
          </text>
          <text fg={theme.text.subdued}>{reviewProvenance(props.item)}</text>
          <For each={props.item.payload.tools}>
            {(tool) => (
              <text fg={theme.text.subdued} wrapMode="word">
                Tool: {escapeTerminalText(tool.name)} · call {escapeTerminalText(tool.callID)} · message{" "}
                {escapeTerminalText(tool.messageID)}
              </text>
            )}
          </For>
        </box>
      }
    />
  )
}

function ReviewQuestionEditor(props: {
  item: Extract<SessionReviewItem, { kind: "question" }>
  disabled: boolean
  onDecide: (decision: SessionReviewDecision) => Promise<void>
  onClose: () => void
}) {
  const form = createMemo((): FormInfo => {
    const payload = props.item.payload
    if (payload.type === "form")
      return { id: props.item.itemID, sessionID: props.item.sessionID, title: payload.title, fields: payload.fields, coordinationEscalation: payload.coordinationEscalation }
    return {
      id: props.item.itemID,
      sessionID: props.item.sessionID,
      title: "Questions",
      fields: payload.questions.map((question, index) => ({
        key: `q${index}`,
        title: question.header,
        description: question.question,
        required: true,
        type: question.multiple ? ("multiselect" as const) : ("string" as const),
        options: question.options.map((option) => ({
          value: option.label,
          label: option.label,
          description: option.description,
        })),
        ...(question.custom === undefined ? {} : { custom: question.custom }),
      })) as unknown as FormInfo["fields"],
    }
  })
  const submit = async (answer: FormAnswer) => {
    const payload = props.item.payload
    if (payload.type === "form") return props.onDecide({ kind: "question", answers: answer })
    const answers: QuestionAnswer[] = payload.questions.map((_, index) => {
      const value = answer[`q${index}`]
      if (Array.isArray(value)) return value.map((item) => String(item))
      return value === undefined ? [] : [String(value)]
    })
    return props.onDecide({ kind: "question", answers })
  }

  return <FormPrompt form={form()} disabled={props.disabled} onSubmit={submit} onCancel={props.onClose} />
}

function ReviewSubagentEditor(props: {
  item: Extract<SessionReviewItem, { kind: "subagent_question" }>
  disabled: boolean
  onDecide: (decision: SessionReviewDecision) => Promise<void>
  onClose: () => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const keymap = Keymap.use()
  const [submitting, setSubmitting] = createSignal(false)
  const [feedback, setFeedback] = createSignal<string>()
  let textarea: TextareaRenderable | undefined
  let answered = false

  createEffect(() => {
    onCleanup(keymap.mode.push("review-answer"))
  })
  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (props.disabled || dialog.stack.length > 0) return textarea.blur()
    textarea.focus()
  })

  async function submit() {
    if (
      props.disabled ||
      submitting() ||
      answered ||
      dialog.stack.length > 0 ||
      !textarea ||
      textarea.isDestroyed ||
      !textarea.plainText.trim()
    )
      return
    const text = textarea.plainText
    setSubmitting(true)
    setFeedback(undefined)
    const result = await props.onDecide({ kind: "subagent_question", text }).then(
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
  }

  Keymap.createLayer(() => ({
    mode: "review-answer",
    enabled: dialog.stack.length === 0,
    commands: [
      { id: "prompt.submit", title: "Submit review answer", run: () => void submit() },
      { bind: "escape", title: "Close review item", run: () => props.onClose() },
    ],
    bindings: ["prompt.submit"],
  }))

  return (
    <box flexDirection="column" paddingLeft={3} paddingRight={2} paddingTop={1} flexShrink={0}>
      <text fg={theme.text.feedback.warning.default} wrapMode="word">
        {escapeTerminalText(props.item.payload.text)}
      </text>
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
      <text fg={theme.text.subdued} onMouseUp={props.onClose}>
        esc not now · enter send answer
      </text>
    </box>
  )
}
