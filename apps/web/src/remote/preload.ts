import type { RemoteSession } from "./context"
import type { QueryScope } from "./queries"
import { usageReportInputs, usageZoneKey } from "./ui/usage-model"

/** Starts the one composed dashboard read the Usage page opens with; a fresh cached read is reused and nothing is read without a connection. */
export function preloadUsage(remote: RemoteSession | undefined) {
  const scope = connectedScope(remote)
  if (remote === undefined || scope === undefined) return
  const reports = usageReportInputs(Date.now(), localStorage.getItem(usageZoneKey) === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined)
  void remote.store.queryClient.query(remote.queries.usageDashboard(scope, true, reports)).catch(() => {})
}

export function preloadKeepAwake(remote: RemoteSession | undefined) {
  const scope = connectedScope(remote)
  if (remote === undefined || scope === undefined) return
  void remote.store.queryClient.query(remote.queries.keepAwake(scope, true)).catch(() => {})
}

export function preloadCoordination(remote: RemoteSession | undefined) {
  const scope = connectedScope(remote)
  if (remote === undefined || scope === undefined) return
  void remote.store.queryClient.query(remote.queries.coordination(scope, true)).catch(() => {})
}

export function preloadWorkspaces(remote: RemoteSession | undefined) {
  const scope = connectedScope(remote)
  if (remote === undefined || scope === undefined) return
  void remote.store.queryClient.query(remote.queries.workspaces(scope, true)).catch(() => {})
}

function connectedScope(remote: RemoteSession | undefined): QueryScope | undefined {
  const state = remote?.store.state()
  if (state?.activeDeviceID === undefined || state.transport.kind !== "open" || state.connection.kind !== "connected") return undefined
  return { deviceID: state.activeDeviceID, generation: state.generation }
}
