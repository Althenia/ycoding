import { resendUnsent, V5ClientError, type V5Client, type EventSubscribeOutput } from "@ycoding-ai/client/v5"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { errorMessage } from "../util/error"
import { createSimpleContext } from "./helper"
import { useLog } from "./log"

export type ClientConnectionStatus = "connected" | "connecting" | "reconnecting"
export type ClientConnectionEvent = {
  readonly type: "client.connection"
  readonly created: number
  readonly data: {
    readonly status: "connecting" | "connected" | "disconnected" | "reconnecting"
    readonly attempt: number
    readonly error?: string
  }
}

type ManagedService = {
  reconnect: (signal: AbortSignal) => Promise<{ api: V5Client; baseUrl?: string }>
  restart: () => Promise<void>
}

type ClientEventMap = { [Type in EventSubscribeOutput["type"]]: Extract<EventSubscribeOutput, { type: Type }> }
const connectTimeout = 2_000
const resendTimeout = 10_000
const connectionHistoryLimit = 50

export const { use: useClient, provider: ClientProvider } = createSimpleContext({
  name: "Client",
  init: (props: { api: V5Client; baseUrl?: string; service?: ManagedService }) => {
    const log = useLog({ component: "client" })
    const abort = new AbortController()
    const history: ClientConnectionEvent[] = []
    let api = props.api
    let baseUrl = props.baseUrl
    const events = createGlobalEmitter<ClientEventMap>()
    const filters = new Set<(event: EventSubscribeOutput) => boolean>()
    const [connection, setConnection] = createStore<{
      status: ClientConnectionStatus
      attempt: number
      error?: string
    }>({
      status: "connecting",
      attempt: 0,
    })
    let stream: AbortController | undefined
    const reconnectWaiters = new Set<() => void>()
    const usable = () => connection.status === "connected" && api.transport.state !== "closed"
    const reconnected = (signal?: AbortSignal) =>
      usable()
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const settle = (done: () => void) => {
              clearTimeout(timer)
              signal?.removeEventListener("abort", cancel)
              reconnectWaiters.delete(check)
              done()
            }
            const check = () => {
              if (usable()) settle(resolve)
            }
            const cancel = () => settle(() => reject(signal?.reason))
            const timer = setTimeout(() => settle(() => reject(new Error("Timed out waiting for the server connection"))), resendTimeout)
            signal?.addEventListener("abort", cancel, { once: true })
            reconnectWaiters.add(check)
          })
    const resilient = resendUnsent(() => api, {
      reconnected,
      revision: (client) => client.transport.sourceEpoch,
      admit: ({ issuedRevision, target }) =>
        issuedRevision !== undefined && target === api && usable() && target.transport.sourceEpoch === issuedRevision,
    })

    function record(status: ClientConnectionEvent["data"]["status"], attempt: number, error?: string) {
      history.push({ type: "client.connection", created: Date.now(), data: { status, attempt, error } })
      if (history.length > connectionHistoryLimit) history.shift()
    }

    function start() {
      stream?.abort()
      const controller = new AbortController()
      stream = controller
      void (async () => {
        let attempt = 0
        while (!abort.signal.aborted && !controller.signal.aborted) {
          let connectedAt: number | undefined
          const request = new AbortController()
          const cancel = () => request.abort(controller.signal.reason)
          const timeout = setTimeout(() => request.abort(new Error("Timed out connecting to server")), connectTimeout)
          controller.signal.addEventListener("abort", cancel, { once: true })
          const error = await (async () => {
            record(attempt === 0 ? "connecting" : "reconnecting", attempt)
            log.info("event stream connecting", { attempt })
            const iterator = api.event.subscribe({ signal: request.signal })[Symbol.asyncIterator]()
            const first = await iterator.next()
            if (abort.signal.aborted || controller.signal.aborted) return undefined
            if (first.done)
              return request.signal.reason instanceof Error
                ? request.signal.reason
                : new Error("Event stream disconnected")
            if (first.value.type !== "server.connected")
              return new Error("Event stream did not start with server.connected")
            clearTimeout(timeout)
            record("connected", attempt)
            connectedAt = Date.now()
            log.info("event stream connected")
            events.emit(first.value.type, first.value)
            setConnection({ status: "connected", attempt: 0, error: undefined })
            reconnectWaiters.forEach((check) => check())
            while (!abort.signal.aborted && !controller.signal.aborted) {
              const event = await iterator.next()
              if (abort.signal.aborted || controller.signal.aborted) return undefined
              if (event.done) return new Error("Event stream disconnected")
              if ("durable" in event.value)
                log.debug("event", {
                  type: event.value.type,
                  aggregateID: event.value.durable.aggregateID,
                  seq: event.value.durable.seq,
                })
              if ([...filters].every((accept) => accept(event.value))) events.emit(event.value.type, event.value)
            }
            return undefined
          })()
            .catch((error) => error)
            .finally(() => {
              request.abort()
              clearTimeout(timeout)
              controller.signal.removeEventListener("abort", cancel)
            })
          if (abort.signal.aborted || controller.signal.aborted) return
          if (connectedAt !== undefined && Date.now() - connectedAt >= 1_000) attempt = 0
          attempt += 1
          const message = errorMessage(error)
          record("disconnected", attempt, message)
          log.info("event stream disconnected", {
            attempt,
            error: message,
          })
          setConnection({ status: "reconnecting", attempt, error: message })
          if (error instanceof V5ClientError && error.status === "resync") {
            if (attempt > 1) await wait(1_000, controller.signal)
            continue
          }
          let replaced = false
          if (props.service) {
            const next = await props.service.reconnect(controller.signal).catch((error) => {
              if (!controller.signal.aborted)
                log.info("server resolution failed", {
                  attempt,
                  error: errorMessage(error),
                })
            })
            if (abort.signal.aborted || controller.signal.aborted) {
              next?.api.transport.close()
              return
            }
            if (next) {
              if (api !== next.api) api.transport.close()
              replaced = api !== next.api
              api = next.api
              baseUrl = next.baseUrl ?? baseUrl
              if (attempt === 1 && replaced) continue
            }
          }
          await wait(1_000, controller.signal)
          if (!replaced && !abort.signal.aborted && !controller.signal.aborted)
            await api.transport.reconnect().catch((error) => {
              log.info("server reconnection failed", { attempt, error: errorMessage(error) })
            })
        }
      })()
    }

    onMount(start)
    onCleanup(() => {
      abort.abort()
      stream?.abort()
      api.transport.close()
      events.clear()
    })

    return {
      get api() {
        return resilient
      },
      baseUrl() {
        return baseUrl
      },
      event: {
        on: events.on,
        listen: events.listen,
        filter(accept: (event: EventSubscribeOutput) => boolean) {
          filters.add(accept)
          return () => { filters.delete(accept) }
        },
      },
      connection: {
        status() {
          return connection.status
        },
        attempt() {
          return connection.attempt
        },
        error() {
          return connection.error
        },
        internal: {
          history() {
            return history.slice()
          },
        },
      },
      restart: props.service?.restart,
    }
  },
})

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
