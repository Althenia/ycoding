import { createMemo, Show, type JSX } from "solid-js"

export function Collapsible(props: {
  readonly open: boolean
  readonly id?: string
  readonly class?: string
  readonly children: JSX.Element
}): JSX.Element {
  let opened = props.open
  const mounted = createMemo(() => (opened = opened || props.open))
  return (
    <div
      class={props.class === undefined ? "collapsible" : `collapsible ${props.class}`}
      id={props.id}
      data-open={props.open ? "" : undefined}
      inert={!props.open}
      aria-hidden={props.open ? undefined : "true"}
    >
      <div class="collapsible__inner">
        <Show when={mounted()}>{props.children}</Show>
      </div>
    </div>
  )
}
