import type { ModelInfo, ProviderUsageListOutput, SessionCacheDiagnostics, SessionInfo } from "@ycoding-ai/client"
import { CREDIT_TO_USD } from "@ycoding-ai/core/provider-usage/copilot"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { useRouteData } from "../../context/route"
import { useDialog } from "../../ui/dialog"
import { formatWindowValue, freshnessLabel } from "../../util/provider-usage"
import { formatDiagnosticsModel, type ProviderRequestDiagnostics } from "../../util/cache-diagnostics"
import { DialogSelect } from "../../ui/dialog-select"

export type ProviderUsageSnapshot = ProviderUsageListOutput["data"][number]

export function selectedProviderIDs(
  sessionIDs: readonly string[],
  getSession: (sessionID: string) => Pick<SessionInfo, "model"> | undefined,
) {
  return [
    ...new Set(
      sessionIDs.flatMap((sessionID) => {
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
    selectedProviderIDs(
      family(),
      (sessionID) => data.session.get(sessionID),
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
    sessionFamily().forEach((sessionID) => void data.session.diagnostics.sync(sessionID).catch(() => undefined))
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
      getModel={(sessionID) => {
        const session = data.session.get(sessionID)
        if (!session?.model) return
        return data.location
          .model.list(session.location)
          ?.find((model) => model.providerID === session.model?.providerID && model.id === session.model?.id)
      }}
      getDiagnostics={(sessionID) => data.session.diagnostics.get(sessionID)}
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
  getSession?: (sessionID: string) => Pick<SessionInfo, "model" | "title"> | undefined
  getModel?: (sessionID: string) => ModelInfo | undefined
  getDiagnostics?: (sessionID: string) => SessionCacheDiagnostics | null | undefined
  getStatus?: (sessionID: string) => string
  sessionUsage?: ProviderUsageSessionPresentation
  subagentUsage?: readonly ProviderUsageSubagentPresentation[]
}) {
  const sessionUsage = createMemo(() =>
    props.sessionUsage ??
    diagnosticsPresentation(
      props.diagnostics?.(),
      props.sessionID ? formatDiagnosticsModel(props.getSession?.(props.sessionID)?.model) : undefined,
      props.sessionID ? props.getModel?.(props.sessionID) : undefined,
    ),
  )
  const subagentUsage = createMemo(() =>
    props.subagentUsage ??
    (props.sessionFamily ?? []).flatMap((sessionID) => {
      if (sessionID === props.sessionID) return []
      const diagnostics = props.getDiagnostics?.(sessionID)
      const session = props.getSession?.(sessionID)
      const usage = diagnosticsPresentation(diagnostics, formatDiagnosticsModel(session?.model), props.getModel?.(sessionID))
      if (!usage || !session) return []
      return [{ ...usage, name: session.title }]
    }),
  )
  const options = createMemo(() => [
    ...(sessionUsage() ? usageOptions("This session", "session", sessionUsage()!) : []),
    ...subagentUsage().flatMap((item) => usageOptions("Subagents", `subagent:${item.name}`, item, item.name)),
    ...visibleProviderSnapshots(props.snapshots()).flatMap((snapshot) => providerQuotaOptions(snapshot, props.now?.() ?? Date.now())),
  ])

  return (
    <DialogSelect title="Provider usage" options={options()} />
  )
}

function providerQuotaOptions(snapshot: ProviderUsageSnapshot, now: number) {
  const resetAt = snapshot.windows
    .map((window) => window.resetAt)
    .filter((value): value is number => value !== undefined && value > now)
    .toSorted((left, right) => left - right)
    .at(0)
  return [
    {
      title: snapshot.label,
      footer: snapshot.status === "available" ? freshnessLabel(snapshot, now) : "Unavailable",
      category: "Provider quota",
      value: `provider:${snapshot.providerID}`,
    },
    ...snapshot.windows.map((window) => ({
      title: `  ${window.label}`,
      footer: formatWindowValue(window),
      category: "Provider quota",
      value: `provider:${snapshot.providerID}:${window.id}`,
    })),
    ...(resetAt === undefined
      ? []
      : [{
          title: "  Reset",
          footer: formatRelativeReset(resetAt, now),
          category: "Provider quota",
          value: `provider:${snapshot.providerID}:reset`,
        }]),
  ]
}

function formatRelativeReset(resetAt: number, now: number) {
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000))
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `in ${days}d${remainingHours ? ` ${remainingHours}h` : ""}`
}

export type ProviderUsageSessionPresentation = {
  model: string
  hit: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  spent: string
  aic?: {
    input: string
    output: string
    cacheRead: string
    cacheWrite: string
  }
}

export type ProviderUsageSubagentPresentation = ProviderUsageSessionPresentation & { name: string }

/**
 * The measured subject is one row and its metrics are indented detail rows beneath it, so a session
 * and a subagent read as the same shape.
 */
function usageOptions(category: string, key: string, usage: ProviderUsageSessionPresentation, name?: string) {
  return [
    {
      title: name ?? usage.model,
      description: name ? usage.model : undefined,
      footer: usage.hit,
      category,
      value: `${key}:model`,
    },
    { title: "  Raw input", footer: metric(usage.input, usage.aic?.input), category, value: `${key}:input` },
    { title: "  Raw output", footer: metric(usage.output, usage.aic?.output), category, value: `${key}:output` },
    { title: "  Cache read", footer: metric(usage.cacheRead, usage.aic?.cacheRead), category, value: `${key}:cache-read` },
    { title: "  Cache write", footer: metric(usage.cacheWrite, usage.aic?.cacheWrite), category, value: `${key}:cache-write` },
    { title: "  Spent", footer: usage.spent, category, value: `${key}:spent` },
  ]
}

function diagnosticsPresentation(
  diagnostics: SessionCacheDiagnostics | null | undefined,
  model?: string,
  modelInfo?: ModelInfo,
): ProviderUsageSessionPresentation | undefined {
  if (!diagnostics) return
  return {
    model: model ?? formatDiagnosticsModel(diagnostics.model) ?? diagnostics.model.id,
    hit: hitLabel(diagnostics.cache.hitRatio),
    input: diagnostics.tokens.uncachedInput.toLocaleString("en-US"),
    output: diagnostics.tokens.output.toLocaleString("en-US"),
    cacheRead: diagnostics.tokens.cacheRead.toLocaleString("en-US"),
    cacheWrite: diagnostics.tokens.cacheWrite.toLocaleString("en-US"),
    spent: money(diagnostics.estimatedCost),
    ...(aiCredits(diagnostics, modelInfo) === undefined ? {} : { aic: aiCredits(diagnostics, modelInfo) }),
  }
}

function metric(tokens: string, credits: string | undefined) {
  return credits === undefined ? tokens : `${tokens}    ${credits}`
}

function aiCredits(diagnostics: SessionCacheDiagnostics, model: ModelInfo | undefined) {
  if (model?.providerID !== "github-copilot") return undefined
  const cost = model.cost.find((item) => item.tier === undefined)
  if (!cost) return undefined
  const credits = (tokens: number, rate: number) =>
    Math.round((tokens * rate) / 1_000_000 / CREDIT_TO_USD).toLocaleString("en-US")
  return {
    input: credits(diagnostics.tokens.uncachedInput, cost.input),
    output: credits(diagnostics.tokens.output, cost.output),
    cacheRead: credits(diagnostics.tokens.cacheRead, cost.cache.read),
    cacheWrite: credits(diagnostics.tokens.cacheWrite, cost.cache.write),
  }
}

function hitLabel(ratio: number | undefined) {
  return ratio === undefined ? "Unreported" : `${Math.round(ratio * 100)}% hit`
}

function money(value: number | undefined) {
  return value === undefined ? "Unreported" : `$${value.toFixed(2)}`
}
