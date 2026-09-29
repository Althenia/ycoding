import { expect, test } from "bun:test"
import { createLocalServer } from "../src/remote-local"

test("goal text outlives the ordinary local request deadline without extending unrelated autonomy writes", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    await Bun.sleep(70)
    return Response.json({ data: { mode: "goal", yolo: 0, goal: { text: "Ship", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } })
  } })
  try {
    const local = createLocalServer({ url: `http://127.0.0.1:${server.port}` }, { timeoutMs: 30 })
    await expect(local.autonomySet("ses_a", { directory: "/work" }, { yolo: 1 })).rejects.toThrow()
    expect(await local.autonomySet("ses_a", { directory: "/work" }, { goal: "Ship" })).toMatchObject({ goal: { status: "active" } })
    expect(await local.autonomySet("ses_a", { directory: "/work" }, { yolo: 1, goal: "Ship" })).toMatchObject({ goal: { status: "active" } })
  } finally { server.stop(true) }
})
