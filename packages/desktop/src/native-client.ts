import { YCoding, type YCodingEvent } from "@ycoding-ai/client"
import { headers, type Endpoint } from "@ycoding-ai/client/service"
import { describeError } from "./app-log"
import { DesktopError } from "./contract"

type Health = Awaited<ReturnType<ReturnType<typeof YCoding.make>["health"]["get"]>>
type Options = {
  readonly signal: AbortSignal
  readonly fetch?: typeof globalThis.fetch
  readonly version?: string
  readonly log?: (line: string) => void
  readonly onEvent?: (event: YCodingEvent) => void | Promise<void>
  readonly onStatus?: (status: { readonly status: "connected"; readonly health: Health } | { readonly status: "reconnecting" }) => void
  readonly reconnect?: (signal: AbortSignal) => Promise<Endpoint>
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000]

export async function connectNative(endpoint: Endpoint, options: Options) {
  const lifetime = new AbortController()
  const abort = () => lifetime.abort(options.signal.reason)
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) abort()
  let api = YCoding.make({ baseUrl: endpoint.url, headers: headers(endpoint), ...(options.fetch ? { fetch: options.fetch } : {}) })
  let current: Health | undefined
  const ready = Promise.withResolvers<void>()
  let established = false
  const delays = RECONNECT_DELAYS_MS
  let attempt = 0
  const task = (async () => {
    while (!lifetime.signal.aborted) {
      const request = new AbortController()
      const cancel = () => request.abort(lifetime.signal.reason)
      lifetime.signal.addEventListener("abort", cancel, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        let next = api
        if (established && options.reconnect) {
          const moved = await options.reconnect(request.signal)
          next = YCoding.make({ baseUrl: moved.url, headers: headers(moved), ...(options.fetch ? { fetch: options.fetch } : {}) })
        }
        const health = await next.health.get({ signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]) })
        if (health.healthy !== true || !Number.isSafeInteger(health.pid) || health.pid <= 0 || typeof health.sourceEpoch !== "string" || typeof health.version !== "string")
          throw new Error("The native backend returned an invalid health response.")
        if (options.version !== undefined && health.version !== options.version) throw new DesktopError("The bundled backend version does not match this desktop app.")
        timer = setTimeout(() => request.abort(new Error("Timed out waiting for server.connected.")), 2_000)
        const iterator = next.event.subscribe({ signal: request.signal })[Symbol.asyncIterator]()
        const first = await iterator.next()
        if (first.done || first.value.type !== "server.connected") throw new DesktopError("The native event stream did not start with server.connected.")
        clearTimeout(timer)
        if (lifetime.signal.aborted) break
        established = true
        attempt = 0
        api = next
        current = health
        await options.onEvent?.(first.value)
        options.onStatus?.({ status: "connected", health })
        ready.resolve()
        while (!lifetime.signal.aborted) {
          const next = await iterator.next()
          if (next.done) throw new Error("The native event stream disconnected.")
          if (!lifetime.signal.aborted) await options.onEvent?.(next.value)
        }
      } catch (error) {
        if (!established && !(error instanceof DesktopError) && !lifetime.signal.aborted) options.log?.(`Native backend connection error: ${describeError(error)}`)
        if (!established) {
          ready.reject(error instanceof DesktopError ? error : new DesktopError("Could not establish native backend health and events. Check the endpoint and retry."))
          return
        }
        if (!lifetime.signal.aborted) options.onStatus?.({ status: "reconnecting" })
      } finally {
        clearTimeout(timer)
        request.abort()
        lifetime.signal.removeEventListener("abort", cancel)
      }
      if (!lifetime.signal.aborted) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener("abort", done); resolve() }
        timer = setTimeout(done, delays[Math.min(attempt++, delays.length - 1)])
        lifetime.signal.addEventListener("abort", done, { once: true })
      })
    }
    ready.reject(new DesktopError("Native backend connection was cancelled."))
  })()
  const close = async () => {
    lifetime.abort()
    options.signal.removeEventListener("abort", abort)
    await task
  }
  try {
    await ready.promise
    return { get api() { return api }, get health() { return current! }, close }
  } catch (error) {
    await close()
    throw error
  }
}
