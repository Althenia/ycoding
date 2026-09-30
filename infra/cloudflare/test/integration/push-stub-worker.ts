import worker, { DeviceRelay } from "../../src/index"
import { inspectPushRequest, inspectPushResponse } from "./push-diagnostic"

declare const PUSH_STUB_PORT: number
declare const PUSH_SERVED_PUBLIC_KEY_HASH: string

const send = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(endpoint)
  if (url.hostname === "fcm.googleapis.com" && url.pathname === "/fcm/send/flow-local-only")
    return send(`http://127.0.0.1:${PUSH_STUB_PORT}/push`, init)
  if (url.hostname === "fcm.googleapis.com" && url.pathname.startsWith("/fcm/send/admin-local-")) {
    if (url.pathname.endsWith("-unreachable")) return Promise.reject(new Error("Synthetic push transport failure"))
    return send(`http://127.0.0.1:${PUSH_STUB_PORT}/push/${url.pathname.slice("/fcm/send/admin-local-".length)}`, init)
  }
  if (url.hostname !== "fcm.googleapis.com") return send(input, init)
  const inspection = await Promise.resolve().then(() => inspectPushRequest(endpoint,
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization"), PUSH_SERVED_PUBLIC_KEY_HASH)).catch(() => undefined)
  const outcome = await send(input, init).then((response) => ({ response }), (error: unknown) => ({ error }))
  if (inspection !== undefined) {
    const response = "response" in outcome ? outcome.response : undefined
    const providerCode = response === undefined ? "unreported" : await inspectPushResponse(response).catch(() => "unreported" as const)
    await send(`http://127.0.0.1:${PUSH_STUB_PORT}/push-diagnostic`, { method: "POST", signal: AbortSignal.timeout(2000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...inspection, ...(response === undefined ? {} : { status: response.status }), providerCode }) }).catch(() => undefined)
  }
  if ("error" in outcome) throw outcome.error
  return outcome.response
}

export { DeviceRelay }
export default worker
