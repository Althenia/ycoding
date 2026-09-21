import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import {
  modelLabel,
  previewText,
  shellOutputNotice,
  toolShellID,
  type ActivityItem,
  type AssistantPart,
  type PendingRequestView,
  type RemoteMessageView,
  type ShellOutputFetch,
  type ShellOutputView,
} from "../projection"
import { shellOutputPaging } from "../view-model"

type ToolPartView = Extract<AssistantPart, { kind: "tool" }>
type AssistantMessageView = Extract<RemoteMessageView, { kind: "assistant" }>

/**
 * A part's identity inside one message. A tool call keeps the call ID the device
 * published; text and reasoning keep their ordinal. A projection update replaces the
 * part object, so the key is what lets the row survive that update with its state.
 */
export function partKey(part: AssistantPart): string {
  return part.kind === "tool" ? `tool:${part.callID}` : `${part.kind}:${part.ordinal}`
}

/**
 * Whether a tool row is open. A part that has settled opens by default, and an
 * explicit toggle wins from then on, so a projection update can neither collapse
 * what the reader opened nor reopen what they closed.
 */
export function toolPartExpanded(input: {
  readonly touched: boolean
  readonly manual: boolean
  readonly status: ToolPartView["status"]
}): boolean {
  if (input.touched) return input.manual
  return input.status !== "running"
}

/**
 * Renders the text the client holds: a collapsed preview by default, the whole
 * available page once expanded. The toggle appears only when the preview is shorter
 * than the available text, so it always changes what is rendered.
 */
function BoundedText(props: { readonly text: string }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const preview = createMemo(() => previewText(props.text))
  return (
    <>
      <pre class="output" tabindex="0">
        <code>{expanded() ? props.text : preview().text}</code>
      </pre>
      <Show when={preview().hasMore}>
        <button type="button" class="button button--ghost button--small" onClick={() => setExpanded(!expanded())}>
          {expanded() ? "Show less" : "Show more"}
        </button>
      </Show>
    </>
  )
}

/**
 * One shell's captured output. It keeps two separate controls: "Show more" / "Show less"
 * expands only the text the client already holds, while "Load output" / "Load more output"
 * asks the device for one more explicit page. The device's own retained-bytes limit stays a
 * notice, so neither control stands in for output the device never sent, and a failed or
 * stalled page offers a retry instead of repeating itself.
 */
function ShellOutputSection(props: {
  readonly shellID: string
  readonly output?: ShellOutputView
  readonly fetch?: ShellOutputFetch
}): JSX.Element {
  const remote = useRemote()
  const paging = () => shellOutputPaging(props.output, props.fetch)
  const status = () => {
    const current = paging().status
    return current.kind === "idle" ? undefined : current.label
  }
  return (
    <div class="shell__output">
      <Show when={props.output !== undefined}>
        <BoundedText text={props.output?.text ?? ""} />
      </Show>
      <Show when={props.output === undefined ? undefined : shellOutputNotice(props.output)}>
        {(notice) => <p class="shell__pending">{notice()}</p>}
      </Show>
      <Show when={paging().hasMore}>
        <button
          type="button"
          class="button button--ghost button--small"
          disabled={paging().status.kind === "loading"}
          onClick={() => void remote.store.loadShellOutputPage(props.shellID)}
        >
          {paging().label}
        </button>
      </Show>
      <Show when={status()}>{(label) => <p class="shell__pending" role="status">{label()}</p>}</Show>
    </div>
  )
}

function ToolPart(props: { readonly part: () => ToolPartView }): JSX.Element {
  const [touched, setTouched] = createSignal(false)
  const [manual, setManual] = createSignal(false)
  const expanded = () => toolPartExpanded({ touched: touched(), manual: manual(), status: props.part().status })
  const shellID = () => toolShellID(props.part())
  const statusLabel = () => {
    if (props.part().status === "streaming") return "Preparing input"
    if (props.part().status === "running") return "Running"
    if (props.part().status === "completed") return "Completed"
    return "Failed"
  }
  return (
    <article class={`tool tool--${props.part().status}`}>
      <header class="tool__header">
        <button
          type="button"
          class="tool__toggle"
          aria-expanded={expanded()}
          onClick={() => {
            const next = !expanded()
            setManual(next)
            setTouched(true)
          }}
        >
          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={16} />
          <span class="tool__name">{props.part().name}</span>
          <span class="tool__status">{statusLabel()}</span>
        </button>
      </header>
      <Show when={expanded()}>
        <Show when={props.part().input !== undefined || props.part().inputText !== undefined}>
          <pre class="output" tabindex="0">
            <code>{props.part().inputText ?? JSON.stringify(props.part().input, null, 2)}</code>
          </pre>
        </Show>
        <For each={props.part().content}>
          {(block) =>
            block.kind === "text" ? (
              <pre class="output" tabindex="0">
                <code>{block.text}</code>
              </pre>
            ) : (
              <p class="tool__note">
                {block.type} content: {block.summary}
              </p>
            )
          }
        </For>
        <Show when={shellID()}>
          {(id) => <ShellOutputSection shellID={id()} output={props.part().shellOutput} fetch={props.part().shellOutputFetch} />}
        </Show>
        <Show when={props.part().error}>
          <p class="tool__error" role="status">
            {props.part().error}
          </p>
        </Show>
      </Show>
    </article>
  )
}

/**
 * One assistant message's parts. The keys come from the parts the projection currently
 * holds, so a part that is replaced keeps its row — and with it an open tool body, an
 * open reasoning block, and the focus of the control that was used to open it.
 */
function AssistantParts(props: { readonly parts: () => readonly AssistantPart[] }): JSX.Element {
  const keys = createMemo(() => props.parts().map(partKey))
  // A live key was produced by this same list, so it always resolves to a part.
  const part = (key: string) => props.parts().find((entry) => partKey(entry) === key)!
  return (
    <For each={keys()}>
      {(key) => <PartView part={() => part(key)} />}
    </For>
  )
}

function PartView(props: { readonly part: () => AssistantPart }): JSX.Element {
  const kind = () => props.part().kind
  return (
    <>
      <Show when={kind() === "text"}>
        <p class="message__text">{partText(props.part())}</p>
      </Show>
      <Show when={kind() === "reasoning"}>
        <details class="reasoning">
          <summary>Reasoning</summary>
          <p>{partText(props.part())}</p>
        </details>
      </Show>
      <Show when={kind() === "tool"}>
        <ToolPart part={() => toolOf(props.part())!} />
      </Show>
    </>
  )
}

export function MessageRow(props: { readonly message: () => RemoteMessageView }): JSX.Element {
  const kind = () => props.message().kind
  return (
    <Show when={kind() !== "notice"} fallback={<p class="notice">{noticeText(props.message())}</p>}>
      <article class={`message message--${kind()}`}>
        <Show when={kind() === "user"}>
          <div class="message__meta">
            <Icon name="user" size={14} />
            <span>You</span>
            <Show when={userDelivery(props.message()) === "queue"}>
              <span class="message__hint">queued</span>
            </Show>
            <Show when={userState(props.message()) === "pending"}>
              <span class="message__hint">pending</span>
            </Show>
            <Show when={userState(props.message()) === "promoted"}>
              <Icon name="check" size={14} />
            </Show>
          </div>
          <p class="message__text">{userText(props.message())}</p>
        </Show>

        <Show when={kind() === "assistant"}>
          <div class="message__meta">
            <Icon name="terminal" size={14} />
            <span>{assistantOf(props.message())?.agent ?? "agent"}</span>
            <Show when={modelLabel(assistantOf(props.message())?.model)}>
              <span class="message__hint">{modelLabel(assistantOf(props.message())?.model)}</span>
            </Show>
            <Show when={assistantOf(props.message())?.error}>
              <span class="message__error">{assistantOf(props.message())?.error}</span>
            </Show>
          </div>
          <AssistantParts parts={() => assistantOf(props.message())?.parts ?? []} />
        </Show>

        <Show when={kind() === "system" || kind() === "synthetic"}>
          <p class="message__system">{systemText(props.message())}</p>
        </Show>

        <Show when={kind() === "shell"}>
          <div class="shell">
            <div class="shell__header">
              <Icon name="terminal" size={16} />
              <code>{shellOf(props.message())?.command ?? ""}</code>
              <span class="shell__status">{shellStatus(props.message())}</span>
            </div>
            <ShellOutputSection
              shellID={shellOf(props.message())?.shellID ?? ""}
              output={shellOf(props.message())?.output}
              fetch={shellOf(props.message())?.outputFetch}
            />
          </div>
        </Show>

        <Show when={kind() === "compaction"}>
          <p class="notice">{compactionText(props.message())}</p>
        </Show>
      </article>
    </Show>
  )
}

/**
 * One pending request. The reply draft and the selected answers live in this component,
 * so the card survives a projection update that replaces its request object.
 */
export function RequestCard(props: { readonly request: () => PendingRequestView; readonly activeSessionID?: string }): JSX.Element {
  const remote = useRemote()
  const [custom, setCustom] = createSignal<Readonly<Record<number, string>>>({})
  const [selected, setSelected] = createSignal<Readonly<Record<number, readonly string[]>>>({})

  const canReply = () => {
    const request = props.request()
    if (request.kind !== "guardrail") return true
    return props.activeSessionID !== undefined && request.sessionID === props.activeSessionID
  }

  return (
    <article class={`request request--${props.request().kind}${isHardReview(props.request()) ? " request--hard" : ""}`} aria-live="polite">
      <Show when={props.request().kind === "permission"}>
        <header class="request__header">
          <Icon name="shield" size={16} />
          <span>Permission request</span>
        </header>
        <p class="request__body">
          <strong>{permissionAction(props.request())}</strong>
          <Show when={resourceList(props.request()).length > 0}>
            <span> on {resourceList(props.request()).join(", ")}</span>
          </Show>
        </p>
        <div class="request__actions">
          <button
            type="button"
            class="button button--primary button--small"
            onClick={() => void remote.store.replyPermission(props.request().id, "once")}
          >
            Approve once
          </button>
          <button
            type="button"
            class="button button--secondary button--small"
            onClick={() => void remote.store.replyPermission(props.request().id, "always")}
          >
            Always this session
          </button>
          <button
            type="button"
            class="button button--danger button--small"
            onClick={() => void remote.store.replyPermission(props.request().id, "reject")}
          >
            Deny
          </button>
        </div>
      </Show>

      <Show when={props.request().kind === "guardrail"}>
        <header class="request__header">
          <Icon name="alert" size={16} />
          <span>Guardrail review{isHardReview(props.request()) ? " (human decision required)" : ""}</span>
        </header>
        <p class="request__body">
          <strong>{guardrailAction(props.request())}</strong>
          <span> — {guardrailReason(props.request())}</span>
        </p>
        <Show when={!canReply()}>
          <p class="request__note">This review belongs to another session in the session family. Open that session to answer it here.</p>
        </Show>
        <div class="request__actions">
          <button
            type="button"
            class="button button--primary button--small"
            disabled={!canReply()}
            onClick={() => void remote.store.replyGuardrail(props.request().id, "once")}
          >
            Approve once
          </button>
          <Show when={props.request().kind === "guardrail" && !isHardReview(props.request())}>
            <button
              type="button"
              class="button button--secondary button--small"
              disabled={!canReply()}
              onClick={() => void remote.store.replyGuardrail(props.request().id, "always")}
            >
              Always this process
            </button>
          </Show>
          <button
            type="button"
            class="button button--danger button--small"
            disabled={!canReply()}
            onClick={() => void remote.store.replyGuardrail(props.request().id, "reject")}
          >
            Reject
          </button>
        </div>
      </Show>

      <Show when={props.request().kind === "question"}>
        <header class="request__header">
          <Icon name="chat" size={16} />
          <span>Question</span>
        </header>
        <For each={questionList(props.request())}>
          {(question, questionIndex) => (
            <fieldset class="question">
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              <For each={question.options}>
                {(option) => (
                  <label class="question__option">
                    <input
                      type={question.multiple ? "checkbox" : "radio"}
                      name={`${props.request().id}-${questionIndex()}`}
                      value={option.label}
                      checked={(selected()[questionIndex()] ?? []).includes(option.label)}
                      onChange={() => {
                        setSelected((current) => {
                          const answers = current[questionIndex()] ?? []
                          return {
                            ...current,
                            [questionIndex()]: question.multiple
                              ? answers.includes(option.label)
                                ? answers.filter((entry) => entry !== option.label)
                                : [...answers, option.label]
                              : [option.label],
                          }
                        })
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong> — {option.description}
                    </span>
                  </label>
                )}
              </For>
              <Show when={question.custom}>
                <label class="question__custom">
                  <span>Custom answer</span>
                  <input
                    type="text"
                    value={custom()[questionIndex()] ?? ""}
                    onInput={(event) => setCustom((current) => ({ ...current, [questionIndex()]: event.currentTarget.value }))}
                  />
                </label>
              </Show>
            </fieldset>
          )}
        </For>
        <div class="request__actions">
          <button
            type="button"
            class="button button--primary button--small"
            onClick={() => {
              const answers = questionList(props.request()).map((_, index) => {
                const answer = selected()[index] ?? []
                const written = custom()[index]?.trim()
                return written === undefined || written.length === 0 ? answer : [...answer, written]
              })
              void remote.store.replyQuestion(props.request().id, answers.length > 0 ? answers : [[""]])
            }}
          >
            Send answer
          </button>
        </div>
      </Show>
    </article>
  )
}

export function ActivityRow(props: { readonly item: ActivityItem }): JSX.Element {
  return (
    <li class={`activity-row activity-row--${props.item.kind}`}>
      <span class="activity-row__icon" aria-hidden="true">
        <Icon
          name={
            props.item.kind === "terminal"
              ? "terminal"
              : props.item.kind === "file"
                ? "file"
                : props.item.kind === "approval"
                  ? "shield"
                  : props.item.kind === "status"
                    ? "activity"
                    : "settings"
          }
          size={16}
        />
      </span>
      <span class="activity-row__body">
        <span class="activity-row__title">{props.item.title}</span>
        <Show when={props.item.detail}>
          <span class="activity-row__detail">{props.item.detail}</span>
        </Show>
      </span>
      <span class="activity-row__status">{props.item.status}</span>
    </li>
  )
}

const userText = (message: RemoteMessageView) => (message.kind === "user" ? message.text : "")
const userDelivery = (message: RemoteMessageView) => (message.kind === "user" ? message.delivery : undefined)
const userState = (message: RemoteMessageView) => (message.kind === "user" ? message.state : undefined)
const assistantOf = (message: RemoteMessageView): AssistantMessageView | undefined => (message.kind === "assistant" ? message : undefined)
const systemText = (message: RemoteMessageView) => (message.kind === "system" || message.kind === "synthetic" ? message.text : "")
const noticeText = (message: RemoteMessageView) => (message.kind === "notice" ? message.text : "")
const shellOf = (message: RemoteMessageView) => (message.kind === "shell" ? message : undefined)
const shellStatus = (message: RemoteMessageView) => {
  const shell = shellOf(message)
  return shell === undefined ? "" : `${shell.status}${shell.exit === undefined ? "" : ` (exit ${shell.exit})`}`
}
const compactionText = (message: RemoteMessageView) => {
  if (message.kind !== "compaction") return ""
  const trigger = message.trigger === undefined ? "" : ` (${message.trigger})`
  const error = message.error === undefined ? "" : `: ${message.error}`
  return `Compaction ${message.status}${trigger}${error}`
}
const permissionAction = (request: PendingRequestView) => (request.kind === "permission" ? request.action : "")
const guardrailAction = (request: PendingRequestView) => (request.kind === "guardrail" ? request.action : "")
const guardrailReason = (request: PendingRequestView) => (request.kind === "guardrail" ? request.reason : "")
const isHardReview = (request: PendingRequestView) => request.kind === "guardrail" && request.hardReview
const resourceList = (request: PendingRequestView) => (request.kind === "permission" ? request.resources : [])
const questionList = (request: PendingRequestView) => (request.kind === "question" ? request.questions : [])
const partText = (part: AssistantPart) => (part.kind === "text" || part.kind === "reasoning" ? part.text : "")
const toolOf = (part: AssistantPart): ToolPartView | undefined => (part.kind === "tool" ? part : undefined)
