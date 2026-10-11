import { createEffect, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import { sheetFrame } from "./composer-logic"

export function createSheetFrame(active: Accessor<boolean>): Accessor<JSX.CSSProperties | undefined> {
  const [frame, setFrame] = createSignal<ReturnType<typeof sheetFrame>>()
  createEffect(() => {
    if (!active()) {
      setFrame(undefined)
      return
    }
    const viewport = window.visualViewport
    let scheduled: number | undefined
    const measure = () => {
      scheduled = undefined
      setFrame(sheetFrame(viewport ?? undefined))
    }
    const schedule = () => { scheduled ??= requestAnimationFrame(measure) }
    measure()
    viewport?.addEventListener("resize", schedule)
    viewport?.addEventListener("scroll", schedule)
    onCleanup(() => {
      viewport?.removeEventListener("resize", schedule)
      viewport?.removeEventListener("scroll", schedule)
      if (scheduled !== undefined) cancelAnimationFrame(scheduled)
    })
  })
  return () => {
    const value = frame()
    return value ? { "--composer-sheet-top": `${value.top}px`, "--composer-sheet-height": `${value.height}px` } : undefined
  }
}

export function containTab(event: KeyboardEvent, container: HTMLElement): boolean {
  if (event.key !== "Tab") return false
  const controls = [...container.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((control) => control.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || !last) {
    event.preventDefault()
    return true
  }
  const outside = !(document.activeElement instanceof Node) || !container.contains(document.activeElement) || document.activeElement === container
  const next = outside || (event.shiftKey && document.activeElement === first) ? (event.shiftKey ? last : first)
    : !event.shiftKey && document.activeElement === last ? first : undefined
  if (!next) return true
  event.preventDefault()
  next.focus()
  return true
}
