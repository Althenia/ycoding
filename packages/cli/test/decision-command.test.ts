import { expect, test } from "bun:test"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { v5Server } from "./fixture/v5-server"

const items = [{ kind: "permission", sessionID: "ses_synthetic", sessionTitle: "Synthetic", directory: "/tmp/with space", id: "per_synthetic", summary: "edit file.txt",
  decide: [{ label: "Once", argv: ["ycoding", "api", "session.permission.reply", "--param", "sessionID=ses_synthetic", "--param", "requestID=per_synthetic", "--data", '{"reply":"once"}'] }],
}, { kind: "form", sessionID: "ses_synthetic", sessionTitle: "Synthetic", directory: "/tmp/with space", id: "frm_synthetic", summary: "Enter name",
  decide: [{ label: "Reply (replace answer values)", template: true, argv: ["ycoding", "api", "session.form.reply", "--param", "sessionID=ses_synthetic", "--param", "formID=frm_synthetic", "--data", '{"answer":{"name":"<answer:name>"}}'] }],
}]

async function cli(args: string[], command = ["decision", "list"], respond?: (request: Request) => Response | undefined) {
  const requests: string[] = []
  const server = v5Server((name, data) => {
    if (name === "health.get") return { data: { healthy: true, version: InstallationVersion, pid: process.pid } }
    requests.push(name)
    if (name === "decision.list") return { data: items }
    if (name === "session.permission.reply") {
      expect(data).toEqual({ params: { sessionID: "ses_synthetic", requestID: "per_synthetic" }, payload: { reply: "once" } })
      return { data: {} }
    }
    if (name === "session.archive") {
      expect(data).toEqual({ params: { sessionID: "ses_missing" } })
      return { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Synthetic Session missing" }
    }
    throw new Error(`Unexpected operation: ${name}`)
  }, { http: (request) => {
    const path = new URL(request.url).pathname
    if (path === "/ws/v5/local") return undefined
    requests.push(path)
    expect(request.headers.has("x-ycoding-directory")).toBe(false)
    return respond?.(request) ?? (path === "/api/decision" ? Response.json({ data: items }) : undefined)
  } })
  try {
    const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, ...command, ...args, "--server", server.url], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, exit, requests }
  } finally { await server.close() }
}

test("decision list prints a readable table and shell-safe exact decide commands", async () => {
  const result = await cli([])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.requests).toEqual(["/api/decision"])
  expect(result.stdout).toContain("KIND")
  expect(result.stdout).toContain("SESSION")
  expect(result.stdout).toContain("DIRECTORY")
  expect(result.stdout).toContain("Synthetic")
  expect(result.stdout).toContain("/tmp/with space")
  expect(result.stdout).toContain(`ycoding api session.permission.reply --param sessionID=ses_synthetic --param requestID=per_synthetic --data '{"reply":"once"}'`)
  expect(result.stdout).toContain(`--data '{"answer":{"name":"<answer:name>"}}'`)
  expect(result.stdout).toContain("Reply (replace answer values)")
}, 30_000)

test("the released TUI entrypoint accepts API operation commands as well as decision list", async () => {
  const result = await cli(["decision.list"], ["api"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.requests).toEqual(["decision.list"])
  expect(JSON.parse(result.stdout)).toEqual({ data: items })
}, 30_000)

test("the released TUI entrypoint replays exact decide argv with both path parameters and its JSON body", async () => {
  const result = await cli(items[0]!.decide[0]!.argv.slice(2), ["api"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toBe("")
  expect(result.requests).toEqual(["session.permission.reply"])
}, 30_000)

test("decision list --json prints raw items with exact argv and template markers", async () => {
  const result = await cli(["--json"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.requests).toEqual(["/api/decision"])
  expect(JSON.parse(result.stdout)).toEqual(items)
}, 30_000)

test("named operations report typed v5 errors without retrying the request", async () => {
  const result = await cli(["session.archive", "--param", "sessionID=ses_missing"], ["api"])
  expect(result.exit).not.toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Synthetic Session missing" })
  expect(result.stderr).toBe("ycoding: API request failed: SessionNotFoundError\n")
  expect(result.requests).toEqual(["session.archive"])
}, 30_000)

for (const [status, body] of [
  [404, ' { "_tag": "SessionNotFoundError", "message": "Synthetic Session missing" }\n'],
  [500, "Synthetic server failure"],
  [403, ""],
] as const) {
  test(`api HTTP ${status} preserves stdout and exits nonzero with one status line on stderr`, async () => {
    const result = await cli(["POST", "/api/session/ses_missing/archive"], ["api"], (request) =>
      new URL(request.url).pathname === "/api/session/ses_missing/archive" ? new Response(body, { status }) : undefined,
    )
    expect(result.stdout).toBe(body && !body.endsWith("\n") ? `${body}\n` : body)
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toBe(`ycoding: API request failed: HTTP ${status}\n`)
    expect(result.requests).toEqual(["/api/session/ses_missing/archive"])
  }, 30_000)
}

for (const [name, args, message, requests] of [
  ["invalid header", ["GET", "/api/decision", "--header", "invalid"], "Invalid header, expected name:value: invalid", []],
  ["unknown operation", ["synthetic.unknown"], "Operation not found: synthetic.unknown", []],
  ["missing path parameter", ["session.archive"], "Missing path parameter: sessionID", []],
] as const) {
  test(`api retains its ${name} failure`, async () => {
    const result = await cli([...args], ["api"])
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain(message)
    expect(result.stdout).toBe("")
    expect(result.requests).toEqual([...requests])
  }, 30_000)
}
