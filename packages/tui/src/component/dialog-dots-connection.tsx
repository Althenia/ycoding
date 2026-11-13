import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { createDotsConnection, dotsRequests } from "../dots-connection"
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
    ...dotsRequests(() => client.api),
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
  const computerLabels = { attached: "Attached", detached: "Not attached", unavailable: "Unavailable", removed: "Removed" } as const
  const readinessLabels = { connected: "Connected", offline: "Offline", unknown: "Unknown" } as const
  const options = createMemo(() => {
    const status = connection.status()
    const reported = status?.connection.state
    const computer = status?.access.enabled ? status.computer : undefined
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
        ...(status?.connection.name ? [`Name: ${status.connection.name}`] : []),
        ...(computer?.name ? [`Executor name: ${computer.name}`] : []),
        ...(computer ? [`Executor: ${computerLabels[computer.state]}`] : []),
        ...(computer?.readiness ? [`Cloud readiness: ${readinessLabels[computer.readiness]}`] : []),
        ...(computer?.usableForTasks === undefined ? [] : [`Usable for Dots tasks: ${computer.usableForTasks ? "Yes" : "No"}`]),
        ...(computer?.dotEnvironment ? [`Dot environment: ${[computer.dotEnvironment.status, ...computer.dotEnvironment.capabilities.map((item) => `${item.type} ${item.status}`)].join(" · ")}`] : []),
        ...(computer?.message ? [computer.message] : []),
        `Connection: ${reported ? reported[0].toUpperCase() + reported.slice(1) : "Unreported"}${status && !connection.ready() && !connection.pending() ? " (last reported)" : ""}`,
        ...(!connection.connected() ? ["Backend disconnected. Reconnect to refresh status."] : []),
        ...(status?.configuration.message ? [status.configuration.message] : []),
        ...(status?.connection.message ? [status.connection.message] : []),
        ...(connection.attachFailure() ? [`Could not use this computer: ${connection.attachFailure()}`] : []),
        ...(connection.detachFailure() ? [`Could not detach this computer: ${connection.detachFailure()}`] : []),
        ...(connection.failure() ? [`Status unavailable: ${connection.failure()}`, "Press r to refresh."] : []),
      ],
      detailsWrap: true,
    }, ...(connection.canAttach() ? [{
      value: "attach",
      title: "Use this computer for Dots tasks",
      description: "Asks to confirm first",
    }] : []), ...(connection.canDetach() ? [{
      value: "detach",
      title: "Detach this computer from Dots tasks",
      description: "Asks to confirm first",
    }] : [])]
  })
  const confirmOptions = [
    {
      value: "attach-confirm",
      title: "Use this computer",
      details: ["Other computers stay connected. Choose which computer runs a Dots task in ChatGPT."],
      detailsWrap: true,
    },
    { value: "attach-cancel", title: "Cancel" },
  ]
  const detachOptions = [
    {
      value: "detach-confirm",
      title: "Detach this computer",
      details: ["This computer will stop running Dots tasks. Other computers stay connected."],
      detailsWrap: true,
    },
    { value: "detach-cancel", title: "Cancel" },
  ]
  const main = () => <DialogSelect
    title="Dots connection"
    options={options()}
    renderFilter={false}
    skipFilter
    preserveSelection
    locked={!connection.canToggle() && !connection.canAttach() && !connection.canDetach()}
    onSelect={(option) => {
      if (option.value === "attach") connection.requestAttach()
      else if (option.value === "detach") connection.requestDetach()
      else void connection.toggle()
    }}
    bindings={[{ bind: "r", title: "Refresh Dots connection", group: "Dialog", run: () => { void connection.refresh() } }]}
    footer={<text fg={theme.text.subdued}>{connection.canToggle() ? `enter ${action().toLowerCase()} · ` : ""}r refresh · esc close</text>}
  />
  return <Show when={connection.confirmingAttach()} fallback={<Show when={connection.confirmingDetach()} fallback={main()}>
    <DialogSelect
      title="Detach this computer from Dots tasks?"
      options={detachOptions}
      renderFilter={false}
      skipFilter
      onSelect={(option) => { if (option.value === "detach-confirm") void connection.detach(); else connection.cancelDetach() }}
      footer={<text fg={theme.text.subdued}>enter choose · esc close</text>}
    />
  </Show>}>
    <DialogSelect
      title="Use this computer for Dots tasks?"
      options={confirmOptions}
      renderFilter={false}
      skipFilter
      onSelect={(option) => { if (option.value === "attach-confirm") void connection.attach(); else connection.cancelAttach() }}
      footer={<text fg={theme.text.subdued}>enter choose · esc close</text>}
    />
  </Show>
}
