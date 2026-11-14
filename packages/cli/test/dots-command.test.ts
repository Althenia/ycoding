import { expect, test } from "bun:test"
import { dotsAttachConfirmed, dotsAttachWarning, dotsDetachWarning, dotsTaskLine } from "../src/commands/dots"

const status = (computer: Record<string, unknown> | undefined) => ({
  data: {
    access: { enabled: true, revision: 1 },
    configuration: { ready: true, profile: "dots" },
    connection: { state: "connected" },
    ...(computer === undefined ? {} : { computer }),
  },
})

async function cli(args: string[], stdin: "ignore" | "pipe" = "ignore") {
  const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "dots", ...args], { stdin, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, exit }
}

async function withServer(current: unknown, attached: unknown, use: (url: string, seen: { method: string; path: string; body: string }[]) => Promise<void>) {
  const seen: { method: string; path: string; body: string }[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/api/health") return Response.json({ healthy: true, version: "test", pid: process.pid })
    seen.push({ method: request.method, path, body: await request.text() })
    if (request.method === "GET" && path === "/api/dots") return Response.json(current)
    if (request.method === "POST" && path === "/api/dots/computer") return Response.json(attached)
    return new Response("not found", { status: 404 })
  } })
  try {
    await use(server.url.toString(), seen)
  } finally {
    server.stop(true)
  }
}

test("dots attach explains non-replacing attachment in help without starting a server", async () => {
  const result = await cli(["attach", "--help"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain("Attach this computer to your Dot")
  expect(result.stdout).toContain("--yes")
})

test("dots attach confirms only explicit yes answers", () => {
  for (const answer of ["y", "Y", "yes", " YES "]) expect(dotsAttachConfirmed(answer)).toBe(true)
  for (const answer of [undefined, "", "n", "no", "yess", "sure"]) expect(dotsAttachConfirmed(answer)).toBe(false)
})

test("Dot thread labels preserve task IDs and attachment scope", () => {
  expect(dotsTaskLine({
    taskID: "task-fixture",
    title: "Ship release",
    status: "active",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
  })).toBe("Thread task-fixture active · Ship release")
  expect(dotsAttachWarning).toBe(
    "This keeps your other computers connected. Choose which computer runs a Dot thread in ChatGPT.",
  )
  expect(dotsDetachWarning).toBe("This computer stops running Dot threads. Your other computers stay connected.")
})

test("dots tasks command keeps its identifier while help describes Dot threads", async () => {
  const result = await cli(["tasks", "--help"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain("tasks")
  expect(result.stdout).toContain("List your Dot's threads, or one thread's updates")
  expect(result.stdout).toContain("Thread ID whose updates to read")
  expect(result.stdout).not.toContain("Dot's tasks")
})

test("dots attach displays the observed name and forwards its exact target receipt", async () => {
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  await withServer(status({ state: "detached", name: "Executor desk", target }), status({ state: "attached", name: "Executor desk", target }), async (url, seen) => {
    const result = await cli(["attach", "--yes", "--server", url])
    expect(result.exit).toBe(0)
    expect(result.stdout).toContain("Executor desk")
    expect(JSON.parse(seen[1]!.body)).toEqual({ replaceOthers: false, expectedTarget: target })
  })
}, 30000)

test("dots attach posts non-replacing consent with --yes and prints the re-read state", async () => {
  await withServer(status({ state: "detached" }), status({ state: "attached" }), async (url, seen) => {
    const result = await cli(["attach", "--yes", "--server", url])
    expect(result.exit).toBe(0)
    expect(result.stdout).toContain("Computer: detached")
    expect(result.stdout).toContain("keeps your other computers connected")
    expect(result.stdout).toContain("Computer: attached")
    expect(seen).toEqual([
      { method: "GET", path: "/api/dots", body: "" },
      { method: "POST", path: "/api/dots/computer", body: '{"replaceOthers":false}' },
    ])
  })
}, 30000)

test("dots attach does not post without confirmation, when attached, or when unavailable", async () => {
  await withServer(status({ state: "detached" }), status({ state: "attached" }), async (url, seen) => {
    const result = await cli(["attach", "--server", url], "pipe")
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain("--yes")
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
  await withServer(status({ state: "attached" }), status({ state: "attached" }), async (url, seen) => {
    const result = await cli(["attach", "--yes", "--server", url])
    expect(result.exit).toBe(0)
    expect(result.stdout).toBe("Computer: attached\n")
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
  await withServer(status({ state: "unavailable", message: "Turn on Dots access first." }), status({ state: "attached" }), async (url, seen) => {
    const result = await cli(["attach", "--yes", "--server", url])
    expect(result.exit).toBe(1)
    expect(result.stdout).toContain("Computer: unavailable (Turn on Dots access first.)")
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
}, 30000)

test("dots attach fails when the re-read state is not attached", async () => {
  await withServer(status({ state: "detached" }), status({ state: "detached", message: "The attach request was refused." }), async (url) => {
    const result = await cli(["attach", "--yes", "--server", url])
    expect(result.exit).toBe(1)
    expect(result.stdout).toContain("Computer: detached (The attach request was refused.)")
    expect(result.stderr).toContain("not attached")
  })
}, 30000)

async function withRoute(path: string, current: unknown, result: unknown, use: (url: string, seen: { method: string; path: string; body: string }[]) => Promise<void>) {
  const seen: { method: string; path: string; body: string }[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const requested = new URL(request.url).pathname
    if (requested === "/api/health") return Response.json({ healthy: true, version: "test", pid: process.pid })
    seen.push({ method: request.method, path: requested, body: await request.text() })
    if (request.method === "GET" && requested === "/api/dots") return Response.json(current)
    if (request.method === "POST" && requested === path) return Response.json(result)
    return new Response("not found", { status: 404 })
  } })
  try {
    await use(server.url.toString(), seen)
  } finally {
    void server.stop(true)
  }
}

const exactTarget = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }

test("dots detach and remove explain themselves in help without starting a server", async () => {
  for (const [command, text] of [["detach", "Detach this computer from your Dot"], ["remove", "Remove this computer from your ChatGPT account"]] as const) {
    const result = await cli([command, "--help"])
    expect(result.exit).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain(text)
    expect(result.stdout).toContain("--yes")
  }
}, 30000)

test("dots detach posts the displayed target with --yes and succeeds only when the re-read state is detached", async () => {
  await withRoute("/api/dots/computer/detach", status({ state: "attached", name: "Executor desk", target: exactTarget }), status({ state: "detached", name: "Executor desk", target: exactTarget }), async (url, seen) => {
    const result = await cli(["detach", "--yes", "--server", url])
    expect(result.exit).toBe(0)
    expect(result.stdout).toContain("Computer: attached · Executor desk")
    expect(result.stdout).toContain("Computer: detached · Executor desk")
    expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual(["GET /api/dots", "POST /api/dots/computer/detach"])
    expect(JSON.parse(seen[1].body)).toEqual({ expectedTarget: exactTarget })
  })
  await withRoute("/api/dots/computer/detach", status({ state: "attached" }), status({ state: "attached", message: "ChatGPT refused the request." }), async (url) => {
    const result = await cli(["detach", "--yes", "--server", url])
    expect(result.exit).toBe(1)
    expect(result.stdout).toContain("Computer: attached (ChatGPT refused the request.)")
    expect(result.stderr).toContain("not detached")
  })
}, 30000)

test("dots detach does not post without confirmation, when already detached or when unavailable", async () => {
  await withRoute("/api/dots/computer/detach", status({ state: "attached" }), status({ state: "detached" }), async (url, seen) => {
    const result = await cli(["detach", "--server", url], "pipe")
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain("--yes")
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
  await withRoute("/api/dots/computer/detach", status({ state: "detached" }), status({ state: "detached" }), async (url, seen) => {
    const result = await cli(["detach", "--yes", "--server", url])
    expect(result.exit).toBe(0)
    expect(result.stdout).toBe("Computer: detached\n")
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
  await withRoute("/api/dots/computer/detach", status({ state: "unavailable", message: "Turn on Dots access first." }), status({ state: "detached" }), async (url, seen) => {
    const result = await cli(["detach", "--yes", "--server", url])
    expect(result.exit).toBe(1)
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
}, 30000)

test("dots remove posts the displayed target with --yes and succeeds only when removal is confirmed", async () => {
  for (const state of ["attached", "detached"] as const) {
    await withRoute("/api/dots/computer/remove", status({ state, target: exactTarget }), status({ state: "removed", message: "This computer was removed." }), async (url, seen) => {
      const result = await cli(["remove", "--yes", "--server", url])
      expect(result.exit).toBe(0)
      expect(result.stdout).toContain("Computer: removed (This computer was removed.)")
      expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual(["GET /api/dots", "POST /api/dots/computer/remove"])
      expect(JSON.parse(seen[1].body)).toEqual({ expectedTarget: exactTarget })
    })
  }
  await withRoute("/api/dots/computer/remove", status({ state: "detached" }), status({ state: "detached", message: "The outcome is unconfirmed." }), async (url) => {
    const result = await cli(["remove", "--yes", "--server", url])
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain("not confirmed")
  })
}, 30000)

test("dots remove does not post without confirmation or when the computer is unavailable", async () => {
  await withRoute("/api/dots/computer/remove", status({ state: "detached" }), status({ state: "removed" }), async (url, seen) => {
    const result = await cli(["remove", "--server", url], "pipe")
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain("--yes")
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
  await withRoute("/api/dots/computer/remove", status({ state: "unavailable" }), status({ state: "removed" }), async (url, seen) => {
    const result = await cli(["remove", "--yes", "--server", url])
    expect(result.exit).toBe(1)
    expect(seen.map((item) => item.method)).toEqual(["GET"])
  })
}, 30000)

async function withConversation(routes: Record<string, unknown>, use: (url: string, seen: { method: string; path: string; body: string }[]) => Promise<void>) {
  const seen: { method: string; path: string; body: string }[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "test", pid: process.pid })
    const key = `${request.method} ${url.pathname}${url.search}`
    seen.push({ method: request.method, path: `${url.pathname}${url.search}`, body: await request.text() })
    if (key in routes) {
      const reply = routes[key]
      return reply instanceof Response ? reply : Response.json({ data: reply })
    }
    return new Response("not found", { status: 404 })
  } })
  try {
    await use(server.url.toString(), seen)
  } finally {
    void server.stop(true)
  }
}

test("dots send posts one message with a fresh client message ID and steers unless queued", async () => {
  await withConversation({ "POST /api/dots/thread/thr-a/message": { admission: "steered", turnID: "turn-1" } }, async (url, seen) => {
    const steer = await cli(["send", "thr-a", "Check the logs", "--server", url])
    expect(steer.exit).toBe(0)
    expect(steer.stdout).toBe("Message: steered · turn turn-1\n")
    const queue = await cli(["send", "thr-a", "Then summarize", "--queue", "--server", url])
    expect(queue.exit).toBe(0)
    expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /api/dots/thread/thr-a/message", "POST /api/dots/thread/thr-a/message"])
    const [first, second] = seen.map((item) => JSON.parse(item.body))
    expect(first).toEqual({ text: "Check the logs", clientMessageID: expect.stringMatching(/^[0-9a-f-]{36}$/), mode: "send" })
    expect(second).toEqual({ text: "Then summarize", clientMessageID: expect.stringMatching(/^[0-9a-f-]{36}$/), mode: "queue" })
    expect(first.clientMessageID).not.toBe(second.clientMessageID)
  })
}, 30000)

test("dots send reports an unknown admission once and fails without resending", async () => {
  await withConversation({ "POST /api/dots/thread/thr-a/message": { admission: "unknown" } }, async (url, seen) => {
    const result = await cli(["send", "thr-a", "Check the logs", "--server", url])
    expect(result.exit).toBe(1)
    expect(result.stdout).toBe("Message: unknown\n")
    expect(result.stderr).toContain("read the thread before sending it again")
    expect(seen).toHaveLength(1)
  })
}, 30000)

test("dots send prints a refusal with the upstream rejection code and a control-free message", async () => {
  const refusal = Response.json({ _tag: "InvalidRequestError", message: "ChatGPT refused the request.", rejection: { code: -32602, message: "thread\u001b[31mbusy" } }, { status: 400 })
  await withConversation({ "POST /api/dots/thread/thr-a/message": refusal }, async (url, seen) => {
    const result = await cli(["send", "thr-a", "Check the logs", "--server", url])
    expect(result.exit).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.split("\n")).toContain("ycoding: Dots request failed (400): ChatGPT refused the request. ChatGPT rejection code -32602: thread [31mbusy")
    expect(result.stderr).not.toContain("_tag")
    expect(result.stderr).not.toContain("\u001b")
    expect(seen).toHaveLength(1)
  })
}, 30000)

test("dots threads and read print Dot thread labels with unchanged task and transcript IDs", async () => {
  await withConversation({
    "GET /api/dots/threads": { dotID: "dot-a", rootThreadID: "thr-root", threads: [{ threadID: "thr-root", kind: "root", status: "idle", name: "Daily" }, { threadID: "thr-task", kind: "task" }],
      tasks: [{ taskID: "task-1", title: "Ship release", status: "active", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" }] },
    "GET /api/dots/thread/thr-task?limit=5": { thread: { threadID: "thr-task", kind: "task" }, nextCursor: "older-1", turns: [{ turnID: "turn-1", status: "completed", items: [
      { type: "userMessage", itemID: "i1", text: "Run tests" }, { type: "commandExecution", itemID: "i2", command: "bun test", exitCode: 0 },
      { type: "fileChange", itemID: "i3", paths: ["src/a.ts"] }, { type: "agentMessage", itemID: "i4", text: "Done" }, { type: "other", itemID: "i5", itemType: "reasoning" },
    ] }] },
  }, async (url) => {
    const threads = await cli(["threads", "--server", url])
    expect(threads.exit).toBe(0)
    expect(threads.stdout).toBe("Dot: dot-a\nThread thr-root root · idle · Daily\nThread thr-task task\nThread task-1 active · Ship release\n")
    const read = await cli(["read", "thr-task", "--limit", "5", "--server", url])
    expect(read.exit).toBe(0)
    expect(read.stdout).toBe([
      "Thread thr-task task", "Turn turn-1 completed", "  user: Run tests", "  command: bun test (exit 0)", "  files: src/a.ts", "  agent: Done", "  reasoning",
      "Older turns: --cursor older-1", "",
    ].join("\n"))
  })
}, 30000)

test("dots respond requires exactly one answer form and posts it once; a stale request fails", async () => {
  await withConversation({
    "POST /api/dots/thread/thr-a/requests/req-1": { outcome: "sent" },
    "POST /api/dots/thread/thr-a/requests/req-stale": new Response(JSON.stringify({ _tag: "ConflictError", message: "This request was already answered or is no longer pending." }), { status: 409 }),
  }, async (url, seen) => {
    for (const args of [["respond", "thr-a", "req-1"], ["respond", "thr-a", "req-1", "--decision", "accept", "--answers", "{}"], ["respond", "thr-a", "req-1", "--answers", "{\"q1\":[]}"]]) {
      const result = await cli([...args, "--server", url])
      expect(result.exit).toBe(1)
    }
    expect(seen).toEqual([])
    const decided = await cli(["respond", "thr-a", "req-1", "--decision", "acceptForSession", "--server", url])
    expect(decided.exit).toBe(0)
    expect(decided.stdout).toBe("Response: sent\n")
    const answered = await cli(["respond", "thr-a", "req-1", "--answers", "{\"q1\":[\"Yes\"]}", "--server", url])
    expect(answered.exit).toBe(0)
    const stale = await cli(["respond", "thr-a", "req-stale", "--decision", "decline", "--server", url])
    expect(stale.exit).toBe(1)
    expect(stale.stderr).toContain("409")
    expect(seen.map((item) => JSON.parse(item.body))).toEqual([{ decision: "acceptForSession" }, { answers: { q1: ["Yes"] } }, { decision: "decline" }])
  })
}, 30000)

test("dots interrupt, resume and requests call their routes once and fail on unconfirmed outcomes", async () => {
  await withConversation({
    "POST /api/dots/thread/thr-a/interrupt": { outcome: "interrupted" },
    "POST /api/dots/resume": { outcome: "unconfirmed", threadID: "thr-root", rootChanged: false },
    "GET /api/dots/thread/thr-a/requests": { threadID: "thr-a", requests: [{ requestID: "req-1", threadID: "thr-a", kind: "command-approval", command: "rm -rf build", reason: "Clean" }] },
  }, async (url, seen) => {
    const interrupt = await cli(["interrupt", "thr-a", "turn-1", "--server", url])
    expect(interrupt.exit).toBe(0)
    expect(interrupt.stdout).toBe("Interrupt: interrupted\n")
    const resume = await cli(["resume", "--server", url])
    expect(resume.exit).toBe(1)
    expect(resume.stdout).toBe("Resume: unconfirmed · thread thr-root\n")
    const requests = await cli(["requests", "thr-a", "--server", url])
    expect(requests.stdout).toBe("Request req-1 command-approval\n  reason: Clean\n  command: rm -rf build\n")
    expect(seen.map((item) => `${item.method} ${item.path} ${item.body}`)).toEqual([
      'POST /api/dots/thread/thr-a/interrupt {"turnID":"turn-1"}', "POST /api/dots/resume {}", "GET /api/dots/thread/thr-a/requests ",
    ])
  })
}, 30000)
