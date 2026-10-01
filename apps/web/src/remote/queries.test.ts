import { describe, expect, test } from "bun:test"
import { keepAwakeState, usageRead } from "./queries"

type View<T> = { status: "pending" | "error" | "success"; fetchStatus: "fetching" | "paused" | "idle"; data: T | undefined; error: Error | null }

const pending = <T>(fetchStatus: View<T>["fetchStatus"]) => new Proxy({ status: "pending", fetchStatus, error: null } as View<T>, {
  get(target, property) {
    if (property === "data") throw new Error("A pending read suspends the route panel")
    return Reflect.get(target, property)
  },
})

describe("query read helpers", () => {
  test("usage reads describe a pending query without reading its data", () => {
    expect(usageRead(pending("fetching"))).toEqual({ status: "loading" })
    expect(usageRead(pending("idle"))).toEqual({ status: "idle" })
  })

  test("usage reads keep settled data while a refresh is in flight", () => {
    expect(usageRead({ status: "success", fetchStatus: "fetching", data: { status: "ready", data: 3 }, error: null })).toEqual({ status: "loading", data: 3 })
    expect(usageRead({ status: "error", fetchStatus: "idle", data: { status: "ready", data: 3 }, error: new Error("lost") })).toEqual({ status: "error", data: 3, message: "lost" })
    expect(usageRead({ status: "success", fetchStatus: "idle", data: { status: "unsupported" }, error: null })).toEqual({ status: "unsupported" })
  })

  test("keep-awake reads describe a pending query without reading its data", () => {
    expect(keepAwakeState(pending("fetching"))).toEqual({ read: "loading" })
    expect(keepAwakeState(pending("idle"))).toEqual({ read: "idle" })
  })

  test("keep-awake reads keep an unconfirmed change while the machine is read again", () => {
    const change = { state: "unknown" as const, enabled: true, message: "unconfirmed" }
    expect(keepAwakeState({ status: "success", fetchStatus: "fetching", data: { read: "error", message: "lost", change }, error: null })).toEqual({ read: "loading", change })
  })
})
