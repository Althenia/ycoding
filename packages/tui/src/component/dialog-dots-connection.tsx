import { createMemo, onCleanup, onMount } from "solid-js"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { createDotsConnection } from "../dots-connection"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export function DotsConnectionCommand() {
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const connection = createDotsConnection({
    owner: () => client.api,
    connected: () => client.connection.status() === "connected",
    get: (signal) => client.api.dots.get({ signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }),
    set: (input) => client.api.dots.set(input, { signal: AbortSignal.timeout(5000) }),
    error: (error) => toast.error(error),
  })
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [{
      id: "dots.connection", title: "Dots connection", group: "Services", palette: true,
      slash: { name: "dots" },
      run: () => dialog.replace(() => <DialogDotsConnection connection={connection} />),
    }],
  }))
  return null
}

export function DialogDotsConnection(props: { connection: ReturnType<typeof createDotsConnection> }) {
  const { theme } = useTheme().contextual("elevated")
  const connection = props.connection
  onMount(connection.open)
  onCleanup(connection.close)
  const action = () => connection.status()?.access.enabled ? "Disconnect" : "Connect"
  const options = createMemo(() => {
    const status = connection.status()
    const reported = status?.connection.state
    return [{
      value: "access",
      title: status ? action() : "Dots access unavailable",
      description: connection.pending() ? "Updating access…" : !connection.ready() ? "Waiting for current status" : undefined,
      details: [
        "All existing and future eligible Sessions on this backend.",
        "Disconnect does not interrupt admitted work.",
        `Access: ${status ? status.access.enabled ? "On" : "Off" : "Unreported"}`,
        `Configuration: ${status ? status.configuration.ready ? "Ready" : "Not ready" : "Unreported"}`,
        `Profile: ${status?.configuration.profile ?? "Unreported"}`,
        `Computer: ${status?.connection.hostname ?? "Unreported"}`,
        `Connection: ${reported ? reported[0].toUpperCase() + reported.slice(1) : "Unreported"}${status && !connection.ready() && !connection.pending() ? " (last reported)" : ""}`,
        ...(!connection.connected() ? ["Backend disconnected. Reconnect to refresh status."] : []),
        ...(status?.configuration.message ? [status.configuration.message] : []),
        ...(status?.connection.message ? [status.connection.message] : []),
        ...(connection.failure() ? [`Status unavailable: ${connection.failure()}`, "Press r to refresh."] : []),
      ],
      detailsWrap: true,
    }]
  })
  return <DialogSelect
    title="Dots connection"
    options={options()}
    renderFilter={false}
    skipFilter
    preserveSelection
    locked={!connection.canToggle()}
    onSelect={() => { void connection.toggle() }}
    bindings={[{ bind: "r", title: "Refresh Dots connection", group: "Dialog", run: () => { void connection.refresh() } }]}
    footer={<text fg={theme.text.subdued}>{connection.canToggle() ? `enter ${action().toLowerCase()} · ` : ""}r refresh · esc close</text>}
  />
}
