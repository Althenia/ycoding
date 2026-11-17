import { Show, createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

export function Tooltips(): JSX.Element {
  const id = `tooltip-${createUniqueId()}`
  const [target, setTarget] = createSignal<HTMLElement>()
  const [position, setPosition] = createSignal({ left: 0, top: 0 })
  let bubble: HTMLDivElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  let hovered: HTMLElement | undefined
  let focused: HTMLElement | undefined
  let dismissed: HTMLElement | undefined
  const cancel = () => { clearTimeout(timer); timer = undefined }
  const close = () => {
    cancel()
    if (frame !== undefined) { cancelAnimationFrame(frame); frame = undefined }
    const owner = target()
    if (owner) {
      const description = (owner.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(value => value && value !== id).join(" ")
      if (description) owner.setAttribute("aria-describedby", description)
      else owner.removeAttribute("aria-describedby")
    }
    setTarget(undefined)
  }
  const open = (owner: HTMLElement) => {
    cancel()
    if (target() === owner) return
    close()
    const description = owner.getAttribute("aria-describedby")
    owner.setAttribute("aria-describedby", description ? `${description} ${id}` : id)
    setTarget(owner)
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (target() !== owner || !bubble) return
      const anchor = owner.getBoundingClientRect()
      const bounds = bubble.getBoundingClientRect()
      const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--yc-space-2"))
      setPosition({ left: Math.max(inset, Math.min(anchor.left, innerWidth - bounds.width - inset)), top: anchor.bottom + bounds.height + inset <= innerHeight ? anchor.bottom : Math.max(inset, anchor.top - bounds.height) })
    })
  }
  const leave = () => {
    cancel()
    if (target() === document.activeElement) return
    timer = setTimeout(close, 140)
  }
  onMount(() => {
    const enter = (event: Event) => {
      if (!(event.target instanceof Element)) return
      if (bubble?.contains(event.target)) { cancel(); return }
      const owner = event.target.closest<HTMLElement>("[data-tooltip]") ?? undefined
      if (event.type === "pointerover") hovered = owner
      else focused = owner
      if (dismissed && hovered !== dismissed && focused !== dismissed) dismissed = undefined
      if (owner?.dataset.tooltip && owner !== dismissed) open(owner)
      else if (event.type === "focusin") close()
    }
    const out = (event: Event) => {
      const next = event instanceof FocusEvent || event instanceof PointerEvent ? event.relatedTarget : null
      if (next instanceof Node && (target()?.contains(next) || bubble?.contains(next))) return
      const owner = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null
      if (next instanceof Node && owner?.contains(next)) return
      if (event.type === "pointerout") hovered = undefined
      else focused = undefined
      if (dismissed && hovered !== dismissed && focused !== dismissed) dismissed = undefined
      leave()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || target() === undefined) return
      dismissed = target()
      close()
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const dialogClosed = (event: Event) => { if (event.target instanceof HTMLDialogElement && target() && event.target.contains(target()!)) close() }
    document.addEventListener("pointerover", enter)
    document.addEventListener("focusin", enter)
    document.addEventListener("pointerout", out)
    document.addEventListener("focusout", out)
    document.addEventListener("keydown", escape, true)
    document.addEventListener("close", dialogClosed, true)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    onCleanup(() => {
      close()
      document.removeEventListener("pointerover", enter)
      document.removeEventListener("focusin", enter)
      document.removeEventListener("pointerout", out)
      document.removeEventListener("focusout", out)
      document.removeEventListener("keydown", escape, true)
      document.removeEventListener("close", dialogClosed, true)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
    })
  })
  return <Show when={target()} keyed>{owner => <Portal mount={owner.closest<HTMLDialogElement>("dialog[open]") ?? document.body}><div id={id} ref={bubble} role="tooltip" class="owned-tooltip" style={{ left: `${position().left}px`, top: `${position().top}px` }}>{owner.dataset.tooltip}</div></Portal>}</Show>
}
