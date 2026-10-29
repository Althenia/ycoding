import { expect, test } from "bun:test"
import { dotsAttachConfirmed } from "../src/commands/dots"

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

test("dots attach explains replacement in help without starting a server", async () => {
  const result = await cli(["attach", "--help"])
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain("replacing your other attached computers")
  expect(result.stdout).toContain("--yes")
})

test("dots attach confirms only explicit yes answers", () => {
  for (const answer of ["y", "Y", "yes", " YES "]) expect(dotsAttachConfirmed(answer)).toBe(true)
  for (const answer of [undefined, "", "n", "no", "yess", "sure"]) expect(dotsAttachConfirmed(answer)).toBe(false)
})

test("dots attach posts explicit replacement consent with --yes and prints the re-read state", async () => {
  await withServer(status({ state: "detached" }), status({ state: "attached" }), async (url, seen) => {
    const result = await cli(["attach", "--yes", "--server", url])
    expect(result.exit).toBe(0)
    expect(result.stdout).toContain("Computer: detached")
    expect(result.stdout).toContain("detaches your other computers")
    expect(result.stdout).toContain("Computer: attached")
    expect(seen).toEqual([
      { method: "GET", path: "/api/dots", body: "" },
      { method: "POST", path: "/api/dots/computer", body: '{"replaceOthers":true}' },
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
