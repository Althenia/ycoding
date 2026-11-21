import type { InteractionStatus, SessionInteractionRequestInput } from "@ycoding-ai/client"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { Schema } from "effect"
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { useClient } from "../../context/client"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"

const decodeProposal = Schema.decodeUnknownOption(Interaction.Request, { onExcessProperty: "error" })

function label(status: InteractionStatus | undefined) {
  if (!status) return "Checking interaction…"
  if (status.state === "unavailable") return "Interaction unavailable"
  const platform = status.platform === "chrome" ? "Chrome" : "macOS"
  if (status.state === "pending") return status.platform === "chrome" ? "Chrome control · Awaiting local approval" : "Awaiting approval in macOS"
  if (status.state === "active" || status.state === "paused") {
    const target = status.label.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "")
    const prefix = `${platform} control ${status.state}${target ? ` · ${target}` : ""}`
    if (status.state === "active") return prefix
    const reason = {
      foreground_required: "Bring the target to the front yourself", file_chooser: "Choose the file yourself",
      dialog: "Answer the dialog yourself", captcha: "Complete the CAPTCHA yourself",
      sensitive: "Fill the sensitive field yourself", user_takeover: "You are in control",
    }[status.reason]
    return `${prefix} · ${reason}`
  }
  const reason = {
    stopped: "", rejected: " · Approval declined", expired: " · Grant expired", disconnected: " · Platform disconnected",
    target_lost: " · Target lost", uncertain: " · Last action unconfirmed", permission: " · Permission lost", shutdown: " · Backend stopped",
  }[status.reason]
  return `${platform} control stopped · Cleanup ${status.cleanup}${reason}`
}

export function SessionInteractionControl(props: { readonly sessionID: string }) {
  const client = useClient()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [status, setStatus] = createSignal<InteractionStatus>()
  const [busy, setBusy] = createSignal<"request" | "stop" | "resume">()
  const [readFailed, setReadFailed] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  const connected = () => client.connection.status() === "connected"
  const stoppable = () => {
    const current = status()
    return current?.state === "pending" || current?.state === "active" || current?.state === "paused" ? current : undefined
  }
  const resumable = () => {
    const current = status()
    return current?.state === "paused" ? current : undefined
  }
  let owner: { readonly sessionID: string; readonly controller: AbortController; reading: boolean; again: boolean } | undefined
  let mutationRevision = 0

  const refresh = async () => {
    const scope = owner
    if (!scope) return
    if (scope.reading) { scope.again = true; return }
    scope.reading = true
    const next = await client.api.sessionInteraction.status({ sessionID: scope.sessionID }, { signal: scope.controller.signal }).catch(() => undefined)
    if (owner !== scope) return
    scope.reading = false
    if (scope.again) { scope.again = false; void refresh(); return }
    setStatus(next)
    setReadFailed(next === undefined)
  }

  createEffect(on([() => props.sessionID, connected], ([sessionID, ready]) => {
    owner?.controller.abort()
    owner = ready ? { sessionID, controller: new AbortController(), reading: false, again: false } : undefined
    setStatus(undefined)
    setBusy(undefined)
    setReadFailed(false)
    setNotice(undefined)
    if (owner) void refresh()
  }))
  onCleanup(() => { owner?.controller.abort(); owner = undefined })
  onCleanup(client.event.on("session.interaction.changed", (event) => {
    if (event.data.sessionID !== owner?.sessionID) return
    const current = status()
    if (current && "generation" in current && current.generation !== event.data.generation) setStatus(undefined)
    void refresh()
  }))

  const requestable = () => {
    const base = client.baseUrl()
    const state = status()?.state
    return connected() && !busy() && (state === "unavailable" || state === "stopped") && !!base && URL.canParse(base) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)
  }

  const mutate = async (kind: "request" | "stop" | "resume", send: (sessionID: string, signal: AbortSignal) => Promise<InteractionStatus>) => {
    const scope = owner
    if (!scope || !connected() || busy() === "stop" || (kind !== "stop" && busy())) return
    const revision = ++mutationRevision
    const current = () => owner === scope && revision === mutationRevision
    setBusy(kind)
    setNotice(undefined)
    await send(scope.sessionID, scope.controller.signal).catch(() => {
      if (current()) setNotice({
        stop: "Stop was not confirmed. Check the reported status.",
        resume: "Resume was not confirmed. Check the reported status.",
        request: "The request was not confirmed. Check the reported status.",
      }[kind])
    })
    if (!current()) return
    setStatus(undefined)
    setBusy(undefined)
    void refresh()
  }

  const request = (payload: SessionInteractionRequestInput["payload"]) => {
    if (!requestable()) return
    void mutate("request", (sessionID, signal) => client.api.sessionInteraction.request({ sessionID, payload }, { signal }))
  }

  const requestNewTab = (mode: "owned" | "isolated") => {
    const scope = owner
    if (!scope || !requestable()) return
    dialog.replace(() => {
      const [invalid, setInvalid] = createSignal(false)
      return <DialogPrompt title="Starting URL" placeholder="https://example.test/" description={() => <>
        <text fg={theme.text.subdued}>{mode === "isolated" ? "Approve the target in the macOS system prompt before control starts." : "Approve the target in Chrome before control starts."}</text>
        <Show when={invalid()}><text fg={theme.text.feedback.warning.default}>Use a credential-free HTTP or HTTPS URL.</text></Show>
      </>} onConfirm={(value) => {
        if (owner !== scope || !requestable()) { dialog.clear(); return }
        const url = value.trim()
        const decoded = decodeProposal({ platform: "chrome", mode, url })
        if (decoded._tag === "None" || !URL.canParse(url)) { setInvalid(true); return }
        dialog.clear()
        request(decoded.value)
      }} />
    })
  }

  const stop = () => {
    const current = stoppable()
    if (!current) return
    void mutate("stop", (sessionID, signal) => client.api.sessionInteraction.stop({ sessionID, generation: current.generation }, { signal }))
  }

  const resume = () => {
    const current = resumable()
    if (!current) return
    void mutate("resume", (sessionID, signal) => client.api.sessionInteraction.resume({ sessionID, generation: current.generation }, { signal }))
  }

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: "session.interaction.chrome", group: "Session", title: "Request Chrome control", palette: true, bind: false, enabled: requestable(), run: () => { dialog.clear(); request({ platform: "chrome", mode: "tab" }) } },
      { id: "session.interaction.chrome.owned", group: "Session", title: "Request owned Chrome tab", palette: true, bind: false, enabled: requestable(), run: () => requestNewTab("owned") },
      { id: "session.interaction.chrome.isolated", group: "Session", title: "Request isolated Chrome", palette: true, bind: false, enabled: requestable(), run: () => requestNewTab("isolated") },
      { id: "session.interaction.macos", group: "Session", title: "Request macOS control", palette: true, bind: false, enabled: requestable(), run: () => { dialog.clear(); request({ platform: "macos" }) } },
      { id: "session.interaction.resume", group: "Session", title: "Resume interaction", palette: true, bind: false, enabled: connected() && !!resumable() && !busy(), run: () => { dialog.clear(); resume() } },
      { id: "session.interaction.stop", group: "Session", title: "Stop interaction", palette: true, bind: false, enabled: connected() && !!stoppable() && busy() !== "stop", run: () => { dialog.clear(); stop() } },
      { id: "session.interaction.refresh", group: "Session", title: "Refresh interaction status", palette: true, bind: false, enabled: connected() && readFailed(), run: () => { dialog.clear(); void refresh() } },
    ],
  }))

  const visible = () => {
    if (!connected()) return false
    if (busy() === "request" || notice()) return true
    if (readFailed()) return false
    const current = status()
    return current !== undefined && current.state !== "unavailable"
  }

  return <Show when={visible()}>
    <box flexShrink={0} flexDirection="column" paddingLeft={1}>
      <box flexDirection="row" gap={1}>
        <text flexGrow={1} fg={status()?.state === "pending" || status()?.state === "paused" ? theme.text.feedback.warning.default : status()?.state === "active" ? theme.text.action.primary.default : theme.text.subdued}>
          {readFailed() ? "Interaction status unavailable" : busy() === "request" && !stoppable() ? "Requesting platform approval…" : label(status())}
        </text>
        <Show when={resumable()}>
          <text flexShrink={0} wrapMode="none" fg={theme.text.action.primary.default} selectable={false} onMouseUp={resume}>{busy() === "resume" ? "Resuming…" : "Resume interaction"}</text>
        </Show>
        <Show when={stoppable()}>
          <text flexShrink={0} wrapMode="none" fg={theme.text.feedback.error.default} selectable={false} onMouseUp={stop}>{busy() === "stop" ? "Stopping…" : "Stop interaction"}</text>
        </Show>
      </box>
      <Show when={notice()}>{(message) => <text fg={theme.text.feedback.warning.default}>{message()}</text>}</Show>
    </box>
  </Show>
}
