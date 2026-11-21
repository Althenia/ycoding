import { createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "../../ui/icon"
import { interactionControlVisible, interactionViewLabel, resumableGeneration, stoppableGeneration, type InteractionPlatform, type InteractionView } from "../interaction-control"
import "./interaction-control.css"

export function InteractionControl(props: {
  readonly view: InteractionView
  readonly inlinePreview: boolean
  readonly onReveal: (revealed: boolean) => void
  readonly onStop: (generation: string) => void
  readonly onResume?: (generation: string) => void
  readonly onRefresh: () => void
  readonly onRequest?: (platform: InteractionPlatform) => void
}) {
  const state = () => typeof props.view.status === "string" ? props.view.status : props.view.status.state
  const generation = () => stoppableGeneration(props.view.status)
  const resumeGeneration = () => resumableGeneration(props.view.status)
  return <Show when={interactionControlVisible(props.view)}><section class="interaction-control" aria-label="Interaction control">
    <div class="interaction-control__bar">
      <span class="interaction-control__label" role="status" data-state={state()}>
        <Icon name="monitor" size={16} />
        <span>{props.view.busy === "request" && !generation() ? "Requesting platform approval…" : interactionViewLabel(props.view.status)}</span>
      </span>
      <Show when={state() === "active"}>
        <button type="button" class="interaction-control__button" aria-label={props.view.revealed ? "Hide interaction preview" : "Show interaction preview"} aria-expanded={props.view.revealed} aria-disabled={!!props.view.busy} onClick={() => { if (!props.view.busy) props.onReveal(!props.view.revealed) }}>{props.view.revealed ? "Hide preview" : "Show preview"}<Icon name={props.view.revealed ? "chevron-up" : "chevron-down"} size={14} /></button>
      </Show>
      <Show when={resumeGeneration()} keyed>{(current) =>
        <button type="button" class="interaction-control__button interaction-control__resume" aria-label="Resume interaction" aria-disabled={props.view.busy === "resume" || props.view.busy === "stop"} onClick={() => { if (!props.view.busy) props.onResume?.(current) }}>{props.view.busy === "resume" ? "Resuming…" : "Resume"}</button>
      }</Show>
      <Show when={generation()} keyed>{(current) =>
        <button type="button" class="interaction-control__button interaction-control__stop" aria-label="Stop interaction" aria-disabled={props.view.busy === "stop"} onClick={() => props.onStop(current)}><Icon name="stop" size={14} /> {props.view.busy === "stop" ? "Stopping…" : "Stop"}</button>
      }</Show>
      <Show when={props.onRequest && (state() === "unavailable" || state() === "stopped") && props.view.busy === undefined}>
        <button type="button" class="interaction-control__button" onClick={() => props.onRequest?.("chrome")}>Request Chrome control</button>
        <button type="button" class="interaction-control__button" onClick={() => props.onRequest?.("macos")}>Request macOS control</button>
      </Show>
      <Show when={state() === "error"}><button type="button" class="interaction-control__button" onClick={props.onRefresh}>Refresh interaction status</button></Show>
    </div>
    <Show when={props.view.notice}>{(notice) => <p class="interaction-control__notice" role="status">{notice()}</p>}</Show>
    <Show when={props.inlinePreview && props.view.revealed && state() === "active"}><InteractionPreview view={props.view} /></Show>
  </section></Show>
}

export function InteractionPreview(props: { readonly view: InteractionView }) {
  return <figure class="interaction-preview" aria-label="Interaction preview">
    <figcaption>Interaction preview</figcaption>
    <div class="interaction-preview__frame">
      <Show when={props.view.frame} keyed fallback={<p role="status">{props.view.readingFrame ? "Reading preview…" : "Preview withheld"}</p>}>
        {(frame) => {
          const [failed, setFailed] = createSignal(false)
          const source = URL.createObjectURL(new Blob([frame.bytes], { type: frame.mimeType }))
          onCleanup(() => URL.revokeObjectURL(source))
          return <Show when={!failed()} fallback={<p role="status">Preview withheld</p>}>
            <img src={source} width={frame.width} height={frame.height} alt="Current authorized target" draggable={false} onError={() => setFailed(true)} onContextMenu={(event) => event.preventDefault()} />
          </Show>
        }}
      </Show>
    </div>
  </figure>
}
