import type { QueryClient } from "@tanstack/solid-query"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { DesktopAPI } from "./contract"

export function eventSessionID(event: YCodingEvent) {
  const data: unknown = "data" in event ? event.data : undefined
  if (!data || typeof data !== "object") return undefined
  if ("sessionID" in data && typeof data.sessionID === "string") return data.sessionID
  if ("form" in data && data.form && typeof data.form === "object" && "sessionID" in data.form && typeof data.form.sessionID === "string") return data.form.sessionID
  return undefined
}

export function createEventRefresh(input: {
  queries: QueryClient
  source: Pick<DesktopAPI, "onEvent" | "onResync">
  scope: () => readonly [number, number]
  accept?: (event: YCodingEvent) => boolean
  event: (event: YCodingEvent) => void
  resync: () => void
  schedule?: (callback: () => void) => () => void
}) {
  let alive = true
  let cancel: (() => void) | undefined
  let resyncScope: readonly [number, number] | undefined
  const pending = new Map<string, readonly unknown[]>()
  const running = new Map<string, readonly unknown[]>()
  const schedule = input.schedule ?? ((callback: () => void) => { const timer = setTimeout(callback, 32); return () => clearTimeout(timer) })
  const current = (key: readonly unknown[]) => key[1] === input.scope()[0] && key[2] === input.scope()[1]
  const prefix = (parent: readonly unknown[], child: readonly unknown[]) => parent.length <= child.length && parent.every((part, index) => part === child[index])
  const add = (key: readonly unknown[]) => {
    for (const [id, queued] of pending) {
      if (prefix(queued, key)) return
      if (prefix(key, queued)) pending.delete(id)
    }
    pending.set(JSON.stringify(key), key)
  }
  const requestDrain = () => { if (alive && !cancel) cancel = schedule(drain) }
  const drain = () => {
    cancel = undefined
    if (!alive) return
    const resync = resyncScope
    resyncScope = undefined
    if (resync?.[0] === input.scope()[0] && resync[1] === input.scope()[1]) {
      for (const query of input.queries.getQueryCache().getAll()) if (current(query.queryKey)) add(query.queryKey.slice(0, 3))
    }
    for (const [id, key] of pending) {
      if (!current(key)) { pending.delete(id); continue }
      if ([...running.values()].some((active) => prefix(active, key) || prefix(key, active))) continue
      const reads = input.queries.getQueryCache().findAll({ queryKey: key, type: "active" }).filter((query) => query.state.fetchStatus === "fetching").flatMap((query) => { const promise = query.promise; return promise ? [promise] : [] })
      if (reads.length) {
        running.set(id, key)
        void Promise.allSettled(reads).then(() => { running.delete(id); requestDrain() })
        continue
      }
      pending.delete(id)
      running.set(id, key)
      const finished = () => { running.delete(id); if (pending.size) requestDrain() }
      void input.queries.invalidateQueries({ queryKey: key }, { cancelRefetch: false }).then(finished, finished)
    }
  }
  const refresh = (queryKey: readonly unknown[]) => { add(queryKey); requestDrain() }
  const events = input.source.onEvent((event) => {
    if (!alive || input.accept?.(event) === false) return
    input.event(event)
    const type: string = event.type
    const fragment = /\.(delta|progress)$/.test(type)
    const terminal = type === "session.idle" || /^session\.execution\.(succeeded|failed|interrupted)$/.test(type)
    if (type === "session.task.updated" || type.startsWith("session.shell.") || type.startsWith("shell.")) refresh(["activity", ...input.scope()])
    if (type.startsWith("session.") && !fragment) refresh(["sessions", ...input.scope()])
    const sessionID = eventSessionID(event)
    if (sessionID && type.startsWith("session.") && !fragment) refresh(["session", ...input.scope(), sessionID])
    if (sessionID) refresh(["messages", ...input.scope(), sessionID])
    if (sessionID && !fragment) refresh(["pendingInputs", ...input.scope(), sessionID])
    if (sessionID && type.startsWith("session.") && !fragment) refresh(["sessionInsights", ...input.scope(), sessionID])
    if (sessionID && (terminal || type === "session.file-change.recorded" || type.startsWith("session.revert.") || type === "session.deleted")) refresh(["fileChanges", ...input.scope(), sessionID])
    if (sessionID && (type.startsWith("session.autonomy.") || type.startsWith("session.goal."))) refresh(["autonomy", ...input.scope(), sessionID])
    if (sessionID && (/^(permission|form|question|guardrail)\.|^session\.(review|guardrail)\./.test(type) || terminal)) {
      const key = ["requests", ...input.scope()]
      if (type.startsWith("session.review.")) refresh(key)
      else {
        refresh([...key, sessionID])
        const details: unknown = "data" in event ? event.data : undefined
        if (details && typeof details === "object") {
          if ("rootSessionID" in details && typeof details.rootSessionID === "string") refresh([...key, details.rootSessionID])
          if ("reviewSessionID" in details && typeof details.reviewSessionID === "string") refresh([...key, details.reviewSessionID])
        }
      }
    }
  })
  const resync = input.source.onResync(() => { if (!alive) return; input.resync(); resyncScope = input.scope(); requestDrain() })
  return { dispose() { alive = false; cancel?.(); cancel = undefined; pending.clear(); resyncScope = undefined; events(); resync() } }
}
