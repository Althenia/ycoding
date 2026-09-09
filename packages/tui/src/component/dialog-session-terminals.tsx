import type { SessionInfo } from "@ycoding-ai/client"
import { Pty } from "@ycoding-ai/schema/pty"
import { Option, Schema } from "effect"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useClient } from "../context/client"
import { useRoute } from "../context/route"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogSessionTerminals(props: { sessionID: string; location: SessionInfo["location"] }) {
  const client = useClient()
  const route = useRoute()
  const dialog = useDialog()
  const [terminals, setTerminals] = createSignal<readonly Pty.Info[]>([])
  const [loading, setLoading] = createSignal(true)
  const [failed, setFailed] = createSignal(false)
  let request: AbortController | undefined

  const load = () => {
    request?.abort()
    const controller = new AbortController()
    request = controller
    setLoading(true)
    setFailed(false)
    void client.api.pty
      .list(
        {
          sessionID: props.sessionID,
          location: { directory: props.location.directory, workspace: props.location.workspaceID },
        },
        { signal: controller.signal },
      )
      .then((response) => {
        if (controller.signal.aborted) return
        setTerminals(
          response.data
            .map((terminal) => Option.getOrUndefined(Schema.decodeUnknownOption(Pty.Info)(terminal)))
            .filter((terminal): terminal is Pty.Info => terminal?.sessionID === props.sessionID),
        )
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
  }

  onMount(load)
  onCleanup(() => request?.abort())

  const options = createMemo(() =>
    terminals().map((terminal) => ({
      title: terminal.title,
      description: `${terminal.size.cols}×${terminal.size.rows} · ${terminal.control.owner === "user" ? "You control" : terminal.control.owner}`,
      category: terminal.status === "running" ? "Running" : "Exited",
      state: terminal.status === "running" ? ("connected" as const) : ("disabled" as const),
      value: terminal,
    })),
  )

  return (
    <DialogSelect
      title="Session terminals"
      options={options()}
      preserveSelection
      onSelect={(option) => {
        if (option.value.sessionID !== props.sessionID) return
        route.navigate({ type: "terminal-inspector", sessionID: props.sessionID, ptyID: option.value.id })
        dialog.clear()
      }}
      bindings={[{ bind: "r", title: "Retry terminal list", group: "Dialog", run: load }]}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1} flexDirection="column">
          <Show when={loading()}>
            <text>Loading Session terminals…</text>
          </Show>
          <Show when={!loading() && failed()}>
            <text>Unable to load Session terminals</text>
            <text>Press r to retry</text>
          </Show>
          <Show when={!loading() && !failed()}>
            <text>No terminals belong to this Session</text>
          </Show>
        </box>
      }
    />
  )
}
