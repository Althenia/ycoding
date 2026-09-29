import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { catalogKey, modelDisplayLabel } from "../catalog"
import { useRemote } from "../context"
import {
  formatPartDuration,
  classifySyntheticNotice,
  noticeSummary,
  previewText,
  shellOutputNotice,
  toolShellID,
  toolSummary,
  toolTone,
  transcriptPartVisible,
  type ActivityItem,
  type AssistantPart,
  type FileChangeView,
  type MessageAttachment,
  type PendingRequestView,
  type RemoteMessageView,
  type ShellOutputFetch,
  type ShellOutputView,
  type ToolContentBlock,
} from "../projection"
import { capturedChangesVisible, shellOutputPaging } from "../view-model"
import { FormRequest } from "./form-request"
import { Markdown } from "./markdown"
import { DotTrail } from "./dot-trail"
import { FileChangeCard } from "./file-change-card"
import { ImagePreview, UserImage } from "./image"
import { LoadingPlaceholder } from "./loading"
import "./transcript.css"

type ToolPartView = Extract<AssistantPart, { kind: "tool" }>
type AssistantMessageView = Extract<RemoteMessageView, { kind: "assistant" }>

function SyntheticNotice(props: { readonly notice: NonNullable<ReturnType<typeof classifySyntheticNotice>> }): JSX.Element {
  const notice = props.notice
  if (notice.kind === "goal") return <div class="transcript-notice transcript-notice--goal"><strong>Goal · steer</strong><p>{notice.text}</p></div>
  if (notice.kind === "completion") return <p class={`transcript-notice transcript-notice--${notice.status}`}><strong>{notice.label} {notice.status}</strong><Show when={notice.description}> · {notice.description}</Show></p>
  const heading = <><span class="transcript-notice__mark" aria-hidden="true">◦</span><strong>Subagent · {notice.label}</strong><span class="transcript-notice__status">{notice.status}</span></>
  return <Show when={notice.excerpt} fallback={<p class={`transcript-notice transcript-notice--${notice.status}`}>{heading}</p>}>
    {(excerpt) => <details class={`transcript-notice transcript-notice--${notice.status}`}><summary aria-label={`Subagent ${notice.label} ${notice.status}`}>{heading}<Icon name="chevron-right" size={16} /></summary><p class="transcript-notice__excerpt">{excerpt()}</p></details>}
  </Show>
}

/**
 * A part's identity inside one message. A tool call keeps the call ID the device
 * published; text and reasoning keep their ordinal. A projection update replaces the
 * part object, so the key is what lets the row survive that update with its state.
 */
export function partKey(part: AssistantPart): string {
  return part.kind === "tool" ? `tool:${part.callID}` : `${part.kind}:${part.ordinal}`
}

export function attachmentKey(attachment: MessageAttachment, index: number): string {
  return `${index}:${attachment.mime}:${attachment.digest}`
}

export function toolContentKey(block: ToolContentBlock, index: number): string {
  return `${block.kind}:${index}`
}

export function toolPartExpanded(input: {
  readonly touched: boolean
  readonly manual: boolean
  readonly status: ToolPartView["status"]
}): boolean {
  if (input.touched) return input.manual
  return false
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
    return current.kind === "idle" || current.kind === "loading" ? undefined : current.label
  }
  return (
    <div class="transcript-shell-output">
      <Show when={props.output !== undefined}>
        <BoundedText text={props.output?.text ?? ""} />
      </Show>
      <Show when={props.fetch?.state === "loading"}><LoadingPlaceholder kind={props.output === undefined ? "output" : "history"} label={props.output === undefined ? "Loading output…" : "Loading more output…"} /></Show>
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
  const [rendered, setRendered] = createSignal(false)
  const [closing, setClosing] = createSignal(false)
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(closeTimer))
  const output = createMemo(() => {
    let remaining = 4_000
    const content = props.part().content.flatMap((block): readonly ToolContentBlock[] => {
      if (block.kind !== "text") return [block]
      if (remaining === 0) return []
      const visible = block.text.slice(0, remaining)
      remaining -= visible.length
      return [{ ...block, text: visible }]
    })
    return {
      content,
      clientTruncated: props.part().content.reduce((length, block) => length + (block.kind === "text" ? block.text.length : 0), 0) > 4_000,
      sourceTruncated: props.part().structured?.truncated === true ||
        props.part().content.some((block) => block.kind === "text" && block.sourceTruncated === true),
    }
  })
  const expanded = () => toolPartExpanded({ touched: touched(), manual: manual(), status: props.part().status })
  const shellID = () => toolShellID(props.part())
  const statusLabel = () => {
    if (props.part().name.toLowerCase() === "subagent" && props.part().structured?.status === "running") return "Background"
    if (props.part().status === "streaming") return "Preparing input"
    if (props.part().status === "running") return "Running"
    if (props.part().status === "completed") return "Completed"
    return "Failed"
  }
  const duration = () => props.part().completed === undefined ? undefined : formatPartDuration(props.part().completed! - (props.part().ran ?? props.part().started ?? props.part().completed!))
  return (
    <article class={`transcript-tool transcript-tool--${toolTone(props.part())}`}>
      <header class="transcript-tool__header">
        <button
          type="button"
          class="transcript-tool__toggle"
          aria-expanded={expanded()}
          onClick={() => {
            const next = !expanded()
            setManual(next)
            setTouched(true)
            clearTimeout(closeTimer)
            if (next) {
              setRendered(true)
              setClosing(false)
              return
            }
            if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
              setRendered(false)
              return
            }
            setClosing(true)
            closeTimer = setTimeout(() => setRendered(false), 220)
          }}
        >
          <span class="transcript-tool__tag" aria-label={toolTone(props.part()) === "success" ? "Completed" : toolTone(props.part()) === "error" ? "Failed" : toolTone(props.part()) === "attention" ? "Needs attention" : "Running"}>{toolTone(props.part()) === "success" ? "✓" : toolTone(props.part()) === "attention" ? "Ⅱ" : toolTone(props.part()) === "error" ? "!" : <DotTrail />}</span>
          <span class="transcript-tool__name" title={toolSummary(props.part())}>{toolSummary(props.part())}</span>
          <span class="transcript-tool__status">{statusLabel()}{duration() ? ` · ${duration()}` : ""}</span>
          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={16} />
        </button>
      </header>
      <Show when={rendered()}>
        <div class="transcript-tool__body" classList={{ "transcript-tool__body--closing": closing() }} aria-hidden={closing()} inert={closing()}>
        <Show when={props.part().input !== undefined || props.part().inputText !== undefined}>
          <pre class="output" tabindex="0">
            <code>{props.part().inputText ?? JSON.stringify(props.part().input, null, 2)}</code>
          </pre>
        </Show>
        <For each={output().content.map(toolContentKey)}>
          {(key) => {
            const block = () => output().content[Number(key.slice(key.lastIndexOf(":") + 1))]!
            const text = () => { const current = block(); return current.kind === "text" ? current.text : "" }
            const image = () => { const current = block(); return current.kind === "image" ? current : undefined }
            const other = () => { const current = block(); return current.kind === "other" ? current : undefined }
            return key.startsWith("text:") ? (
              <pre class="output" tabindex="0">
                <code>{text()}</code>
              </pre>
            ) : key.startsWith("image:") ? (
              <ImagePreview src={image()?.uri ?? ""} name={image()?.name ?? "Image"} />
            ) : (
              <p class="transcript-tool__note">
                {other()?.type} content: {other()?.summary}
              </p>
            )
          }}
        </For>
        <Show when={output().clientTruncated}>
          <p class="transcript-tool__note">Showing the first 4,000 characters of available tool output in this browser.</p>
        </Show>
        <Show when={output().sourceTruncated}>
          <p class="transcript-tool__note">Tool output was truncated on the device.</p>
        </Show>
        <Show when={shellID()}>
          {(id) => <ShellOutputSection shellID={id()} output={props.part().shellOutput} fetch={props.part().shellOutputFetch} />}
        </Show>
        </div>
      </Show>
      <Show when={props.part().error}><p class="transcript-tool__error" role="status"><span aria-hidden="true">↳ </span>{props.part().error}</p></Show>
    </article>
  )
}

/**
 * One assistant message's parts. The keys come from the parts the projection currently
 * holds, so a part that is replaced keeps its row — and with it an open tool body, an
 * open reasoning block, and the focus of the control that was used to open it.
 */
function AssistantParts(props: { readonly parts: () => readonly AssistantPart[] }): JSX.Element {
  const groups = createMemo(() => props.parts().reduce<{ readonly key: string; readonly parts: readonly AssistantPart[] }[]>((result, part) => {
    if (!transcriptPartVisible(part)) return result
    const previous = result.at(-1)
    if (part.kind === "reasoning" && previous?.parts[0]?.kind === "reasoning") {
      result[result.length - 1] = { ...previous, parts: [...previous.parts, part] }
      return result
    }
    result.push({ key: partKey(part), parts: [part] })
    return result
  }, []))
  const keys = createMemo(() => groups().map((group) => group.key))
  const group = (key: string) => groups().find((entry) => entry.key === key)!
  return (
    <For each={keys()}>
      {(key) => <PartView parts={() => group(key).parts} />}
    </For>
  )
}

function PartView(props: { readonly parts: () => readonly AssistantPart[] }): JSX.Element {
  const part = () => props.parts()[0]!
  const reasoning = () => props.parts().map((item) => partText(item)).join("\n\n")
  const kind = () => part().kind
  return (
    <>
      <Show when={kind() === "text"}>
        <div class="transcript-message__text"><Markdown text={partText(part())} /></div>
      </Show>
      <Show when={kind() === "reasoning"}>
        <ReasoningPart text={reasoning} parts={props.parts} />
      </Show>
      <Show when={kind() === "tool"}>
        <ToolPart part={() => toolOf(part())!} />
      </Show>
    </>
  )
}

function ReasoningPart(props: { readonly text: () => string; readonly parts: () => readonly AssistantPart[] }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [rendered, setRendered] = createSignal(false)
  const [closing, setClosing] = createSignal(false)
  let details: HTMLDetailsElement | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(closeTimer))
  const toggle = (event: MouseEvent) => {
    event.preventDefault()
    clearTimeout(closeTimer)
    if (!open()) {
      if (details) details.open = true
      setRendered(true)
      setClosing(false)
      setOpen(true)
      return
    }
    setOpen(false)
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (details) details.open = false
      setRendered(false)
      return
    }
    setClosing(true)
    closeTimer = setTimeout(() => {
      if (details) details.open = false
      setRendered(false)
    }, 220)
  }
  const duration = () => {
    const items = props.parts().filter((item) => item.kind === "reasoning")
    const first = items[0]
    const last = items.findLast((item) => item.text.trim())
    return first?.started !== undefined && last?.completed !== undefined ? ` · ${formatPartDuration(last.completed - first.started)}` : ""
  }
  return (
    <details class="transcript-reasoning" ref={details}>
      <summary aria-expanded={open()} onClick={toggle}><span class="transcript-reasoning__tag" aria-label={duration() ? "Completed" : "Thinking"}>{duration() ? "✓" : <DotTrail />}</span><span>Thought{duration()}</span><span class="transcript-reasoning__hint">{open() ? "Hide" : "Show"} details</span></summary>
      <Show when={rendered()}>
        <div class="transcript-reasoning__body" classList={{ "transcript-reasoning__body--closing": closing() }} aria-hidden={closing()} inert={closing()}><Markdown text={props.text()} /></div>
      </Show>
    </details>
  )
}

export function MessageRow(props: { readonly message: () => RemoteMessageView }): JSX.Element {
  const kind = () => props.message().kind
  const remote = useRemote()
  const fileChanges = () => remote.state().view?.capturedChanges?.data ?? []
  const selectedView = () => remote.state().view
  const showFileChanges = () => remote.state().activeSessionID === selectedView()?.id && capturedChangesVisible(selectedView()?.status) &&
    selectedView()?.capturedChanges?.placementMessageID === props.message().id && fileChanges().length > 0 &&
    (remote.state().view?.capturedChanges?.mode === "transcript" && kind() === "assistant" || remote.state().view?.capturedChanges?.mode === "recovery" && kind() === "compaction")
  const catalog = () => remote.state().catalogs[catalogKey({ sessionID: remote.state().activeSessionID ?? "" })]
  const models = () => catalog()?.models ?? []
  const agent = () => {
    const id = assistantOf(props.message())?.agent
    if (!id) return "YCoding"
    return catalog()?.agents.find((option) => option.id === id)?.name ?? id.replace(/\b\w/g, (letter) => letter.toUpperCase())
  }
  const observation = () => {
    const message = props.message()
    return message.kind === "synthetic" || message.kind === "system" ? noticeSummary(message.source, message.text) : undefined
  }
  const syntheticNotice = () => classifySyntheticNotice(props.message())
  const attachments = () => { const message = props.message(); return message.kind === "user" ? message.attachments ?? [] : [] }
  const attachmentKeys = () => attachments().map(attachmentKey)
  const oversized = () => { const message = props.message(); return message.kind === "oversized" ? message : undefined }
  const fallbackText = () => {
    const message = props.message()
    return message.kind === "synthetic" && message.description ? message.description : systemText(message)
  }
  return (
    <Show when={kind() !== "notice"} fallback={<p class="notice">{noticeText(props.message())}</p>}>
      <article class={`transcript-message transcript-message--${kind()}`}>
        <Show when={kind() === "oversized"}>
          <p class="transcript-message__unavailable" role="status">{oversized()?.state === "error" ? "Content too large or unavailable" : oversized()?.state === "pending" ? "Waiting for content" : "Loading content"}</p>
          <Show when={oversized()?.state === "error"}><button type="button" class="button button--ghost button--small" onClick={() => void remote.store.loadOversizedMessage(props.message().id)}>Retry full content</button></Show>
        </Show>
        <Show when={kind() === "user"}>
          <Show when={userText(props.message()).trim() !== ""}><p class="transcript-message__bubble">{userText(props.message())}</p></Show>
          <For each={attachmentKeys()}>{(key) => {
            const attachment = () => attachments()[Number(key.slice(0, key.indexOf(":")))]!
            const size = () => attachment().bytes < 1_024 ? `${attachment().bytes} B` : `${(attachment().bytes / 1_024).toFixed(1)} KB`
            return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment().mime)
              ? <UserImage name={attachment().name} mime={attachment().mime} digest={attachment().digest} deviceID={remote.state().activeDeviceID ?? ""} sessionID={remote.state().activeSessionID ?? ""} />
              : <span class="transcript-file">{attachment().name} · {size()}</span>
          }}</For>
          <span class="transcript-message__receipt" aria-label={userState(props.message()) === "consumed" ? "Read by YCoding" : userState(props.message()) === "pending" ? "Pending delivery" : "Sent, not yet read"}>
            <Show when={userState(props.message()) === "consumed"} fallback={<Show when={userState(props.message()) === "pending"} fallback={<Icon name="check" size={14} />}><span aria-hidden="true">◷</span></Show>}><span aria-hidden="true">✓✓</span></Show>
            {userState(props.message()) === "consumed" ? "Read" : userState(props.message()) === "pending" ? "Pending" : "Sent"}
            <Show when={userDelivery(props.message()) === "queue"}><span>· queued</span></Show>
          </span>
        </Show>

        <Show when={kind() === "assistant"}>
          <h3 class="transcript-message__agent">{agent()}</h3>
          <AssistantParts parts={() => assistantOf(props.message())?.parts ?? []} />
          <Show when={assistantOf(props.message())?.error}><p class="transcript-message__error" role="status">{assistantOf(props.message())?.error}</p></Show>
          <footer class="transcript-message__footer">{agent()}<Show when={assistantOf(props.message())?.model}>{(model) => <> · {modelDisplayLabel(model(), models())}<Show when={model().variant}> · {model().variant}</Show></>}</Show><Show when={assistantOf(props.message())?.completed}>{(end) => <> · {formatPartDuration(end() - (assistantOf(props.message())?.created ?? end()))}</>}</Show></footer>
        </Show>

        <Show when={kind() === "system" || kind() === "synthetic"}>
          <Show when={syntheticNotice()} fallback={<Show when={observation()} fallback={<p class="transcript-message__system">{fallbackText()}</p>}>{(summary) => <details class="transcript-message__observation"><summary>{summary()}</summary><pre tabindex="0">{systemText(props.message())}</pre></details>}</Show>}>
            {(notice) => <SyntheticNotice notice={notice()} />}
          </Show>
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
          <CompactionDivider message={props.message} />
        </Show>
        <Show when={(kind() === "assistant" || kind() === "compaction") && showFileChanges()}>
          <FileChangeCard files={fileChanges} />
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
          <Show when={isHardReview(props.request())}>
            <span class="request__badge">Human only</span>
          </Show>
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

      <Show when={formOf(props.request())}>
        {form => <FormRequest form={form} activeSessionID={props.activeSessionID} />}
      </Show>
    </article>
  )
}

export function ActivityRow(props: { readonly item: () => ActivityItem; readonly fileChange: () => FileChangeView | undefined }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  return (
    <li class={`activity-row activity-row--${props.item().kind}`}>
      <span class="activity-row__icon" aria-hidden="true">
        <Icon
          name={
            props.item().kind === "terminal"
              ? "terminal"
              : props.item().kind === "file"
                ? "file"
                : props.item().kind === "approval"
                  ? "shield"
                  : props.item().kind === "status"
                    ? "activity"
                    : "settings"
          }
          size={16}
        />
      </span>
      <span class="activity-row__body">
        <span class="activity-row__title">{props.item().title}</span>
        <Show when={props.item().detail}>
          <span class="activity-row__detail">{props.item().detail}</span>
        </Show>
        <Show when={props.fileChange()}>
          <button type="button" class="button button--ghost button--small activity-row__view" aria-expanded={expanded()} aria-label={`${expanded() ? "Hide" : "View"} diff for ${props.fileChange()?.path}`} onClick={() => setExpanded(!expanded())}>
            {expanded() ? "Hide diff" : "View diff"}
          </button>
        </Show>
      </span>
      <span class="activity-row__status">{props.item().status}</span>
      <Show when={expanded() && props.fileChange()}>
        {(change) => <pre class="output activity-row__patch" tabindex="0"><code>{change().patch || "No patch recorded."}</code></pre>}
      </Show>
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
function compactTokenCount(tokens: number) {
  return tokens < 1_000 ? new Intl.NumberFormat().format(tokens) : `${Math.round(tokens / 1_000)}k`
}

function CompactionDivider(props: { readonly message: () => RemoteMessageView }): JSX.Element {
  const remote = useRemote()
  const current = () => { const message = props.message(); return message.kind === "compaction" ? message : undefined }
  const history = () => remote.state().view?.compactionHistory
  const entry = () => history()?.data.find((item) => item.jobID === current()?.jobID)
  const metrics = () => current()?.metrics ?? entry()?.metrics
  const saved = () => metrics() ? metrics()!.inputTokens - metrics()!.retainedTokens : 0
  const reduction = () => metrics()?.inputTokens ? Math.round(saved() / metrics()!.inputTokens * 100) : 0
  const ordinal = () => {
    const found = history()?.data.findIndex((item) => item.jobID === current()?.jobID) ?? -1
    if (found < 0) return undefined
    return history()!.completedBefore + history()!.data.slice(0, found + 1).filter((item) => item.status === "completed" && item.metrics !== undefined).length
  }
  const trigger = () => current()?.trigger ?? entry()?.trigger
  const timestamp = () => {
    const date = new Date(current()?.created ?? entry()?.created ?? 0)
    const now = new Date()
    const time = date.toLocaleTimeString(undefined, { timeStyle: "short" })
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
      ? time : `${time} · ${date.toLocaleDateString()}`
  }
  const label = () => {
    const message = current()
    if (!message) return ""
    if (message.status === "pending") return "~ compaction pending"
    if (message.status === "running") return `~ compacting${trigger() ? ` · ${trigger()}` : ""}`
    if (message.status === "completed") return metrics()
      ? `~ compacted · ${metrics()!.excludedMessages} items excluded · ${compactTokenCount(metrics()!.inputTokens)} → ${compactTokenCount(metrics()!.retainedTokens)} tokens`
      : "~ compacted"
    if (message.failureCode === "cancelled") return "~ compaction cancelled"
    if (message.failureCode === "superseded") return "~ compaction superseded"
    return ""
  }
  const completed = () => current()?.status === "completed" && metrics() !== undefined
  return <div class={`transcript-compaction${completed() ? " transcript-compaction--completed" : ""}`}>
    <div class="transcript-compaction__heading"><span class="transcript-compaction__rule" /><strong class="transcript-compaction__label">{label()}</strong><span class="transcript-compaction__rule" /></div>
    <div class="transcript-compaction__details" aria-hidden={!completed()}>
      <p class="transcript-compaction__total">{completed() && history() ? `~${compactTokenCount(history()!.totalSavedTokens)} tokens saved total` : ""}</p>
      <div class="transcript-compaction__bar" role="img" aria-label={completed() ? `${reduction()}% of input tokens removed` : undefined}>
        <span class="transcript-compaction__removed" style={{ width: `${Math.max(0, Math.min(100, reduction()))}%` }} />
        <span class="transcript-compaction__retained" />
      </div>
      <p class="transcript-compaction__number">{completed() ? `${ordinal() === undefined ? "" : `Compression #${ordinal()} (`}~${compactTokenCount(saved())} tokens removed, ${reduction()}% reduction${ordinal() === undefined ? "" : ")"}` : ""}</p>
      <p class="transcript-compaction__items">{completed() ? `Items: ${metrics()!.excludedMessages} messages compressed · ${timestamp()}` : ""}</p>
    </div>
  </div>
}
const permissionAction = (request: PendingRequestView) => (request.kind === "permission" ? request.action : "")
const guardrailAction = (request: PendingRequestView) => (request.kind === "guardrail" ? request.action : "")
const guardrailReason = (request: PendingRequestView) => (request.kind === "guardrail" ? request.reason : "")
const isHardReview = (request: PendingRequestView) => request.kind === "guardrail" && request.hardReview
const resourceList = (request: PendingRequestView) => (request.kind === "permission" ? request.resources : [])
const formOf = (request: PendingRequestView) => (request.kind === "form" ? request.form : undefined)
const partText = (part: AssistantPart) => (part.kind === "text" || part.kind === "reasoning" ? part.text : "")
const toolOf = (part: AssistantPart): ToolPartView | undefined => (part.kind === "tool" ? part : undefined)
