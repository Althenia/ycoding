import { createComputed, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "../../ui/icon"
import { interactionControlVisible, interactionViewLabel, resumableGeneration, stoppableGeneration, type InteractionPlatform, type InteractionView } from "../interaction-control"
import "./interaction-control.css"

type Frame = NonNullable<InteractionView["frame"]>
type DocumentPiP = { requestWindow(options: { disallowReturnToOpener: boolean }): Promise<Window> }

function createDetachedPreview(window: Window, style: CSSStyleDeclaration, onClose: () => void) {
  const document = window.document
  const policy = document.createElement("meta")
  policy.httpEquiv = "Content-Security-Policy"
  policy.content = "default-src 'none'; img-src blob:; form-action 'none'; base-uri 'none'"
  document.head.append(policy)
  document.title = "Interaction preview"
  document.documentElement.lang = "en"
  Object.assign(document.body.style, {
    display: "grid", placeItems: "center", margin: "0", blockSize: "100vh", overflow: "hidden",
    backgroundColor: style.backgroundColor, color: style.color, fontSize: style.fontSize, fontFamily: "system-ui",
  })
  let release: (() => void) | undefined
  window.addEventListener("pagehide", onClose, { once: true })
  return {
    render(frame: Frame) {
      release?.()
      const image = document.createElement("img")
      image.alt = "Current authorized frame"
      image.draggable = false
      Object.assign(image.style, { display: "block", maxInlineSize: "100vw", maxBlockSize: "100vh", objectFit: "contain" })
      image.oncontextmenu = (event) => event.preventDefault()
      const source = URL.createObjectURL(new Blob([frame.bytes], { type: frame.mimeType }))
      release = () => {
        image.onerror = null
        image.removeAttribute("src")
        image.remove()
        URL.revokeObjectURL(source)
      }
      image.onerror = () => {
        release?.()
        release = undefined
        const notice = document.createElement("p")
        notice.setAttribute("role", "status")
        notice.textContent = "Preview withheld"
        document.body.replaceChildren(notice)
      }
      image.src = source
      document.body.replaceChildren(image)
    },
    close() {
      window.removeEventListener("pagehide", onClose)
      release?.()
      release = undefined
      document.body.replaceChildren()
      window.close()
    },
  }
}

function interactionPictureInPicture(view: () => InteractionView) {
  type OpenPreview = { readonly generation: string; frame?: Frame; surface?: ReturnType<typeof createDetachedPreview> }
  const api = typeof window === "object" ? (window as Window & { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture : undefined
  const supported = typeof api?.requestWindow === "function"
  const [phase, setPhase] = createSignal<"idle" | "opening" | "open" | "denied">("idle")
  const grant = () => {
    const { status, revealed, busy } = view()
    return revealed && !busy && typeof status !== "string" && status.state === "active" ? status.generation : undefined
  }
  const frame = () => grant() ? view().frame : undefined
  let owner: OpenPreview | undefined

  const close = () => {
    const current = owner
    owner = undefined
    if (!current) return
    current.frame = undefined
    if (current.surface) {
      current.surface.close()
      setPhase("idle")
    }
  }

  if (supported) {
    createComputed(() => {
      const generation = grant()
      const next = frame()
      const current = owner
      if (!next) {
        close()
        setPhase((phase) => phase === "denied" ? "idle" : phase)
      } else if (current && (generation !== current.generation || (!current.surface && current.frame !== next))) {
        close()
      } else if (current?.surface && current.frame !== next) {
        current.frame = next
        current.surface.render(next)
      }
    })
    window.addEventListener("pagehide", close)
    onCleanup(() => {
      window.removeEventListener("pagehide", close)
      close()
    })
  }

  const open = async (button: HTMLButtonElement) => {
    const generation = grant()
    const initial = frame()
    if (!api || !generation || !initial || phase() === "opening" || owner) return
    const current: OpenPreview = { generation, frame: initial }
    owner = current
    setPhase("opening")
    let pip: Window | undefined
    try {
      pip = await api.requestWindow({ disallowReturnToOpener: true })
      const next = frame()
      if (pip.closed || owner !== current || grant() !== generation || !next || next !== current.frame) {
        close()
        pip.close()
        setPhase("idle")
        return
      }
      current.surface = createDetachedPreview(pip, getComputedStyle(button), close)
      current.surface.render(next)
      setPhase("open")
    } catch {
      const denied = owner === current
      close()
      pip?.close()
      setPhase(denied ? "denied" : "idle")
    }
  }

  return { supported, phase, disabled: () => !frame() || phase() === "opening" || phase() === "open", open }
}

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
  const pip = interactionPictureInPicture(() => props.view)
  return <Show when={interactionControlVisible(props.view)}><section class="interaction-control" aria-label="Interaction control">
    <div class="interaction-control__bar">
      <span class="interaction-control__label" role="status" data-state={state()}>
        <Icon name="monitor" size={16} />
        <span>{props.view.busy === "request" && !generation() ? "Requesting platform approval…" : interactionViewLabel(props.view.status)}</span>
      </span>
      <Show when={state() === "active"}>
        <button type="button" class="interaction-control__button" aria-label={props.view.revealed ? "Hide interaction preview" : "Show interaction preview"} aria-expanded={props.view.revealed} aria-disabled={!!props.view.busy} onClick={() => { if (!props.view.busy) props.onReveal(!props.view.revealed) }}>{props.view.revealed ? "Hide preview" : "Show preview"}<Icon name={props.view.revealed ? "chevron-up" : "chevron-down"} size={14} /></button>
        <Show when={pip.supported}>
          <button type="button" class="interaction-control__button" aria-label={pip.phase() === "denied" ? "Picture-in-picture unavailable" : "Open picture-in-picture"} disabled={pip.disabled()} onClick={(event) => void pip.open(event.currentTarget)}>
            <span class="interaction-control__pip-label" data-denied={pip.phase() === "denied"}>
              <span>Picture-in-picture</span><span>Unavailable</span>
            </span><Icon name="external" size={14} />
          </button>
          <span class="visually-hidden" role="status">{pip.phase() === "denied" ? "Picture-in-picture unavailable" : ""}</span>
        </Show>
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
          const release = () => URL.revokeObjectURL(source)
          onCleanup(release)
          return <Show when={!failed()} fallback={<p role="status">Preview withheld</p>}>
            <img src={source} width={frame.width} height={frame.height} alt="Current authorized target" draggable={false} onError={() => { release(); setFailed(true) }} onContextMenu={(event) => event.preventDefault()} />
          </Show>
        }}
      </Show>
    </div>
  </figure>
}
