import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { McpApp, type McpAppView } from "./mcp-app"

export interface OpenMcpApp {
  readonly scope: string
  readonly view: McpAppView
  readonly text: string
}

export function McpAppResult(props: {
  readonly scope: string
  readonly load: () => Promise<McpAppView | undefined>
  readonly text: string
  readonly onOpen: (app: OpenMcpApp) => void
}): JSX.Element {
  const [state, setState] = createSignal<"idle" | "loading" | "unavailable" | McpAppView>("idle")
  const scope = createMemo(() => props.scope)
  let alive = true
  let request = 0
  createEffect(() => { void scope(); ++request; setState("idle") })
  onCleanup(() => { alive = false; ++request })
  const read = async () => {
    const owned = ++request
    const startedScope = scope()
    setState("loading")
    const data = await props.load().catch(() => undefined)
    if (alive && owned === request && startedScope === scope()) setState(data ?? "unavailable")
  }
  const view = () => {
    const value = state()
    return typeof value === "string" ? undefined : value
  }
  return <section aria-label="MCP App view">
    <Show when={view()} fallback={<>
      <button type="button" class="button button--secondary button--small" disabled={state() === "loading"} onClick={() => void read()}>Show MCP App</button>
      <Show when={state() === "loading"}><p role="status">Reading App…</p></Show>
      <Show when={state() === "unavailable"}><p role="status">App unavailable. The tool output is still available.</p></Show>
    </>}>{(value) => <>
      <McpApp view={value()} fallback={<pre class="output"><code>{props.text}</code></pre>} />
      <button type="button" class="button button--secondary button--small" onClick={() => props.onOpen({ scope: props.scope, view: value(), text: props.text })}>Show App in companion</button>
    </>}</Show>
  </section>
}
