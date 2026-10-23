import { expect, test } from "bun:test"
import { coordinationRequest } from "../src/commands/coordination"

test("CLI advertises Project management without starting a server", async () => {
  const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "coordination", "--help"], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(exit).toBe(0)
  expect(stderr).toBe("")
  expect(stdout).toContain("Manage Projects")
  expect(stdout).toContain("list, get, create, update or delete")
})

test("CLI addresses the five fixed Project management routes", () => {
  expect(coordinationRequest("list")).toEqual({ method: "GET", path: "/api/coordination" })
  expect(coordinationRequest("get", "cgrp_one")).toEqual({ method: "GET", path: "/api/coordination/cgrp_one" })
  const body = { name: "Project", masterSessionID: "ses_master", memberSessionIDs: [] }
  expect(coordinationRequest("create", undefined, JSON.stringify(body))).toEqual({ method: "POST", path: "/api/coordination", body })
  expect(coordinationRequest("update", "cgrp_one", '{"revision":1,"name":"Renamed"}')).toEqual({ method: "PATCH", path: "/api/coordination/cgrp_one", body: { revision: 1, name: "Renamed" } })
  expect(coordinationRequest("delete", "cgrp_one")).toEqual({ method: "DELETE", path: "/api/coordination/cgrp_one" })
})

test("CLI rejects malformed routing and JSON before transport", () => {
  for (const action of ["unknown", "../session", "settings"]) expect(() => coordinationRequest(action, "cgrp_one")).toThrow()
  for (const id of [undefined, "bad", "cgrp_../escape"]) expect(() => coordinationRequest("get", id)).toThrow()
  for (const data of ["null", "[]", "1", "{"]) expect(() => coordinationRequest("create", undefined, data)).toThrow()
  expect(() => coordinationRequest("list", "cgrp_one")).toThrow()
  for (const action of ["get", "delete"]) expect(() => coordinationRequest(action, "cgrp_one", "{}")).toThrow()
  expect(() => coordinationRequest("update", "cgrp_one")).toThrow()
})

test("CLI prints data envelopes, accepts empty deletion responses and preserves backend errors", async () => {
  const seen: { method: string; path: string; body: string }[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/api/health") return Response.json({ healthy: true, version: "test", pid: process.pid })
    seen.push({ method: request.method, path, body: await request.text() })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    if (request.method === "PATCH") return Response.json({ reason: "Coordination.ConflictError", message: "Stale revision" }, { status: 409 })
    return Response.json({ data: [{ id: "cgrp_one" }] })
  } })
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, new URL("../src/tui.ts", import.meta.url).pathname, "coordination", ...args, "--server", server.url.toString()], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, exit }
  }
  try {
    const listed = await run("list")
    expect(listed.exit).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual({ data: [{ id: "cgrp_one" }] })
    const deleted = await run("delete", "--group", "cgrp_one")
    expect(deleted.exit).toBe(0)
    expect(deleted.stdout).toBe("")
    const updated = await run("update", "--group", "cgrp_one", "--data", '{"revision":1}')
    expect(updated.exit).toBe(1)
    expect(updated.stderr).toContain("Stale revision")
    expect(seen).toEqual([{ method: "GET", path: "/api/coordination", body: "" }, { method: "DELETE", path: "/api/coordination/cgrp_one", body: "" }, { method: "PATCH", path: "/api/coordination/cgrp_one", body: '{"revision":1}' }])
  } finally { server.stop(true) }
}, 30000)
