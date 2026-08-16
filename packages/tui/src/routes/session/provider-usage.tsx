import type { ProviderUsageListOutput, SessionCacheDiagnostics, SessionInfo } from "@ycoding-ai/client"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import type { RGBA } from "@opentui/core"
import {
  formatReset,
  formatWindowValue,
  freshnessLabel,
  progressBar,
  stabilityLabel,
  usageSeverity,
} from "../../util/provider-usage"
import {
  formatProviderRequestDiagnostics,
  type ProviderRequestDiagnostics,
} from "../../util/cache-diagnostics"

export type ProviderUsageSnapshot = ProviderUsageListOutput["data"][number]

export function runningProviderIDs(
  sessionIDs: readonly string[],
  getSession: (sessionID: string) => Pick<SessionInfo, "model"> | undefined,
  getStatus: (sessionID: string) => string,
) {
  return [
    ...new Set(
      sessionIDs.flatMap((sessionID) => {
        if (getStatus(sessionID) !== "running") return []
        const providerID = getSession(sessionID)?.model?.providerID
        return providerID ? [providerID] : []
      }),
    ),
  ].toSorted()
}

export function visibleProviderSnapshots(snapshots: readonly ProviderUsageSnapshot[]) {
  return snapshots
    .filter((snapshot) => snapshot.status !== "unsupported")
    .toSorted((left, right) => left.label.localeCompare(right.label) || left.providerID.localeCompare(right.providerID))
}

export function createProviderUsageGenerationGuard() {
  let generation = 0
  return {
    next() {
      generation += 1
      return generation
    },
    current(token: number) {
      return token === generation
    },
    invalidate() {
      generation += 1
    },
  }
}

export async function loadProviderUsageSnapshots(
  providerIDs: readonly string[],
  load: (providerID: string) => Promise<ProviderUsageSnapshot>,
) {
  const unique = [...new Set(providerIDs)].toSorted()
  return visibleProviderSnapshots(await Promise.all(unique.map(load)))
}

export function providerUsageCommandDefinition(
  snapshots: readonly ProviderUsageSnapshot[],
  run: () => void,
  hasLocalDiagnostics = false,
): KeymapCommand | undefined {
  if (visibleProviderSnapshots(snapshots).length === 0 && !hasLocalDiagnostics) return undefined
  return {
    id: "session.provider-usage",
    title: "Provider Usage",
    group: "Session",
    palette: true,
    bind: false,
    run,
  }
}

type DiagnosticsWithRequests = SessionCacheDiagnostics & { readonly requests?: ProviderRequestDiagnostics }

const providerRequestDiagnostics = (diagnostics: SessionCacheDiagnostics | null | undefined) =>
  (diagnostics as DiagnosticsWithRequests | null | undefined)?.requests

export function ProviderUsageCommand() {
  const route = useRouteData("session")
  const data = useData()
  const client = useClient()
  const dialog = useDialog()
  const guard = createProviderUsageGenerationGuard()
  const [snapshots, setSnapshots] = createSignal<ProviderUsageSnapshot[]>([])
  const family = createMemo(() => {
    const sessionIDs = data.session.family(route.sessionID)
    return sessionIDs.length > 0 ? sessionIDs : [route.sessionID]
  })
  const providerIDs = createMemo(() =>
    runningProviderIDs(
      family(),
      (sessionID) => data.session.get(sessionID),
      (sessionID) => data.session.status(sessionID),
    ),
  )
  const diagnostics = createMemo(() => data.session.diagnostics.get(route.sessionID))

  onMount(() => void data.session.diagnostics.sync(route.sessionID).catch(() => undefined))

  createEffect(
    on(
      () => providerIDs().join("\u0000"),
      () => {
        const ids = providerIDs()
        const token = guard.next()
        setSnapshots([])
        if (ids.length === 0) return
        void loadProviderUsageSnapshots(ids, async (providerID) => {
          const result = await client.api.providerUsage.get({ providerID })
          return result.data
        })
          .then((result) => {
            if (guard.current(token)) setSnapshots(result)
          })
          .catch(() => {
            if (guard.current(token)) setSnapshots([])
          })
      },
    ),
  )
  onCleanup(() => guard.invalidate())

  const command = createMemo(() =>
    providerUsageCommandDefinition(snapshots(), () => {
      const ids = providerIDs()
      const initial = snapshots()
      dialog.replace(() => (
        <ProviderUsageDialog sessionID={route.sessionID} providerIDs={ids} initialSnapshots={initial} />
      ))
    }, providerRequestDiagnostics(diagnostics()) !== undefined),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    commands: command() ? [command()!] : [],
  }))

  return null
}

export function ProviderUsageDialog(props: {
  sessionID: string
  providerIDs: readonly string[]
  initialSnapshots: readonly ProviderUsageSnapshot[]
}) {
  const client = useClient()
  const data = useData()
  const dialog = useDialog()
  const guard = createProviderUsageGenerationGuard()
  const [snapshots, setSnapshots] = createSignal(visibleProviderSnapshots(props.initialSnapshots))
  const [refreshing, setRefreshing] = createSignal(true)
  const diagnostics = createMemo(() => data.session.diagnostics.get(props.sessionID))
  const sessionFamily = createMemo(() => {
    const ids = data.session.family(props.sessionID)
    return ids.length > 0 ? ids : [props.sessionID]
  })

  onMount(() => {
    void data.session.diagnostics.sync(props.sessionID).catch(() => undefined)
    const token = guard.next()
    void loadProviderUsageSnapshots(props.providerIDs, async (providerID) => {
      const result = await client.api.providerUsage.get({ providerID, refresh: true })
      return result.data
    })
      .then((result) => {
        if (!guard.current(token)) return
        setSnapshots(result)
      })
      .catch(() => undefined)
      .finally(() => {
        if (guard.current(token)) setRefreshing(false)
      })
  })
  onCleanup(() => guard.invalidate())

  return (
    <ProviderUsageDialogContent
      snapshots={snapshots}
      diagnostics={diagnostics}
      refreshing={refreshing}
      onClose={() => dialog.clear()}
      sessionFamily={sessionFamily()}
      sessionID={props.sessionID}
      getSession={(sessionID) => data.session.get(sessionID)}
      getStatus={(sessionID) => data.session.status(sessionID)}
    />
  )
}

export function ProviderUsageDialogContent(props: {
  snapshots: Accessor<readonly ProviderUsageSnapshot[]>
  diagnostics?: Accessor<SessionCacheDiagnostics | null | undefined>
  now?: Accessor<number>
  refreshing?: Accessor<boolean>
  onClose?: () => void
  sessionFamily?: readonly string[]
  sessionID?: string
  getSession?: (sessionID: string) => Pick<SessionInfo, "model"> | undefined
  getStatus?: (sessionID: string) => string
}) {
  const { themeV2 } = useTheme().contextual("elevated")
  const now = createMemo(() => props.now?.() ?? Date.now())
  const [filter, setFilter] = createSignal("")
  const rawSnapshots = createMemo(() => visibleProviderSnapshots(props.snapshots()))
  const filteredSnapshots = createMemo(() => {
    const needle = filter().toLowerCase()
    if (!needle) return rawSnapshots()
    return rawSnapshots().filter((s) => s.label.toLowerCase().includes(needle) || s.providerID.toLowerCase().includes(needle))
  })
  const local = createMemo(() => {
    const requests = providerRequestDiagnostics(props.diagnostics?.())
    return requests ? formatProviderRequestDiagnostics(requests) : undefined
  })

  const statusColor = (status: ProviderUsageSnapshot["status"]) => {
    if (status === "unauthorized" || status === "stale") return themeV2.text.feedback.warning.default
    if (status === "error") return themeV2.text.feedback.error.default
    return themeV2.text.subdued
  }

  const percentColor = (used: number | undefined) => {
    const severity = usageSeverity(used)
    if (severity === "error") return themeV2.text.feedback.error.default
    if (severity === "warning") return themeV2.text.feedback.warning.default
    return themeV2.text.default
  }

  const sessionProviderIDs = createMemo(() => {
    if (!props.sessionID || !props.getSession) return undefined
    const ids = runningProviderIDs(
      [props.sessionID],
      (sid) => props.getSession!(sid),
      (sid) => props.getStatus?.(sid) ?? "",
    )
    return ids.length > 0 ? new Set(ids) : undefined
  })

  const subagentProviderIDs = createMemo(() => {
    if (!props.sessionFamily || !props.sessionID || !props.getSession) return undefined
    const subagentIDs = props.sessionFamily.filter((id) => id !== props.sessionID)
    if (subagentIDs.length === 0) return undefined
    const ids = runningProviderIDs(subagentIDs, (sid) => props.getSession!(sid), (sid) => props.getStatus?.(sid) ?? "")
    return ids.length > 0 ? new Set(ids) : undefined
  })
  const hasSessionGroups = createMemo(() => !!sessionProviderIDs() || !!subagentProviderIDs())

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={themeV2.text.default}>
            <b>Provider Usage</b>
          </text>
          <Show when={props.refreshing?.()}>
            <text fg={themeV2.text.subdued}>refreshing</text>
          </Show>
        </box>
        <text fg={themeV2.text.subdued} onMouseUp={() => props.onClose?.()}>
          esc
        </text>
      </box>
      <box paddingTop={1}>
        <input
          onInput={(e) => setFilter(e)}
          focusedBackgroundColor={themeV2.background.surface.overlay}
          cursorColor={themeV2.text.feedback.info.default}
          focusedTextColor={themeV2.text.default}
          placeholder="Search providers"
          placeholderColor={themeV2.text.subdued}
        />
      </box>
      <Show when={local()}>
        {(value) => (
          <box gap={0}>
            <text fg={themeV2.text.default}>
              <b>YCoding requests</b>
            </text>
            <text fg={themeV2.text.subdued}>
              {`Logical requests ${value().logical} · Transport attempts ${value().physical}`}
            </text>
            <text fg={themeV2.text.subdued}>
              {`Helpers ${value().helpers} · Continued ${value().continued} · Fallbacks ${value().fallback}`}
            </text>
            <text fg={themeV2.text.subdued}>
              {`Raw input ${value().uncachedInput} · Raw output ${value().output}`}
            </text>
            <text fg={themeV2.text.subdued}>
              {`Raw cache read ${value().cacheRead} · write ${value().cacheWrite}`}
            </text>
            <text fg={themeV2.text.subdued}>
              {`Raw reasoning ${value().reasoning} · Estimated cost ${value().estimatedCost}`}
            </text>
            <Show when={value().latestInvalidation || value().latestNamespace}>
              <text fg={themeV2.text.subdued}>
                {[
                  value().latestInvalidation ? `Last invalidation ${value().latestInvalidation}` : undefined,
                  value().latestNamespace ? `Namespace ${value().latestNamespace}` : undefined,
                ]
                  .filter((item): item is string => item !== undefined)
                  .join(" · ")}
              </text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={hasSessionGroups()}>
        <Show when={sessionProviderIDs()}>
          {(ids) => (
            <box marginTop={1} gap={0}>
              <text fg={themeV2.text.default}>
                <b>This session</b>
              </text>
              <For each={filteredSnapshots().filter((s) => ids().has(s.providerID))}>
                {(snapshot) => (
                  <ProviderUsageRow snapshot={snapshot} now={now} statusColor={statusColor} percentColor={percentColor} />
                )}
              </For>
            </box>
          )}
        </Show>
        <Show when={subagentProviderIDs()}>
          {(ids) => (
            <box marginTop={1} gap={0}>
              <text fg={themeV2.text.default}>
                <b>Subagents</b>
              </text>
              <For each={filteredSnapshots().filter((s) => ids().has(s.providerID))}>
                {(snapshot) => (
                  <ProviderUsageRow snapshot={snapshot} now={now} statusColor={statusColor} percentColor={percentColor} />
                )}
              </For>
            </box>
          )}
        </Show>
      </Show>
      <Show when={!hasSessionGroups()}>
        <For each={filteredSnapshots()}>
          {(snapshot) => (
            <ProviderUsageRow snapshot={snapshot} now={now} statusColor={statusColor} percentColor={percentColor} />
          )}
        </For>
      </Show>
    </box>
  )
}

function ProviderUsageRow(props: {
  snapshot: ProviderUsageSnapshot
  now: Accessor<number>
  statusColor: (status: ProviderUsageSnapshot["status"]) => string | RGBA
  percentColor: (used: number | undefined) => string | RGBA
}) {
  const { themeV2 } = useTheme().contextual("elevated")
  return (
    <box marginTop={1} gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={themeV2.text.default}>
          <b>{props.snapshot.label}</b>
        </text>
        <Show when={props.snapshot.status === "available" || props.snapshot.status === "stale"}>
          <text fg={props.statusColor(props.snapshot.status)}>{freshnessLabel(props.snapshot, props.now())}</text>
          <Show when={stabilityLabel(props.snapshot)}>
            {(label) => <text fg={themeV2.text.subdued}>{label()}</text>}
          </Show>
        </Show>
      </box>
      <Show
        when={props.snapshot.status === "unauthorized" || props.snapshot.status === "error"}
        fallback={
          <For each={props.snapshot.windows}>
            {(window) => {
              const bar = createMemo(() => (window.unit === "percent" ? progressBar(window.used) : undefined))
              const reset = createMemo(() => formatReset(window.resetAt, props.now()))
              return (
                <box gap={0}>
                  <box flexDirection="row" gap={1}>
                    <text width={14} flexShrink={0} fg={themeV2.text.subdued}>
                      {window.label}
                    </text>
                    <Show when={bar()}>
                      {(value) => <text fg={props.percentColor(window.used)}>{value()}</text>}
                    </Show>
                    <text fg={props.percentColor(window.unit === "percent" ? window.used : undefined)}>
                      {formatWindowValue(window)}
                    </text>
                  </box>
                  <Show when={reset()}>{(value) => <text fg={themeV2.text.subdued}>{value()}</text>}</Show>
                </box>
              )
            }}
          </For>
        }
      >
        <text fg={props.statusColor(props.snapshot.status)}>Usage unavailable</text>
      </Show>
      <Show when={props.snapshot.message && props.snapshot.status !== "unauthorized" && props.snapshot.status !== "error"}>
        {(message) => <text fg={props.statusColor(props.snapshot.status)}>{message()}</text>}
      </Show>
    </box>
  )
}
