import { createEffect, createSignal, Show, type ParentProps } from "solid-js"

export function createStartupReady(ready: () => boolean) {
  const [started, setStarted] = createSignal(ready())
  createEffect(() => {
    if (ready()) setStarted(true)
  })
  return started
}

export function StartupGate(props: ParentProps<{ ready: () => boolean }>) {
  const ready = createStartupReady(props.ready)
  return <Show when={ready()}>{props.children}</Show>
}
