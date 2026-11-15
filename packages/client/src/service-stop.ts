import type { Endpoint, StopOptions } from "./service"

export function assertStopTarget(expected: StopOptions["expected"], current: { endpoint: Endpoint; info: { pid: number } } | undefined) {
  if (expected === undefined) return
  if (!current || !Number.isSafeInteger(expected.pid) || expected.pid < 1 || current.info.pid !== expected.pid || new URL(current.endpoint.url).href !== new URL(expected.url).href || current.endpoint.auth?.type !== expected.auth?.type || current.endpoint.auth?.username !== expected.auth?.username || current.endpoint.auth?.password !== expected.auth?.password)
    throw new Error("The registered service changed before it could be stopped")
}
