import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "../test/relay-double"

test("a timed-out catalog remains retryable and overlapping refreshes share one fresh read", async () => {
  const gate = Promise.withResolvers<void>()
  let catalogs = 0
  const relay = await startRelayDouble({
    handler: async (request) => {
      if (request.operation !== "catalog.get") return "default"
      if (++catalogs === 1) return "silent"
      await gate.promise
      return { ok: true, value: { agents: [], models: [], commands: [], skills: [], references: [], resources: [] } }
    },
  })
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({
        url: relay.wsURL(deviceID),
        handlers,
        createSocket: relay.createSocket,
        requestTimeoutMs: 200,
      }),
  })
  try {
    await store.load()
    await waitFor(() => store.state().connection.kind === "connected" && store.state().transport.kind === "open")
    await store.loadCatalog({ sessionID: "ses_1" })
    expect(store.state().catalogs["session:ses_1"]).toMatchObject({
      status: "error",
      message: "Catalog: The request did not settle",
    })
    const retries = Array.from({ length: 3 }, () => store.loadCatalog({ sessionID: "ses_1" }, { refresh: true }))
    await waitFor(() => catalogs === 2)
    gate.resolve()
    await Promise.all(retries)
    expect(catalogs).toBe(2)
    expect(store.state().catalogs["session:ses_1"]?.status).toBe("ready")
    await store.loadCatalog({ sessionID: "ses_1" })
    expect(catalogs).toBe(2)
  } finally {
    gate.resolve()
    store.dispose()
    await relay.stop()
  }
}, 10_000)
