import type { JSX } from "solid-js"

export function UsageHeading(props: { readonly level: 2 | 3; readonly id?: string; readonly children: JSX.Element }) {
  return props.level === 2 ? <h2 id={props.id}>{props.children}</h2> : <h3 id={props.id}>{props.children}</h3>
}
