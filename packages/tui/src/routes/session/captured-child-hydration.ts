import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { errorMessage } from "../../util/error"

type ReadState = { status: "loading" | "ready" | "failed"; error?: string }

export function createCapturedChildHydration(input: {
  sessionID: () => string
  parentID: () => string | undefined
  dispatched: () => string
}) {
  const client = useClient()
  const data = useData()
  const [state, setState] = createSignal<{
    ids: string[]
    membership: ReadState
    reads: Record<string, ReadState>
  }>({ ids: [], membership: { status: "ready" }, reads: {} })
  let retry: (children?: readonly string[]) => void = () => {}
  const ownedChildren = new Set<string>()
  onCleanup(() => ownedChildren.forEach((id) => data.session.message.evict(id)))
  let ownerSessionID: string | undefined
  let ownerConnected = false

  createEffect(
    on(
      [input.sessionID, input.parentID, () => client.connection.status(), input.dispatched],
      ([sessionID, parentID, status, dispatched]) => {
        let active = true
        let membershipRequest: Promise<void> | undefined
        const children = dispatched ? dispatched.split(",") : []
        const ids =
          ownerSessionID === sessionID && !parentID ? state().ids.filter((childID) => children.includes(childID)) : []
        const reads = Object.fromEntries(
          (ownerConnected && status === "connected" ? ids : []).flatMap((childID) =>
            state().reads[childID]?.status === "ready" ? [[childID, state().reads[childID]]] : [],
          ),
        )
        ownerSessionID = sessionID
        ownerConnected = status === "connected"
        setState({ ids, membership: { status: children.length > 0 && !parentID ? "loading" : "ready" }, reads })
        retry = () => {}
        onCleanup(() => {
          active = false
          retry = () => {}
        })
        if (parentID || status !== "connected" || children.length === 0) return

        function read(childID: string, older = false) {
          if (!active || state().reads[childID]?.status === "loading") return Promise.resolve()
          ownedChildren.add(childID)
          setState((current) => ({ ...current, reads: { ...current.reads, [childID]: { status: "loading" } } }))
          return (older ? data.session.message.loadOlder(childID) : data.session.message.sync(childID)).then(
            () => {
              if (active)
                setState((current) => ({ ...current, reads: { ...current.reads, [childID]: { status: "ready" } } }))
            },
            (error: unknown) => {
              if (active)
                setState((current) => ({
                  ...current,
                  reads: { ...current.reads, [childID]: { status: "failed", error: errorMessage(error) } },
                }))
            },
          )
        }

        function membership() {
          if (!active || membershipRequest) return
          setState((current) => ({ ...current, membership: { status: "loading" } }))
          membershipRequest = data.session.subagent
            .children(sessionID)
            .then(
              (tasks) => {
                if (!active) return
                const family = new Set(tasks.map((task) => task.sessionID))
                const ids = children.filter((childID) => family.has(childID))
                setState((current) => ({ ...current, ids, membership: { status: "ready" } }))
                ids.forEach((id) => void read(id))
              },
              (error: unknown) => {
                if (active)
                  setState((current) => ({ ...current, membership: { status: "failed", error: errorMessage(error) } }))
              },
            )
            .finally(() => {
              membershipRequest = undefined
            })
        }

        retry = (requested = children) => {
          if (!active || !requested.some((childID) => children.includes(childID))) return
          if (state().membership.status === "failed") return membership()
          requested
            .filter((childID) => state().ids.includes(childID) && state().reads[childID]?.status === "failed")
            .forEach((id) => void read(id, data.session.message.history(id)?.failedRead === "older"))
        }
        membership()
      },
    ),
  )

  onCleanup(data.on("session.task.updated", (event) => retry([event.data.sessionID])))

  return {
    ids: () => state().ids,
    retry: (children?: readonly string[]) => retry(children),
    status(children: readonly string[]) {
      if (children.length === 0) return undefined
      const current = state()
      const complete = children.every(
        (childID) => current.ids.includes(childID) && current.reads[childID]?.status === "ready",
      )
      if (!complete && current.membership.status === "loading") return { loading: true, failed: 0, error: undefined }
      if (!complete && current.membership.status === "failed")
        return { loading: false, failed: 0, error: current.membership.error }
      const reads = children.filter((childID) => current.ids.includes(childID)).map((childID) => current.reads[childID])
      const failed = reads.filter((read) => read?.status === "failed")
      const loading = reads.some((read) => !read || read.status === "loading")
      const partial = children.some((id) => !!data.session.message.history(id)?.before)
      return loading || failed.length > 0 || partial
        ? { loading, failed: failed.length, error: failed.map((read) => read?.error).join("; ") || undefined }
        : undefined
    },
  }
}
