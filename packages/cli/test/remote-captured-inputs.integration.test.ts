import { expect, test } from "bun:test"
import { createLocalServer } from "../src/remote-local"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import {
  createOperationCache,
  createSessionRegistry,
  createSubscriptions,
  executeRemoteOperation,
} from "../src/remote-operations"

test("local captured input reads page every canonical record without requesting complete messages", async () => {
  const records = Array.from({ length: 401 }, (_, index) => ({
    id: `msg_page_${index}`,
    type: "assistant" as const,
    content: [],
  }))
  const requests: { path: string; after: string | null; limit: string | null; directory: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      requests.push({
        path: url.pathname,
        after: url.searchParams.get("after"),
        limit: url.searchParams.get("limit"),
        directory: request.headers.get("x-ycoding-directory"),
      })
      const offset = url.searchParams.has("after") ? Number(url.searchParams.get("after")) + 1 : 0
      const end = offset + Number(url.searchParams.get("limit"))
      return Response.json({ data: records.slice(offset, end), ...(end < records.length ? { next: end - 1 } : {}) })
    },
  })
  try {
    const local = createLocalServer({ url: `http://127.0.0.1:${server.port}` })
    expect(await local.capturedInputs("ses_page", { directory: "/recorded" })).toEqual(records)
    expect(requests).toEqual(
      [null, "199", "399"].map((after) => ({
        path: "/api/session/ses_page/message/captured-inputs",
        after,
        limit: "200",
        directory: "%2Frecorded",
      })),
    )
  } finally {
    await server.stop(true)
  }
})

test.each(["cursor", "failure"])(
  "local captured input %s failure rejects the whole read without a transcript fallback",
  async (failure) => {
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requests.push(new URL(request.url).pathname)
        if (requests.length === 1) return Response.json({ data: [{ id: "msg_first", type: "user" }], next: 1 })
        if (failure === "failure")
          return Response.json({ _tag: "UnknownError", message: "synthetic read failure" }, { status: 500 })
        return Response.json({ data: [{ id: "msg_second", type: "user" }], next: 1 })
      },
    })
    try {
      const local = createLocalServer({ url: `http://127.0.0.1:${server.port}` })
      await expect(local.capturedInputs("ses_page", { directory: "/recorded" })).rejects.toMatchObject({
        kind: "server",
      })
      expect(requests).toEqual([
        "/api/session/ses_page/message/captured-inputs",
        "/api/session/ses_page/message/captured-inputs",
      ])
    } finally {
      await server.stop(true)
    }
  },
)

test("a real selective page mutation produces no mixed summary and the next stable read succeeds", async () => {
  let seq = 1
  let mutate = true
  const requests: string[] = []
  const edit = (file: string) => ({
    type: "tool",
    id: `call_${file}`,
    name: "edit",
    state: { status: "completed", structured: { files: [{ file, patch: "@@ -1 +1 @@\n-old\n+new" }] } },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.searchParams.has("after")) {
        if (mutate) seq++
        return Response.json({ data: [{ id: "msg_last", type: "assistant", content: [edit("last.ts")] }] })
      }
      return Response.json({
        data: [
          { id: "msg_user", type: "user" },
          ...Array.from({ length: 199 }, (_, index) => ({
            id: `msg_page_${index}`,
            type: "assistant",
            content: index === 0 ? [edit(seq === 1 ? "old.ts" : "fresh.ts")] : [],
          })),
        ],
        next: 199,
      })
    },
  })
  const info: SessionInfo = {
    id: "ses_page",
    projectID: "prj_page",
    title: "Paged",
    location: { directory: "/recorded", workspaceID: undefined },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const local = {
    ...createLocalServer({ url: `http://127.0.0.1:${server.port}` }),
    listPage: async () => ({ data: [info] }),
    getSession: async () => info,
    snapshot: async () => ({ sourceEpoch: "epoch_1", watermark: { type: "log.synced", aggregateID: info.id, seq } }),
  }
  const sessions = createSessionRegistry({ local })
  const cache = createOperationCache()
  const read = () =>
    executeRemoteOperation({
      request: { type: "request", id: "req_paged", operation: "session.capturedChanges.list", sessionID: info.id },
      local,
      sessions,
      cache,
      subscriptions: createSubscriptions(),
    })
  try {
    await sessions.refresh()
    expect(await read()).toMatchObject([{ ok: false, error: { code: "internal_error" } }])
    expect(cache.capturedChanges.size).toBe(0)
    mutate = false
    expect(await read()).toMatchObject([{ ok: true, value: { data: [{ path: "fresh.ts" }, { path: "last.ts" }] } }])
    expect(cache.capturedChanges.size).toBe(1)
    expect(requests).toEqual(Array.from({ length: 4 }, () => "/api/session/ses_page/message/captured-inputs"))
  } finally {
    await server.stop(true)
  }
})
