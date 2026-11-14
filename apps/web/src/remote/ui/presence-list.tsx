import { For, createEffect, createMemo, createSignal, on, onCleanup, untrack, type JSX } from "solid-js"
import { Collapsible } from "../../ui/collapsible"
import { reconcilePresence, settlePresence } from "./shell-model"
import { sameKeys } from "./virtual-rows"

export function PresenceList<T>(props: {
  readonly items: readonly T[]
  readonly keyOf: (item: T) => string
  readonly children: (item: () => T) => JSX.Element
}): JSX.Element {
  const initial = new Set(untrack(() => props.items.map(props.keyOf)))
  const [entries, setEntries] = createSignal(untrack(() => reconcilePresence([], props.items, props.keyOf)))
  createEffect(on(() => props.items, (items) => setEntries((current) => reconcilePresence(current, items, props.keyOf)), { defer: true }))
  const keys = createMemo(() => entries().map((entry) => entry.key), [], { equals: sameKeys })
  return (
    <For each={keys()}>{(key) => {
      const entry = createMemo(() => entries().find((candidate) => candidate.key === key))
      const [entered, setEntered] = createSignal(initial.has(key))
      const frame = requestAnimationFrame(() => setEntered(true))
      onCleanup(() => cancelAnimationFrame(frame))
      let host: HTMLDivElement | undefined
      createEffect(on(() => entry()?.open, (open) => {
        if (open !== false) return
        requestAnimationFrame(() => {
          const disclosure = host?.firstElementChild
          const exits = disclosure?.getAnimations().map((animation) => animation.finished) ?? []
          void Promise.allSettled(exits).then(() => setEntries((current) => settlePresence(current, key)))
        })
      }, { defer: true }))
      const item = createMemo<T>((previous) => entry()?.item ?? previous, untrack(() => entry()!.item))
      return (
        <div ref={host} class="presence-item">
          <Collapsible open={entered() && entry()?.open === true}>{props.children(item)}</Collapsible>
        </div>
      )
    }}</For>
  )
}
