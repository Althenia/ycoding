import { Match, Switch } from "solid-js"

export function DesktopStateIndicator(props: { state: string }) {
  const label = () => props.state.charAt(0).toUpperCase() + props.state.slice(1)
  return <span class="desktop-state" data-state-indicator data-state={props.state} role="img" aria-label={label()} data-tooltip={label()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><Switch fallback={<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01" /></>}>
    <Match when={props.state === "running"}><path class="desktop-state__orbit" d="M12 3a9 9 0 1 1-9 9" /><circle cx="12" cy="12" r="2" /></Match>
    <Match when={props.state === "supervising"}><path class="desktop-state__orbit" d="M12 3a9 9 0 1 1-9 9" /><path d="M12 8v3m-3 5v-3h6v3" /></Match>
    <Match when={props.state === "idle"}><path d="M8 6v12M16 6v12" /></Match>
    <Match when={props.state === "waiting"}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Match>
    <Match when={props.state === "failed"}><path d="m12 3 10 18H2Zm0 6v5m0 3h.01" /></Match>
    <Match when={props.state === "completed"}><circle cx="12" cy="12" r="9" /><path d="m7 12 3 3 7-7" /></Match>
    <Match when={props.state === "lost"}><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6m0-6-6 6" /></Match>
    <Match when={props.state === "cancelled"}><circle cx="12" cy="12" r="9" /><path d="m6 18 12-12" /></Match>
  </Switch></svg></span>
}
