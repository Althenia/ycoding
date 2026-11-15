import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"

export function Keyed<T>(props: { each: readonly T[]; by: (item: T) => string; children: (item: Accessor<T>) => JSX.Element }) {
  const entries = createMemo(() => new Map(props.each.map((item) => [props.by(item), item])))
  const keys = createMemo(() => [...entries().keys()])
  return <For each={keys()}>{(key) => <Show when={entries().get(key)}>{(item) => props.children(item)}</Show>}</For>
}
