import type { IsolatedBrowserStatus, SessionInfo } from "@ycoding-ai/client"
import { IsolatedBrowser } from "@ycoding-ai/schema/isolated-browser"
import { TextAttributes } from "@opentui/core"
import { Option, Schema } from "effect"
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogTitle, useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"

type Props = { sessionID: string; location: SessionInfo["location"]; notice?: string }
type Pending = "pause" | "resume" | "stop"

export function SessionIsolatedBrowserCommand(props: Props) {
  const dialog = useDialog()
  Keymap.createLayer(() => ({
    commands: [
      {
        id: "session.browser.isolated",
        title: "Isolated browser",
        group: "Session",
        palette: true,
        bind: false,
        run: () => dialog.replace(() => <DialogSessionBrowser sessionID={props.sessionID} location={props.location} />),
      },
    ],
  }))
  return null
}

export function DialogSessionBrowser(props: Props) {
  const client = useClient()
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const [status, setStatus] = createSignal<IsolatedBrowserStatus>()
  const [loading, setLoading] = createSignal(true)
  const [failure, setFailure] = createSignal<string>()
  const [notice, setNotice] = createSignal(props.notice)
  const [pending, setPending] = createSignal<Pending>()
  let request: AbortController | undefined

  const scope = () => ({ sessionID: props.sessionID })

  const accept = (next: IsolatedBrowserStatus) => {
    if (next.tab && next.tab.sessionID !== props.sessionID) {
      setStatus()
      setFailure("Browser state does not belong to this Session. Refresh status before using browser controls.")
      return false
    }
    setStatus(next)
    setFailure()
    return true
  }

  const load = (keepNotice = false) => {
    request?.abort()
    setPending()
    const controller = new AbortController()
    request = controller
    setStatus()
    setFailure()
    if (!keepNotice) setNotice()
    setLoading(true)
    void client.api.isolatedBrowser
      .status(scope(), { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return
        accept(response)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailure("Unable to load isolated browser status.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
  }

  createEffect(
    on(
      () => [props.sessionID, props.location.directory, props.location.workspaceID] as const,
      () => load(Boolean(props.notice)),
    ),
  )
  onCleanup(() => request?.abort())

  const conflict = createMemo(() => {
    if (status()?.state !== "unavailable") return false
    const reason = status()?.reason?.toLowerCase() ?? ""
    return reason.includes("conflict") || reason.includes("selected-tab") || reason.includes("selected extension")
  })
  const tabUncertain = createMemo(() => {
    const current = status()
    return current?.state === "ready" && (!current.tab || current.tab.status === "unavailable")
  })
  const target = createMemo(() => {
    const tab = status()?.tab
    if (tab && tab.sessionID === props.sessionID) return `${tab.page.origin}${tab.page.path}`
    return undefined
  })

  const start = () => {
    if (loading() || pending() || conflict() || !["stopped", "unavailable"].includes(status()?.state ?? "")) return
    dialog.replace(() => <DialogIsolatedBrowserStart sessionID={props.sessionID} location={props.location} />)
  }

  const control = (action: "pause" | "resume") => {
    if (!canControl()) return
    request?.abort()
    const controller = new AbortController()
    request = controller
    setPending(action)
    setFailure()
    void client.api.isolatedBrowser
      .control({ ...scope(), action }, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) accept(response)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setNotice(`${action === "pause" ? "Pause" : "Resume"} result was uncertain. Refreshed current status.`)
        load(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending()
      })
  }

  const stop = () => {
    if (!canStop()) return
    request?.abort()
    const controller = new AbortController()
    request = controller
    setPending("stop")
    setFailure()
    void client.api.isolatedBrowser
      .stop(scope(), { signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) load()
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setNotice("Stop result was uncertain. Refreshed current status.")
        load(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending()
      })
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "r", title: "Refresh isolated browser status", group: "Dialog", run: () => !pending() && load() },
      { bind: "s", title: "Start isolated browser", group: "Dialog", run: start },
      {
        bind: "p",
        title: status()?.state === "paused" ? "Resume isolated browser" : "Pause isolated browser",
        group: "Dialog",
        run: () => {
          if (!canControl()) return
          if (status()?.state === "ready" && !tabUncertain()) control("pause")
          if (status()?.state === "paused") control("resume")
        },
      },
      { bind: "x", title: "Stop isolated browser", group: "Dialog", run: stop },
    ],
  }))

  const stateLabel = createMemo(() => {
    if (loading()) return "Loading"
    if (pending() === "pause") return "Pausing"
    if (pending() === "resume") return "Resuming"
    if (pending() === "stop") return "Stopping"
    const current = status()?.state
    if (!current) return "Status unknown"
    return current.charAt(0).toUpperCase() + current.slice(1)
  })
  const canStart = () =>
    !loading() && !pending() && !conflict() && ["stopped", "unavailable"].includes(status()?.state ?? "")
  const canControl = () =>
    !loading() &&
    !pending() &&
    !tabUncertain() &&
    (!status()?.tab || status()?.tab?.sessionID === props.sessionID) &&
    ["ready", "paused"].includes(status()?.state ?? "")
  const canStop = () => !loading() && !pending() && ![undefined, "stopped"].includes(status()?.state)

  return (
    <box paddingBottom={1} flexDirection="column">
      <DialogHeader title={<DialogTitle>Isolated browser</DialogTitle>} />
      <box paddingLeft={4} paddingRight={4} paddingTop={1} gap={1} flexDirection="column">
        <text fg={themeV2.text.feedback.warning.default} wrapMode="word">
          Temporary disposable Chrome profile. Do not sign in to personal accounts; closing this dialog does not stop
          it.
        </text>
        <text fg={themeV2.text.subdued} wrapMode="word">
          Isolated mode only. It never uses or changes selected-extension pairing. Stop it before switching browser
          modes in this Session.
        </text>
        <text attributes={TextAttributes.BOLD} fg={themeV2.text.default}>
          {stateLabel()}
        </text>
        <Show when={target()}>{(value) => <text wrapMode="word">Target {value()}</text>}</Show>
        <Show when={status()?.state === "paused"}>
          <text fg={themeV2.text.feedback.warning.default} wrapMode="word">
            Pause blocks new actions; in-flight work and page scripts may continue. Stop to end the browser.
          </text>
        </Show>
        <Show when={conflict()}>
          <text fg={themeV2.text.feedback.error.default} wrapMode="word">
            Selected extension mode conflicts with isolated mode. Stop before switching modes in this Session.
          </text>
        </Show>
        <Show when={tabUncertain()}>
          <text fg={themeV2.text.feedback.warning.default} wrapMode="word">
            Current tab is stale or unreported. Stop and start fresh before browser actions.
          </text>
        </Show>
        <Show when={notice()}>
          <text fg={themeV2.text.feedback.warning.default} wrapMode="word">
            {notice()}
          </text>
        </Show>
        <Show when={failure()}>{(message) => <text fg={themeV2.text.feedback.error.default}>{message()}</text>}</Show>
        <box flexDirection="row" gap={2} paddingTop={1}>
          <Show when={canStart()}>
            <text>
              <b>s</b> start
            </text>
          </Show>
          <Show when={canControl()}>
            <text>
              <b>p</b> {status()?.state === "paused" ? "resume" : "pause"}
            </text>
          </Show>
          <Show when={canStop()}>
            <text>
              <b>x</b> stop
            </text>
          </Show>
          <Show when={!pending()}>
            <text>
              <b>r</b> refresh
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}

function DialogIsolatedBrowserStart(props: Omit<Props, "notice">) {
  const client = useClient()
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const [busy, setBusy] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let request: AbortController | undefined

  const reopen = (notice?: string) =>
    dialog.replace(() => <DialogSessionBrowser sessionID={props.sessionID} location={props.location} notice={notice} />)

  const start = (input: string) => {
    if (busy() || stopping()) return
    const url = boundedUrl(input)
    if (!url) {
      setError("Enter an http:// or https:// URL without embedded credentials.")
      return
    }
    setError()
    setBusy(true)
    const controller = new AbortController()
    request = controller
    void client.api.isolatedBrowser
      .start({ sessionID: props.sessionID, url }, { signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) reopen()
      })
      .catch(() => {
        if (!controller.signal.aborted)
          reopen("Start result was uncertain. Current status was refreshed; Start was not retried.")
      })
  }

  const stop = () => {
    if (!busy() || stopping()) return
    setStopping(true)
    request?.abort()
    const controller = new AbortController()
    request = controller
    void client.api.isolatedBrowser
      .stop({ sessionID: props.sessionID }, { signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) reopen()
      })
      .catch(() => {
        if (!controller.signal.aborted) reopen("Stop result was uncertain. Current status was refreshed.")
      })
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    priority: 1,
    enabled: busy,
    commands: [{ bind: "x", title: "Stop starting isolated browser", group: "Dialog", run: stop }],
  }))
  onCleanup(() => request?.abort())

  return (
    <DialogPrompt
      title="Start isolated browser"
      placeholder="https://example.com/path"
      busy={busy()}
      busyText={stopping() ? "Stopping isolated browser…" : "Starting isolated browser…  x stop"}
      onConfirm={start}
      description={() => (
        <box flexDirection="column" paddingBottom={1}>
          <text fg={themeV2.text.feedback.warning.default} wrapMode="word">
            Uses a fresh temporary Chrome profile. Do not sign in to personal accounts. Nothing is persisted
            intentionally.
          </text>
          <Show when={error()}>{(message) => <text fg={themeV2.text.feedback.error.default}>{message()}</text>}</Show>
        </box>
      )}
    />
  )
}

function boundedUrl(input: string) {
  const value = input.trim()
  return Option.getOrUndefined(Schema.decodeUnknownOption(IsolatedBrowser.StartInput)({ url: value }))?.url
}
