import type { ProviderUsageListOutput, SessionInfo } from "@ycoding-ai/client"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import {
  formatReset,
  formatWindowValue,
  freshnessLabel,
  progressBar,
  stabilityLabel,
  usageSeverity,
} from "../../util/provider-usage"

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
): KeymapCommand | undefined {
  if (visibleProviderSnapshots(snapshots).length === 0) return undefined
  return {
    id: "session.provider-usage",
    title: "Provider Usage",
    group: "Session",
    palette: true,
    bind: false,
    run,
  }
}

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
      dialog.replace(() => <ProviderUsageDialog providerIDs={ids} initialSnapshots={initial} />)
    }),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    commands: command() ? [command()!] : [],
  }))

  return null
}

export function ProviderUsageDialog(props: {
  providerIDs: readonly string[]
  initialSnapshots: readonly ProviderUsageSnapshot[]
}) {
  const client = useClient()
  const dialog = useDialog()
  const guard = createProviderUsageGenerationGuard()
  const [snapshots, setSnapshots] = createSignal(visibleProviderSnapshots(props.initialSnapshots))
  const [refreshing, setRefreshing] = createSignal(true)

  onMount(() => {
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
    <ProviderUsageDialogContent snapshots={snapshots} refreshing={refreshing} onClose={() => dialog.clear()} />
  )
}

export function ProviderUsageDialogContent(props: {
  snapshots: Accessor<readonly ProviderUsageSnapshot[]>
  now?: Accessor<number>
  refreshing?: Accessor<boolean>
  onClose?: () => void
}) {
  const { themeV2 } = useTheme().contextual("elevated")
  const now = createMemo(() => props.now?.() ?? Date.now())
  const snapshots = createMemo(() => visibleProviderSnapshots(props.snapshots()))

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

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
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
      <For each={snapshots()}>
        {(snapshot) => (
          <box marginTop={1} gap={1}>
            <box flexDirection="row" gap={1}>
              <text fg={themeV2.text.default}>
                <b>{snapshot.label}</b>
              </text>
              <Show when={snapshot.status === "available" || snapshot.status === "stale"}>
                <text fg={statusColor(snapshot.status)}>{freshnessLabel(snapshot, now())}</text>
                <Show when={stabilityLabel(snapshot)}>
                  {(label) => <text fg={themeV2.text.subdued}>{label()}</text>}
                </Show>
              </Show>
            </box>
            <Show
              when={snapshot.status === "unauthorized" || snapshot.status === "error"}
              fallback={
                <For each={snapshot.windows}>
                  {(window) => {
                    const bar = createMemo(() => (window.unit === "percent" ? progressBar(window.used) : undefined))
                    const reset = createMemo(() => formatReset(window.resetAt, now()))
                    return (
                      <box gap={0}>
                        <box flexDirection="row" gap={1}>
                          <text width={14} flexShrink={0} fg={themeV2.text.subdued}>
                            {window.label}
                          </text>
                          <Show when={bar()}>
                            {(value) => <text fg={percentColor(window.used)}>{value()}</text>}
                          </Show>
                          <text fg={percentColor(window.unit === "percent" ? window.used : undefined)}>
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
              <text fg={statusColor(snapshot.status)}>Usage unavailable</text>
            </Show>
            <Show when={snapshot.message && snapshot.status !== "unauthorized" && snapshot.status !== "error"}>
              {(message) => <text fg={statusColor(snapshot.status)}>{message()}</text>}
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}
