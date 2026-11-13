import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"

for (const [args, expected] of [
  [["--follow"], "--follow requires --family"],
  [["--state", "synthetic-state.json"], "--state requires --follow"],
  [["--family", "--follow", "--input", "msg_synthetic"], "--follow cannot use --input, --after or --checkpoint"],
  [["--deliver", "thr_root"], "--deliver requires --follow"],
  [["--family", "--follow", "--deliver", " "], "--deliver requires a Dot thread ID"],
] as const) {
  test(`installed decision watch validates ${args.join(" ")} before connecting`, async () => {
    const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname,
      "decision", "watch", "ses_synthetic", ...args, "--server", "http://127.0.0.1:1"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exit).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain(expected)
  }, 30_000)
}

test("installed decision watch help advertises continuous follow, state and heartbeat semantics", async () => {
  const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "decision", "watch", "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(exit).toBe(0)
  for (const value of ["--follow", "--state", "follow heartbeats", "IDs-only JSON", "--deliver", "Dot thread"]) expect(stdout).toContain(value)
}, 30_000)

test("installed follow delivers lifecycle and decision events to a Dot thread and records delivery in its state", async () => {
  const scratch = path.join(homedir(), ".local/share/ycoding/tasks")
  await mkdir(scratch, { recursive: true })
  const dir = await realpath(await mkdtemp(path.join(scratch, "decision-follow-deliver-")))
  const filename = path.join(dir, "state.json")
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const sent: Record<string, unknown>[] = []
  let asked = false
  const frame = (value: object) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
  const decide = ["ycoding", "api", "session.guardrail.request.reply", "--param", "sessionID=ses_root", "--param", "requestID=grq_synthetic", "--data", "{\"reply\":\"once\"}"]
  const server = Bun.serve({ port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url)
    const route = url.pathname
    if (route === "/api/health") return Response.json({ healthy: true, version: InstallationVersion, pid: process.pid })
    if (route === "/api/event" || route === "/api/experimental/session/ses_root/log") {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streams.set(route, controller)
        controller.enqueue(frame(route === "/api/event"
          ? { type: "server.connected", id: "evt_connected", sourceEpoch: "epoch_synthetic", data: {} }
          : { type: "log.synced", sourceEpoch: "epoch_synthetic", aggregateID: "ses_root" }))
        request.signal.addEventListener("abort", () => streams.delete(route), { once: true })
      }, cancel() { streams.delete(route) } }), { headers: { "content-type": "text/event-stream" } })
    }
    if (route === "/api/session/ses_root") return Response.json({ data: { id: "ses_root", title: "Synthetic" } })
    if (route === "/api/session/ses_root/snapshot") return Response.json({ sourceEpoch: "epoch_synthetic", session: { id: "ses_root" }, messages: [], watermark: { type: "log.synced", aggregateID: "ses_root" } })
    if (route === "/api/session/active") return Response.json({ data: {} })
    if (route === "/api/session/outstanding") return Response.json({ data: [], running: [], failed: [], lost: [] })
    if (route === "/api/session/ses_root/subagent") return Response.json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (route === "/api/coordination") return Response.json({ data: [] })
    if (route === "/api/session") return Response.json({ data: [], cursor: {} })
    if (route === "/api/decision") return Response.json({ data: !asked ? [] : [{ kind: "guardrail", sessionID: "ses_root", sessionTitle: "Synthetic", directory: "/synthetic", id: "grq_synthetic", summary: "bash: synthetic", decide: [{ label: "once", argv: decide }] }] })
    if (route === "/api/dots/threads") return Response.json({ data: { dotID: "dot_synthetic", rootThreadID: "thr_root", threads: [{ threadID: "thr_root", kind: "root", status: "idle" }], tasks: [] } })
    if (route === "/api/dots/thread/thr_root/message" && request.method === "POST") {
      sent.push(await request.json() as Record<string, unknown>)
      return Response.json({ data: { admission: "started", turnID: "turn_synthetic" } })
    }
    return new Response("unexpected route", { status: 500 })
  } })
  const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "decision", "watch", "ses_root", "--family", "--follow", "--state", filename,
    "--deliver", "thr_root", "--server", server.url.toString()], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const lines: Record<string, unknown>[] = []
  const reading = (async () => {
    let buffer = ""
    for await (const bytes of child.stdout) {
      buffer += new TextDecoder().decode(bytes)
      const rows = buffer.split("\n")
      buffer = rows.pop()!
      for (const row of rows) lines.push(JSON.parse(row) as Record<string, unknown>)
    }
  })()
  const until = async (predicate: () => boolean, label: string) => {
    for (const started = Date.now(); !predicate();) {
      if (Date.now() - started > 8000) throw new Error(`Missing installed delivery ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  try {
    await until(() => lines.some((value) => value.kind === "ready"), "ready")
    streams.get("/api/experimental/session/ses_root/log")!.enqueue(frame({ type: "session.execution.succeeded", id: "evt_succeeded", sourceEpoch: "epoch_synthetic", durable: { aggregateID: "ses_root", seq: 1 }, data: { sessionID: "ses_root" } }))
    await until(() => sent.length === 1, "lifecycle message")
    asked = true
    streams.get("/api/event")!.enqueue(frame({ type: "guardrail.asked", id: "evt_ask", sourceEpoch: "epoch_synthetic", data: { sessionID: "ses_root", id: "grq_synthetic", action: "NEVER-OUTPUT" } }))
    await until(() => sent.length === 2, "guardrail message")
    expect(sent[0]).toMatchObject({ mode: "send", clientMessageID: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) })
    expect(String(sent[0]!.text)).toContain("Session ses_root execution succeeded (event evt_succeeded, seq 1).")
    expect(String(sent[1]!.text)).toContain("guardrail grq_synthetic pending in ses_root.")
    expect(String(sent[1]!.text)).toContain("once: ycoding api session.guardrail.request.reply --param sessionID=ses_root --param requestID=grq_synthetic --data '{\"reply\":\"once\"}'")
    expect(String(sent[1]!.text)).not.toContain("NEVER-OUTPUT")
    await until(() => lines.filter((value) => value.kind === "delivery").length === 2, "delivery records")
    expect(lines.filter((value) => value.kind === "delivery").map((value) => [value.threadID, value.outcome, value.admission])).toEqual([["thr_root", "delivered", "started"], ["thr_root", "delivered", "started"]])
    expect(JSON.stringify(lines)).not.toContain("NEVER-OUTPUT")
  } finally {
    child.kill("SIGINT")
    await child.exited
    await reading
    expect(await new Response(child.stderr).text()).toBe("")
    server.stop(true)
  }
  try {
    const saved = JSON.parse(await readFile(filename, "utf8"))
    expect(saved.delivery).toEqual({ announced: ["guardrail\0ses_root\0grq_synthetic"], targets: [{ threadID: "thr_root", outbox: [] }] })
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 30_000)

test("installed follow uses native read routes, streams categories after completion and releases storage on cancellation", async () => {
  const scratch = path.join(homedir(), ".local/share/ycoding/tasks")
  await mkdir(scratch, { recursive: true })
  const dir = await realpath(await mkdtemp(path.join(scratch, "decision-follow-command-")))
  const filename = path.join(dir, "state.json")
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const requests: string[] = []
  const frame = (value: object) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url)
    const route = url.pathname
    if (route === "/api/health") return Response.json({ healthy: true, version: InstallationVersion, pid: process.pid })
    requests.push(`${request.method} ${route}`)
    if (route === "/api/event" || route === "/api/experimental/session/ses_root/log") {
      expect(route.includes("/log") ? url.searchParams.get("follow") : "true").toBe("true")
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streams.set(route, controller)
        controller.enqueue(frame(route === "/api/event"
          ? { type: "server.connected", id: "evt_connected", sourceEpoch: "epoch_synthetic", data: {} }
          : { type: "log.synced", sourceEpoch: "epoch_synthetic", aggregateID: "ses_root" }))
        request.signal.addEventListener("abort", () => streams.delete(route), { once: true })
      }, cancel() { streams.delete(route) } }), { headers: { "content-type": "text/event-stream" } })
    }
    if (route === "/api/session/ses_root") return Response.json({ data: { id: "ses_root", title: "NEVER-OUTPUT" } })
    if (route === "/api/session/ses_root/snapshot") return Response.json({ sourceEpoch: "epoch_synthetic", session: { id: "ses_root" }, messages: [], watermark: { type: "log.synced", aggregateID: "ses_root" } })
    if (route === "/api/session/active") return Response.json({ data: {} })
    if (route === "/api/session/outstanding") return Response.json({ data: [], running: [], failed: [], lost: [] })
    if (route === "/api/session/ses_root/subagent") return Response.json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (route === "/api/coordination") return Response.json({ data: [] })
    if (route === "/api/session") return Response.json({ data: [], cursor: {} })
    if (route === "/api/decision") return Response.json({ data: [] })
    return new Response("unexpected route", { status: 500 })
  } })
  const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "decision", "watch", "ses_root", "--family", "--follow", "--state", filename, "--timeout", "1", "--server", server.url.toString()], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const lines: Record<string, unknown>[] = []
  const waiters: { kind: string; resolve(): void }[] = []
  const reading = (async () => {
    let buffer = ""
    for await (const bytes of child.stdout) {
      buffer += new TextDecoder().decode(bytes)
      const rows = buffer.split("\n")
      buffer = rows.pop()!
      for (const row of rows) {
        const receipt = JSON.parse(row) as Record<string, unknown>
        lines.push(receipt)
        for (const waiter of [...waiters]) if (receipt.kind === waiter.kind) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve() }
      }
    }
  })()
  const wait = (kind: string) => lines.some((value) => value.kind === kind) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing installed follow ${kind}`)), 5000)
    waiters.push({ kind, resolve() { clearTimeout(timer); resolve() } })
  })
  try {
    await wait("ready")
    streams.get("/api/experimental/session/ses_root/log")!.enqueue(frame({ type: "session.work.completed", id: "evt_complete", sourceEpoch: "epoch_synthetic", durable: { aggregateID: "ses_root", seq: 1 }, data: { sessionID: "ses_root", inputID: "msg_synthetic", assistantMessageID: "msg_response", secret: "NEVER-OUTPUT" } }))
    await wait("durable")
    streams.get("/api/event")!.enqueue(frame({ type: "guardrail.asked", id: "evt_ask", sourceEpoch: "epoch_synthetic", data: { sessionID: "ses_root", id: "grq_synthetic", action: "NEVER-OUTPUT" } }))
    await wait("request-observed")
    streams.get("/api/event")!.enqueue(frame({ type: "guardrail.replied", id: "evt_reply", sourceEpoch: "epoch_synthetic", data: { sessionID: "ses_root", requestID: "grq_synthetic", reply: "NEVER-OUTPUT" } }))
    await wait("reply-observed")
    await wait("heartbeat")
    expect(lines.find((value) => value.kind === "request-observed")).toMatchObject({ requestKind: "guardrail", id: "grq_synthetic" })
    expect(requests.every((value) => value.startsWith("GET "))).toBe(true)
    expect(JSON.stringify(lines)).not.toContain("NEVER-OUTPUT")
  } finally {
    child.kill("SIGINT")
    await child.exited
    await reading
    expect(await new Response(child.stderr).text()).toBe("")
    server.stop(true)
  }
  try {
    const saved = JSON.parse(await readFile(filename, "utf8"))
    expect(saved.sourceEpoch).toBe("epoch_synthetic")
    expect(saved.terminalSeen).toEqual(["guardrail\0ses_root\0grq_synthetic"])
    await expect(readFile(`${filename}.lock`)).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 20_000)

for (const [scenario, code] of [["epoch", "epoch-mismatch"], ["lock", "state-lock-held"], ["invalid", "state-invalid"], ["cursor", "cursor-ahead"], ["native", "observer-failed"], ["connection", "observer-failed"]] as const) {
  test(`installed follow classifies ${scenario} failure without exposing native or private state content`, async () => {
    const scratch = path.join(homedir(), ".local/share/ycoding/tasks")
    await mkdir(scratch, { recursive: true })
    const dir = await realpath(await mkdtemp(path.join(scratch, "decision-follow-errors-")))
    const filename = path.join(dir, "state.json")
    const server = Bun.serve({ port: 0, idleTimeout: 0, fetch(request) {
      const route = new URL(request.url).pathname
      if (route === "/api/health") return scenario === "connection" ? new Response("NEVER-OUTPUT private health response", { status: 500 }) : Response.json({ healthy: true, version: InstallationVersion, pid: process.pid })
      if (route === "/api/event") return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", sourceEpoch: "epoch_current", data: {} })}\n\n`))
      } }), { headers: { "content-type": "text/event-stream" } })
      if (route === "/api/session/ses_root") return scenario === "native" ? new Response("NEVER-OUTPUT native credential-like content", { status: 500 }) : Response.json({ data: { id: "ses_root" } })
      if (route === "/api/session/ses_root/snapshot") return Response.json({ sourceEpoch: scenario === "epoch" ? "epoch_inconsistent" : "epoch_current", session: { id: "ses_root" }, messages: [], watermark: { type: "log.synced", aggregateID: "ses_root", seq: 1 } })
      if (route === "/api/session/active") return Response.json({ data: {} })
      if (route === "/api/session") return Response.json({ data: [], cursor: {} })
      return new Response("NEVER-OUTPUT unexpected native response", { status: 500 })
    } })
    const data = scenario === "invalid" ? "NEVER-OUTPUT invalid private state" : JSON.stringify({ version: 1, rootSessionID: "ses_root",
      server: createHash("sha256").update(server.url.toString()).digest("hex"), sourceEpoch: scenario === "epoch" ? "epoch_previous" : "epoch_current",
      cursors: [{ sessionID: "ses_root", ...(scenario === "cursor" ? { after: 2 } : {}) }], pending: [], seen: [], requestSeen: [], terminalSeen: [] })
    try {
      await writeFile(filename, data, { mode: 0o600 })
      if (scenario === "lock") await writeFile(`${filename}.lock`, "NEVER-OUTPUT existing lock owner", { mode: 0o600 })
      const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "decision", "watch", "ses_root", "--family", "--follow", "--state", filename, "--server", server.url.toString()], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(exit).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain(`[${code}]`)
      for (const privateValue of ["NEVER-OUTPUT", filename, dir, homedir(), server.url.toString()]) expect(stderr).not.toContain(privateValue)
      expect(await readFile(filename, "utf8")).toBe(data)
      if (scenario === "lock") expect(await readFile(`${filename}.lock`, "utf8")).toBe("NEVER-OUTPUT existing lock owner")
    } finally { server.stop(true); await rm(dir, { recursive: true, force: true }) }
  }, 20_000)
}

for (const follow of [true, false]) {
  test(`installed ${follow ? "follow sanitizes" : "one-shot preserves"} a version mismatch warning and preserves native health resolution`, async () => {
    const scratch = path.join(homedir(), ".local/share/ycoding/tasks")
    await mkdir(scratch, { recursive: true })
    const dir = await realpath(await mkdtemp(path.join(scratch, "decision-follow-version-")))
    const filename = path.join(dir, "state.json")
    const routes: string[] = []
    const server = Bun.serve({ port: 0, fetch(request) {
      const route = new URL(request.url).pathname
      routes.push(route)
      return route === "/api/health" ? Response.json({ healthy: true, version: "NEVER-OUTPUT-native-version", pid: process.pid })
        : new Response("NEVER-OUTPUT native failure", { status: 500 })
    } })
    try {
      const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "decision", "watch", "ses_root", ...(follow ? ["--family", "--follow", "--state", filename] : []), "--server", server.url.toString()], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(exit).toBe(1)
      expect(stdout).toBe("")
      if (follow) {
        expect(stderr).toContain("[server-version-mismatch]")
        expect(stderr).toContain("[observer-failed]")
        for (const value of ["NEVER-OUTPUT", server.url.toString(), dir, homedir()]) expect(stderr).not.toContain(value)
      } else expect(stderr).toContain(`Warning: Server at ${server.url.toString()} has version NEVER-OUTPUT-native-version; this client is ${InstallationVersion}. Continuing anyway.`)
      expect(routes).toEqual(["/api/health", "/api/session/ses_root"])
    } finally { server.stop(true); await rm(dir, { recursive: true, force: true }) }
  }, 20_000)
}
