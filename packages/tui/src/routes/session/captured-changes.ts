import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js"
import type { V5Client } from "@ycoding-ai/client/v5"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { errorMessage } from "../../util/error"

export function createCapturedChanges(input: {
  sessionID: () => string
  revision: () => string
  ready: () => boolean
}) {
  const client = useClient()
  const data = useData()
  const [state, setState] = createSignal<{
    groups: Awaited<ReturnType<V5Client["session"]["capturedChanges"]["list"]>>["data"]
    loading: boolean
    error?: string
  }>({ groups: [], loading: false })
  let refresh = () => {}
  let observedRevision: string | undefined

  createEffect(
    on([input.sessionID, () => client.connection.status(), input.ready], ([sessionID, status, ready]) => {
      let active = true
      let pending = false
      let dirty = false
      const controller = new AbortController()
      setState({ groups: [], loading: status === "connected" && ready })
      refresh = () => {
        if (!active || status !== "connected" || !ready) return
        if (pending) {
          dirty = true
          return
        }
        pending = true
        observedRevision = untrack(input.revision)
        setState((current) => ({ ...current, loading: true, error: undefined }))
        void (async () => {
          const groups: ReturnType<typeof state>["groups"] = []
          let cursor: string | undefined
          do {
            const page = await client.api.session.capturedChanges.list(
              { sessionID, cursor },
              { signal: controller.signal },
            )
            if (!active) return
            groups.push(...page.data)
            cursor = page.cursor?.next
          } while (cursor !== undefined)
          if (active) setState({ groups, loading: false })
        })()
          .catch((error) => {
            if (active) setState({ groups: [], loading: false, error: errorMessage(error) })
          })
          .finally(() => {
            pending = false
            if (!active || !dirty) return
            dirty = false
            refresh()
          })
      }
      refresh()
      onCleanup(() => {
        active = false
        controller.abort()
        refresh = () => {}
      })
    }),
  )
  createEffect(
    on(
      input.revision,
      (revision) => {
        if (revision !== observedRevision) refresh()
      },
      { defer: true },
    ),
  )
  onCleanup(data.on("session.tool.success", () => refresh()))
  onCleanup(data.on("session.task.updated", () => refresh()))
  return { state, retry: () => refresh() }
}
