import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Icon } from "../../ui/icon"
import "./image.css"

export function ImagePreview(props: { readonly src: string; readonly name: string }) {
  const [failed, setFailed] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  return <>
    <Show when={!failed()} fallback={<div class="transcript-image__unavailable" role="status">Image unavailable <button type="button" onClick={() => setFailed(false)}>Retry {props.name}</button></div>}>
      <button type="button" class="transcript-image" aria-label={`Open image ${props.name}`} onClick={() => setOpen(true)}>
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
  return <dialog ref={dialog} class="overlay overlay--dialog transcript-lightbox" aria-label={`Image: ${props.name}`} onCancel={props.onClose} onClose={props.onClose} onClick={(event) => { if (event.target === event.currentTarget) props.onClose() }} onKeyDown={(event) => { if (event.key === "Tab") { event.preventDefault(); closeButton?.focus() } }}>
    <div class="overlay__surface">
      <div class="overlay__head"><span class="overlay__title">Image: {props.name}</span><button ref={closeButton} type="button" class="button button--ghost button--icon overlay__close" aria-label="Close image" onClick={props.onClose}><Icon name="close" /></button></div>
      <div class="overlay__body"><img src={props.src} alt={props.name} /></div>
    </div>
  </dialog>
}

export function UserImage(props: { readonly deviceID: string; readonly sessionID: string; readonly digest: string; readonly mime: string; readonly name: string }) {
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
    const controller = new AbortController()
    setFailed(false)
    setSource(undefined)
    void fetch(`/api/remote/devices/${encodeURIComponent(props.deviceID)}/sessions/${encodeURIComponent(props.sessionID)}/attachments/${props.digest}`,
      { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Attachment unavailable")
      const payload: unknown = await response.json()
      if (typeof payload !== "object" || payload === null || !("mime" in payload) || !("data" in payload) || !("bytes" in payload) ||
        payload.mime !== props.mime || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(props.mime) ||
        typeof payload.bytes !== "number" || !Number.isSafeInteger(payload.bytes) || payload.bytes < 0 || payload.bytes > 10 * 1024 * 1024 ||
        typeof payload.data !== "string" || payload.data.length > 14 * 1024 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)) throw new Error("Invalid attachment")
      if (!controller.signal.aborted) setSource(`data:${props.mime};base64,${payload.data}`)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    onCleanup(() => controller.abort())
  })
  return <div class="transcript-attachment" ref={container}><Show when={source()} fallback={failed()
    ? <div class="transcript-image__unavailable" role="status">Image unavailable <button type="button" onClick={() => setRetry(retry() + 1)}>Retry {props.name}</button></div>
    : <span class="transcript-image__loading" role="status">Loading image {props.name}</span>}>
    {(src) => <ImagePreview src={src()} name={props.name} />}
  </Show></div>
}
