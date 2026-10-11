import { expect, test } from "bun:test"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteHttp } from "../src/remote/http"

test("a captured provider-auth scope cannot send secrets through a replacement machine connection", async () => {
  const calls: { deviceID: string; operation: string }[] = []
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport: (deviceID, handlers) => ({
    connect: () => handlers.onStatus?.({ kind: "open" }), close: () => {}, setPriority: () => {}, status: () => ({ kind: "open" }),
    request: async (operation) => { calls.push({ deviceID, operation }); return { status: "ok", value: { data: [] } } },
  }) })
  try {
    store.connect("dev_original")
    const old = { deviceID: "dev_original", generation: store.state().generation }
    store.connect("dev_replacement")
    expect(await store.link.request(old, "provider.auth.key", { input: { target: { sessionID: "ses_existing" }, integrationID: "test", label: "Work", key: "synthetic-secret" } })).toEqual({ status: "unavailable", reason: "not-connected" })
    expect(calls.some((call) => call.operation === "provider.auth.key")).toBe(false)
    expect(JSON.stringify(store.state())).not.toContain("synthetic-secret")
  } finally { store.dispose() }
})
