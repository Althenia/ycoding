import { For, Show, createMemo, type JSX } from "solid-js"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import type { AssistantPart, RemoteMessageView } from "../projection"
import { userMessageDisplay } from "../view-model"
import type { TeamSubagent } from "./team-model"
import { Markdown } from "./markdown"
import { LoadingPlaceholder } from "./loading"
import { attachmentKey } from "./conversation"
import { ImagePreview, UserImage } from "./image"

function ChildPart(props: { readonly part: () => AssistantPart }): JSX.Element {
  const prose = () => { const part = props.part(); return part.kind === "text" ? part.text : undefined }
  const reasoning = () => { const part = props.part(); return part.kind === "reasoning" ? part.text : undefined }
  const tool = () => { const part = props.part(); return part.kind === "tool" ? part : undefined }
  return <>
    <Show when={prose()}>{(text) => <Markdown text={text()} />}</Show>
    <Show when={reasoning()}>{(text) => <details class="transcript-reasoning"><summary>Reasoning</summary><Markdown text={text()} /></details>}</Show>
    <Show when={tool()}>{(part) => <details class="transcript-tool"><summary>{part().name} · {part().status}</summary>
      <Show when={part().inputText ?? (part().input ? JSON.stringify(part().input, null, 2) : undefined)}>{(text) => <pre tabindex="0">{text()}</pre>}</Show>
      <For each={part().content}>{(block) => block.kind === "image" ? <ImagePreview src={block.uri} name={block.name ?? "Tool image"} /> : <pre tabindex="0">{block.kind === "text" ? block.text : block.summary}</pre>}</For>
      <Show when={part().shellOutput?.text}>{(text) => <pre tabindex="0">{text()}</pre>}</Show>
      <Show when={part().shellOutput?.truncated || part().content.some((block) => block.kind === "text" && block.sourceTruncated)}><p>Output was truncated on the machine.</p></Show>
      <Show when={part().error}>{(text) => <p role="status">{text()}</p>}</Show>
    </details>}</Show>
  </>
}

function ChildMessage(props: { readonly message: () => RemoteMessageView; readonly sessionID: string }): JSX.Element {
  const remote = useRemote()
  const assistant = () => { const message = props.message(); return message.kind === "assistant" ? message : undefined }
  const text = () => { const message = props.message(); return message.kind !== "user" && "text" in message ? message.text : undefined }
  const shell = () => { const message = props.message(); return message.kind === "shell" ? message : undefined }
  const compaction = () => { const message = props.message(); return message.kind === "compaction" ? message : undefined }
  const display = createMemo(() => { const message = props.message(); return userMessageDisplay(message.kind === "user" ? message : { text: "" }) })
  const parts = createMemo(() => new Map((assistant()?.parts ?? []).map((part) => [part.kind === "tool" ? `tool:${part.callID}` : `${part.kind}:${part.ordinal}`, part])))
  return <article class="team-conversation__message" data-kind={props.message().kind}>
    <header>{assistant()?.agent ?? props.message().kind}</header>
    <Show when={assistant()}>{(message) => <><For each={[...parts().keys()]}>{(key) => <ChildPart part={() => parts().get(key)!} />}</For><Show when={message().error}>{(error) => <p role="status">{error()}</p>}</Show></>}</Show>
    <Show when={text()}>{(value) => <Markdown text={value()} />}</Show>
    <Show when={props.message().kind === "user" && (display().text !== "" || display().images.length > 0)}><div class="team-conversation__prompt">
      <Show when={display().text !== ""}><span class="transcript-message__bubble-text">{display().text}</span></Show>
      <Show when={display().images.length > 0}><span class="transcript-message__images" role="group" aria-label={`${display().images.length} attached images`}><For each={display().images.map(attachmentKey)}>{(key) => {
        const image = () => display().images[Number(key.slice(0, key.indexOf(":")))]!
        return <UserImage name={image().name} mime={image().mime} digest={image().digest} deviceID={remote.state().activeDeviceID ?? ""} sessionID={props.sessionID} />
      }}</For></span></Show>
    </div></Show>
    <For each={display().files.map(attachmentKey)}>{(key) => {
      const file = () => display().files[Number(key.slice(0, key.indexOf(":")))]!
      return <span class="transcript-file">{file().name} · {file().bytes} bytes</span>
    }}</For>
    <Show when={shell()}>{(message) => <><code>{message().command} · {message().status}</code><Show when={message().output?.text}>{(value) => <pre tabindex="0">{value()}</pre>}</Show></>}</Show>
    <Show when={compaction()}>{(message) => <><p>Compaction · {message().status}</p><Show when={message().summary ?? message().error}>{(value) => <Markdown text={value()} />}</Show></>}</Show>
    <Show when={props.message().kind === "oversized"}><p>Open the child Session to load this oversized message.</p></Show>
  </article>
}

export function TeamConversation(props: { readonly task: () => TeamSubagent; readonly onOpen: () => void }): JSX.Element {
  const remote = useRemote()
  const connected = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const snapshot = createRemoteQuery(remote.store.queryClient, () => remote.queries.childSnapshot(remote.scope(), connected(), props.task().sessionID, props.task().revision))
  const messages = () => snapshot().data?.messages ?? []
  const byID = createMemo(() => new Map(messages().map((message) => [message.id, message])))
  return <section class="team-conversation" aria-label="Child conversation" aria-busy={snapshot().isFetching}>
    <div class="team-conversation__heading"><h3>Latest conversation</h3><button type="button" class="team-view__button" disabled={!connected() || snapshot().isFetching} onClick={() => void snapshot().refetch()}>Refresh</button></div>
    <Show when={!connected()}><p role="status">Reconnect the machine to refresh this conversation.</p></Show>
    <Show when={snapshot().isError}><p role="alert">{snapshot().error?.message}</p></Show>
    <Show when={snapshot().isPending}><LoadingPlaceholder kind="history" label="Loading child conversation…" /></Show>
    <Show when={snapshot().isSuccess && messages().length === 0}><p role="status">No conversation messages have been reported.</p></Show>
    <For each={messages().map((message) => message.id)}>{(id) => <ChildMessage message={() => byID().get(id)!} sessionID={props.task().sessionID} />}</For>
    <Show when={snapshot().data?.before}><button type="button" class="team-view__button" onClick={props.onOpen}>Open full child history</button></Show>
  </section>
}
