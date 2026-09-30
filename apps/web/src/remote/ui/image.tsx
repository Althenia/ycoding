import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import { LoadingPlaceholder } from "./loading"
import "./image.css"

export function ImagePreview(props: { readonly src: string; readonly name: string }) {
  const [failed, setFailed] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const source = createMemo(() => props.src)
  createEffect(() => { source(); setFailed(false) })
  return <>
    <Show when={!failed()} fallback={<div class="transcript-image__unavailable" role="status">Image unavailable <button type="button" onClick={() => setFailed(false)}>Retry {props.name}</button></div>}>
      <button type="button" class="transcript-image" data-cursor="zoom-in" aria-label={`Open image ${props.name}`} onClick={() => setOpen(true)}>
        <img src={props.src} alt={props.name} loading="lazy" onError={() => setFailed(true)} />
      </button>
    </Show>
    <Show when={open()}><ImageLightbox src={props.src} name={props.name} onClose={() => setOpen(false)} /></Show>
  </>
}

function ImageLightbox(props: { readonly src: string; readonly name: string; readonly onClose: () => void }) {
  let dialog: HTMLDialogElement | undefined
  let closeButton: HTMLButtonElement | undefined
  onMount(() => dialog?.showModal())
  onCleanup(() => { if (dialog?.open) dialog.close() })
  return <dialog ref={dialog} class="overlay overlay--dialog transcript-lightbox" data-cursor="action" aria-label={`Image: ${props.name}`} onCancel={props.onClose} onClose={props.onClose} onClick={(event) => { if (event.target === event.currentTarget) props.onClose() }} onKeyDown={(event) => { if (event.key === "Tab") { event.preventDefault(); closeButton?.focus() } }}>
    <div class="overlay__surface" data-cursor="surface">
      <div class="overlay__head"><span class="overlay__title">Image: {props.name}</span><button ref={closeButton} type="button" class="button button--ghost button--icon overlay__close" aria-label="Close image" onClick={props.onClose}><Icon name="close" /></button></div>
      <div class="overlay__body"><img src={props.src} alt={props.name} /></div>
    </div>
  </dialog>
}

export function UserImage(props: { readonly deviceID: string; readonly sessionID: string; readonly digest: string; readonly mime: string; readonly name: string }) {
  const remote = useRemote()
  const input = createMemo(() => ({ deviceID: props.deviceID, sessionID: props.sessionID, digest: props.digest, mime: props.mime }), undefined, {
    equals: (previous, next) => previous?.deviceID === next.deviceID && previous.sessionID === next.sessionID && previous.digest === next.digest && previous.mime === next.mime,
  })
  const [source, setSource] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  const [retry, setRetry] = createSignal(0)
  const [visible, setVisible] = createSignal(false)
  let container: HTMLDivElement | undefined
  onMount(() => {
    if (!container) return
    if (!("IntersectionObserver" in window)) { setVisible(true); return }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    }, { root: container.closest(".workspace__scroll"), rootMargin: "200px" })
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    if (!visible()) return
    retry()
    const image = input()
    let active = true
    setFailed(false)
    setSource(undefined)
    void remote.store.loadImageSource(image)
      .then((src) => { if (active) setSource(src) }, () => { if (active) setFailed(true) })
    onCleanup(() => { active = false })
  })
  return <div class="transcript-attachment" ref={container}><Show when={source()} fallback={failed()
    ? <div class="transcript-image__unavailable" role="status">Image unavailable <button type="button" onClick={() => setRetry(retry() + 1)}>Retry {props.name}</button></div>
    : <LoadingPlaceholder kind="image" label={`Loading image ${props.name}`} />}>
    {(src) => <ImagePreview src={src()} name={props.name} />}
  </Show></div>
}
