import type { LocationRef, SessionAutonomyState } from "@ycoding-ai/client"
import type { TuiAttentionNotifyInput, TuiAttentionSoundName } from "../../plugin/host-api"
import { Plugin } from "@ycoding-ai/plugin/tui"

const id = "internal:notifications"
const CHECKPOINT_MS = 500

type Schedule = (delay: number, run: () => Promise<void>) => () => void
type RequestKind = "form" | "question" | "permission" | "guardrail"
type RequestEpisode = {
  readonly key: string
  readonly kind: RequestKind
  readonly id: string
  readonly sessionID: string
  readonly title?: string
  readonly location?: LocationRef
  state: "scheduled" | "querying" | "failed" | "notified"
  cancel?: () => void
  controller?: AbortController
}
type TerminalEpisode = {
  readonly sessionID: string
  readonly initial: Promise<SessionAutonomyState | undefined>
  state: "active" | "waiting" | "terminal"
  controller?: AbortController
}

function schedule(delay: number, run: () => Promise<void>) {
  const timer = setTimeout(() => void run().catch(() => {}), delay)
  return () => clearTimeout(timer)
}

export function createNotifications(scheduleAttention: Schedule = schedule) {
  return Plugin.define({
    id,
    setup(context) {
      let disposed = false
      const requests = new Map<string, RequestEpisode>()
      const terminals = new Map<string, TerminalEpisode>()

      function requestKey(kind: RequestKind, sessionID: string, requestID: string, location?: LocationRef) {
        if (sessionID !== "global") return `${kind}:${sessionID}:${requestID}`
        return `${kind}:${sessionID}:${requestID}:${location?.directory ?? ""}:${location?.workspaceID ?? ""}`
      }

      function send(input: TuiAttentionNotifyInput, current: () => boolean) {
        if (disposed || !current()) return
        void context.attention.notify(input).catch(() => {})
      }

      function removeRequest(episode: RequestEpisode) {
        episode.cancel?.()
        episode.controller?.abort()
        if (requests.get(episode.key) === episode) requests.delete(episode.key)
      }

      function clearRequest(kind: RequestKind, sessionID: string, requestID: string, location?: LocationRef) {
        const key = requestKey(kind, sessionID, requestID, location)
        const exact = requests.get(key)
        if (exact) removeRequest(exact)
        if (sessionID !== "global" || location) return
        Array.from(requests.values())
          .filter((episode) => episode.kind === kind && episode.sessionID === sessionID && episode.id === requestID)
          .forEach(removeRequest)
      }

      async function pending(episode: RequestEpisode, signal: AbortSignal) {
        if (episode.kind === "form") {
          if (episode.sessionID !== "global") {
            const list = await context.client.form.list({ sessionID: episode.sessionID }, { signal })
            return list.some((item) => item.id === episode.id)
          }
          if (!episode.location) return false
          const response = await context.client.form.request.list(
            {
              location: {
                directory: episode.location.directory,
                workspace: episode.location.workspaceID,
              },
            },
            { signal },
          )
          return response.data.some((item) => item.id === episode.id && item.sessionID === episode.sessionID)
        }
        if (episode.kind === "question") {
          const list = await context.client.question.list({ sessionID: episode.sessionID }, { signal })
          return list.some((item) => item.id === episode.id)
        }
        if (episode.kind === "guardrail") {
          const list = await context.client.guardrail.request.list({ sessionID: episode.sessionID }, { signal })
          return list.some((item) => item.id === episode.id)
        }
        const list = await context.client.permission.list({ sessionID: episode.sessionID }, { signal })
        return list.some((item) => item.id === episode.id)
      }

      function requestNotification(episode: RequestEpisode): TuiAttentionNotifyInput {
        const session = context.data.session.get(episode.sessionID)
        const message =
          episode.kind === "form"
            ? "Input needs response"
            : episode.kind === "question"
              ? "Question needs input"
              : episode.kind === "guardrail"
                ? "Guardrail approval needed"
              : "Permission needs input"
        const sound: TuiAttentionSoundName =
          episode.kind === "permission" || episode.kind === "guardrail" ? "permission" : "question"
        return {
          title: episode.title ?? session?.title,
          message,
          notification: session?.parentID ? false : { when: "blurred" },
          sound: { name: sound, when: "always" },
        }
      }

      async function confirmRequest(episode: RequestEpisode) {
        if (disposed || requests.get(episode.key) !== episode || episode.state !== "scheduled") return
        episode.cancel = undefined
        episode.state = "querying"
        const controller = new AbortController()
        episode.controller = controller
        const remains = await pending(episode, controller.signal).then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        )
        if (disposed || requests.get(episode.key) !== episode || episode.controller !== controller) return
        episode.controller = undefined
        if (!remains.ok) {
          if (!controller.signal.aborted) episode.state = "failed"
          return
        }
        if (!remains.value) {
          requests.delete(episode.key)
          return
        }
        episode.state = "notified"
        send(requestNotification(episode), () => requests.get(episode.key) === episode && episode.state === "notified")
      }

      function addRequest(input: Omit<RequestEpisode, "key" | "state">) {
        const key = requestKey(input.kind, input.sessionID, input.id, input.location)
        if (requests.has(key)) return
        const episode: RequestEpisode = { ...input, key, state: "scheduled" }
        requests.set(key, episode)
        episode.cancel = scheduleAttention(CHECKPOINT_MS, () => confirmRequest(episode))
      }

      async function resolveSession(sessionID: string, signal: AbortSignal) {
        const cached = context.data.session.get(sessionID)
        if (cached) return cached
        return context.client.session.get({ sessionID }, { signal }).catch(() => undefined)
      }

      function createTerminal(sessionID: string) {
        const episode: TerminalEpisode = {
          sessionID,
          initial: context.client.session.autonomy.get({ sessionID }).catch(() => undefined),
          state: "active",
        }
        terminals.set(sessionID, episode)
        return episode
      }

      function stopTerminal(episode: TerminalEpisode) {
        episode.controller?.abort()
        episode.controller = undefined
        episode.state = "terminal"
      }

      function goalNotification(state: SessionAutonomyState): Pick<TuiAttentionNotifyInput, "message" | "sound"> {
        const status = state.goal?.status
        if (status === "completed") return { message: "Session done", sound: { name: "done", when: "always" } }
        if (status === "stopped") return { message: "Goal stopped", sound: { name: "error", when: "always" } }
        if (status === "exhausted") return { message: "Goal exhausted", sound: { name: "error", when: "always" } }
        if (status === "active") return { message: "Goal is still active", sound: { name: "error", when: "always" } }
        return { message: "Goal state missing", sound: { name: "error", when: "always" } }
      }

      async function finishTerminal(episode: TerminalEpisode, controller: AbortController) {
        const waited = await context.client.session
          .wait({ sessionID: episode.sessionID }, { signal: controller.signal })
          .then(
            () => true,
            () => false,
          )
        if (!waited || disposed || terminals.get(episode.sessionID) !== episode || episode.controller !== controller)
          return
        const [session, initial, final] = await Promise.all([
          resolveSession(episode.sessionID, controller.signal),
          episode.initial,
          context.client.session.autonomy
            .get({ sessionID: episode.sessionID }, { signal: controller.signal })
            .catch(() => undefined),
        ])
        if (disposed || terminals.get(episode.sessionID) !== episode || episode.controller !== controller) return
        episode.controller = undefined
        episode.state = "terminal"
        if (!session || !initial || !final) return
        const output =
          session.parentID
            ? { message: "Session done", sound: { name: "subagent_done" as const, when: "always" as const } }
            : initial.goal !== undefined
            ? goalNotification(final)
            : { message: "Session done", sound: { name: "done" as const, when: "always" as const } }
        send(
          {
            title: session.title,
            message: output.message,
            notification: session.parentID ? false : { when: "blurred" },
            sound: output.sound,
          },
          () => terminals.get(episode.sessionID) === episode && episode.state === "terminal",
        )
      }

      function succeed(sessionID: string) {
        const episode = terminals.get(sessionID) ?? createTerminal(sessionID)
        if (episode.state !== "active") return
        const controller = new AbortController()
        episode.controller = controller
        episode.state = "waiting"
        void finishTerminal(episode, controller)
      }

      async function fail(episode: TerminalEpisode, message: string) {
        const sessionID = episode.sessionID
        stopTerminal(episode)
        const controller = new AbortController()
        const session = await resolveSession(sessionID, controller.signal)
        if (!session || session.parentID || disposed || terminals.get(sessionID) !== episode) return
        send(
          {
            title: session.title,
            message,
            notification: { when: "blurred" },
            sound: { name: "error", when: "always" },
          },
          () => terminals.get(sessionID) === episode && episode.state === "terminal",
        )
      }

      const cleanups = [
        context.data.on("form.created", (event) =>
          addRequest({
            kind: "form",
            id: event.data.form.id,
            sessionID: event.data.form.sessionID,
            title: event.data.form.title,
            location: event.location,
          }),
        ),
        context.data.on("form.replied", (event) =>
          clearRequest("form", event.data.sessionID, event.data.id, event.location),
        ),
        context.data.on("form.cancelled", (event) =>
          clearRequest("form", event.data.sessionID, event.data.id, event.location),
        ),
        context.data.on("question.v2.asked", (event) =>
          addRequest({ kind: "question", id: event.data.id, sessionID: event.data.sessionID }),
        ),
        context.data.on("question.v2.replied", (event) =>
          clearRequest("question", event.data.sessionID, event.data.requestID),
        ),
        context.data.on("question.v2.rejected", (event) =>
          clearRequest("question", event.data.sessionID, event.data.requestID),
        ),
        context.data.on("permission.v2.asked", (event) =>
          addRequest({ kind: "permission", id: event.data.id, sessionID: event.data.sessionID }),
        ),
        context.data.on("permission.v2.replied", (event) =>
          clearRequest("permission", event.data.sessionID, event.data.requestID),
        ),
        context.data.on("guardrail.asked", (event) =>
          addRequest({
            kind: "guardrail",
            id: event.data.id,
            sessionID: event.data.rootSessionID,
          }),
        ),
        context.data.on("guardrail.replied", (event) =>
          clearRequest("guardrail", event.data.rootSessionID, event.data.requestID),
        ),
        context.data.on("session.execution.started", (event) => {
          const current = terminals.get(event.data.sessionID)
          if (current?.state === "active" || current?.state === "waiting") return
          createTerminal(event.data.sessionID)
        }),
        context.data.on("session.execution.succeeded", (event) => succeed(event.data.sessionID)),
        context.data.on("session.execution.failed", (event) => {
          const current = terminals.get(event.data.sessionID)
          if (current?.state === "terminal") return
          void fail(current ?? createTerminal(event.data.sessionID), event.data.error.message)
        }),
        context.data.on("session.execution.interrupted", (event) => {
          const current = terminals.get(event.data.sessionID)
          if (current?.state === "terminal") return
          const episode = current ?? createTerminal(event.data.sessionID)
          stopTerminal(episode)
          if (event.data.reason === "shutdown") void fail(episode, "Session interrupted")
        }),
      ]

      return () => {
        if (disposed) return
        disposed = true
        cleanups.forEach((cleanup) => cleanup())
        Array.from(requests.values()).forEach(removeRequest)
        requests.clear()
        Array.from(terminals.values()).forEach(stopTerminal)
        terminals.clear()
      }
    },
  })
}

export default createNotifications()
