import { expect, test } from "bun:test"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"

const items = [{ kind: "permission", sessionID: "ses_synthetic", sessionTitle: "Synthetic", directory: "/tmp/with space", id: "per_synthetic", summary: "edit file.txt",
  decide: [{ label: "Once", argv: ["ycoding", "api", "session.permission.reply", "--param", "sessionID=ses_synthetic", "--param", "requestID=per_synthetic", "--data", '{"reply":"once"}'] }],
}, { kind: "form", sessionID: "ses_synthetic", sessionTitle: "Synthetic", directory: "/tmp/with space", id: "frm_synthetic", summary: "Enter name",
  decide: [{ label: "Reply (replace answer values)", template: true, argv: ["ycoding", "api", "session.form.reply", "--param", "sessionID=ses_synthetic", "--param", "formID=frm_synthetic", "--data", '{"answer":{"name":"<answer:name>"}}'] }],
}]

async function cli(args: string[], command = ["decision", "list"], respond?: (request: Request) => Response | undefined) {
  const requests: string[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/api/health") return Response.json({ healthy: true, version: InstallationVersion, pid: process.pid })
    requests.push(path)
    expect(request.headers.has("x-ycoding-directory")).toBe(false)
    const response = respond?.(request)
    if (response) return response
    if (path === "/openapi.json") return Response.json({ paths: {
      "/api/decision": { get: { operationId: "decision.list" } },
      "/api/session/{sessionID}/permission/{requestID}/reply": { post: { operationId: "session.permission.reply" } },
      "/api/session/{sessionID}/archive": { post: { operationId: "session.archive" } },
    } })
    if (path === "/api/session/ses_synthetic/permission/per_synthetic/reply" && request.method === "POST") {
      expect(await request.json()).toEqual({ reply: "once" })
      return new Response(null, { status: 204 })
    }
    return path === "/api/decision" ? Response.json({ data: items }) : new Response("not found", { status: 404 })
  } })
  try {
    const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, ...command, ...args, "--server", server.url.toString()], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, exit, requests }
  } finally { server.stop(true) }
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
  expect(result.requests).toEqual(["/openapi.json", "/api/decision"])
  expect(JSON.parse(result.stdout)).toEqual({ data: items })
}, 30_000)

test("the released TUI entrypoint replays exact decide argv with both path parameters and its JSON body", async () => {
  const result = await cli(items[0]!.decide[0]!.argv.slice(2), ["api"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toBe("")
  expect(result.requests).toEqual(["/openapi.json", "/api/session/ses_synthetic/permission/per_synthetic/reply"])
}, 30_000)

test("decision list --json prints raw items with exact argv and template markers", async () => {
  const result = await cli(["--json"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.requests).toEqual(["/api/decision"])
  expect(JSON.parse(result.stdout)).toEqual(items)
}, 30_000)

for (const [status, body] of [
  [404, ' { "_tag": "SessionNotFoundError", "message": "Synthetic Session missing" }\n'],
  [500, "Synthetic server failure"],
  [403, ""],
] as const) {
  test(`api HTTP ${status} preserves stdout and exits nonzero with one status line on stderr`, async () => {
    const result = await cli(["session.archive", "--param", "sessionID=ses_missing"], ["api"], (request) =>
      new URL(request.url).pathname === "/api/session/ses_missing/archive" ? new Response(body, { status }) : undefined,
    )
    expect(result.stdout).toBe(body && !body.endsWith("\n") ? `${body}\n` : body)
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toBe(`ycoding: API request failed: HTTP ${status}\n`)
    expect(result.requests).toEqual(["/openapi.json", "/api/session/ses_missing/archive"])
  }, 30_000)
}

for (const [name, args, message, requests] of [
  ["invalid header", ["GET", "/api/decision", "--header", "invalid"], "Invalid header, expected name:value: invalid", []],
  ["unknown operation", ["synthetic.unknown"], "Operation not found: synthetic.unknown", ["/openapi.json"]],
  ["missing path parameter", ["session.archive"], "Missing path parameter: sessionID", ["/openapi.json"]],
  ["OpenAPI load failure", ["decision.list"], "Failed to load OpenAPI document: HTTP 503", ["/openapi.json"]],
] as const) {
  test(`api retains its ${name} failure`, async () => {
    const result = await cli([...args], ["api"], name === "OpenAPI load failure"
      ? (request) => new URL(request.url).pathname === "/openapi.json" ? new Response("unavailable", { status: 503 }) : undefined
      : undefined)
    expect(result.exit).not.toBe(0)
    expect(result.stdout).toContain(message)
    expect(result.stderr).toBe("")
    expect(result.requests).toEqual([...requests])
  }, 30_000)
}
