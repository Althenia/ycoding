import { expect, test } from "bun:test"
import { createLocalServer } from "../src/remote-local"

test("manual compaction forwards its stable ID and backend placement, outlives ordinary reads, and reports failed settlement", async () => {
  const requests: { path: string; directory: string | null; workspace: string | null; body: unknown }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { id: string }
    requests.push({ path: new URL(request.url).pathname, directory: request.headers.get("x-ycoding-directory"), workspace: request.headers.get("x-ycoding-workspace"), body })
    await Bun.sleep(70)
    return Response.json({ data: { id: body.id, sessionID: "ses_a", trigger: "manual", status: body.id === "cmp_failure" ? "failed" : "ended",
      requestedThrough: { messageID: "msg_1", seq: 1 }, timeCreated: 100, ...(body.id === "cmp_failure" ? { failure: "provider_failed" } : {}) } })
  } })
  try {
    const local = createLocalServer({ url: `http://127.0.0.1:${server.port}` }, { timeoutMs: 30 })
    const location = { directory: "/work/selected repository", workspaceID: "wsp_local" }
    expect(await local.compact("ses_a", location, "cmp_success")).toMatchObject({ id: "cmp_success", status: "ended" })
    expect(requests[0]).toEqual({ path: "/api/session/ses_a/compact", directory: encodeURIComponent(location.directory), workspace: "wsp_local", body: { id: "cmp_success" } })
    await expect(local.compact("ses_a", location, "cmp_failure")).rejects.toThrow("Compaction failed: provider_failed")
    expect(requests.map((request) => request.body)).toEqual([{ id: "cmp_success" }, { id: "cmp_failure" }])
  } finally { server.stop(true) }
})
