import { expect, test } from "bun:test"
import { createLocalServer } from "../src/remote-local"

test("goal text outlives the ordinary local request deadline without extending unrelated autonomy writes", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let goals = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body: unknown = await request.json()
    if (typeof body === "object" && body !== null && "goal" in body) {
      goals++
      if (goals === 2) started.resolve()
    }
    await release.promise
    return Response.json({ data: { mode: "goal", yolo: 0, goal: { text: "Ship", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } })
  } })
  try {
    const local = createLocalServer({ url: `http://127.0.0.1:${server.port}` }, { timeoutMs: 30 })
    const setting = Promise.allSettled([
      local.autonomySet("ses_a", { directory: "/work" }, { goal: "Ship" }),
      local.autonomySet("ses_a", { directory: "/work" }, { yolo: 1, goal: "Ship" }),
    ])
    await started.promise
    expect(await Promise.allSettled([local.autonomySet("ses_a", { directory: "/work" }, { yolo: 1 })])).toMatchObject([
      { status: "rejected", reason: { kind: "transport" } },
    ])
    release.resolve()
    expect(await setting).toMatchObject([
      { status: "fulfilled", value: { goal: { status: "active" } } },
      { status: "fulfilled", value: { goal: { status: "active" } } },
    ])
  } finally { release.resolve(); await server.stop(true) }
})
