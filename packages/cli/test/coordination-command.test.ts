import { expect, test } from "bun:test"
import { coordinationRequest } from "../src/commands/coordination"

test("shipped CLI advertises local coordination controls without starting a server", async () => {
  const process = Bun.spawn(["bun", new URL("../src/tui.ts", import.meta.url).pathname, "coordination", "--help"], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  expect(code, stderr).toBe(0)
  expect(stdout).toContain("Manage local coordination groups")
  expect(stdout).toContain("--group")
  expect(stdout).toContain("--data")
})

test("coordination CLI addresses only fixed local operations by group identity", () => {
  expect(coordinationRequest("list")).toEqual({ method: "GET", path: "/api/coordination" })
  expect(coordinationRequest("get", "cgrp_one")).toEqual({ method: "GET", path: "/api/coordination/cgrp_one" })
  expect(coordinationRequest("create", undefined, '{"title":"Release"}')).toEqual({ method: "POST", path: "/api/coordination", body: { title: "Release" } })
  expect(coordinationRequest("members", "cgrp_one", '{"revision":1,"members":[]}')).toEqual({ method: "PUT", path: "/api/coordination/cgrp_one/members", body: { revision: 1, members: [] } })
  expect(coordinationRequest("arm", "cgrp_one", '{"revision":2}')).toEqual({ method: "POST", path: "/api/coordination/cgrp_one/arm", body: { revision: 2 } })
  expect(coordinationRequest("stop", "cgrp_one", '{"revision":3}')).toEqual({ method: "POST", path: "/api/coordination/cgrp_one/stop", body: { revision: 3 } })
  for (const action of ["receipts", "capacity"])
    expect(coordinationRequest(action, "cgrp_one")).toEqual({ method: "GET", path: `/api/coordination/cgrp_one/${action}` })
})

test("coordination CLI rejects arbitrary routes, malformed identities and invalid JSON before transport", () => {
  for (const action of ["/api/config", "shell", "../stop"])
    expect(() => coordinationRequest(action, "cgrp_one")).toThrow()
  for (const id of [undefined, "../other", "cgrp_a/b", "https://host", "ses_one"])
    expect(() => coordinationRequest("get", id)).toThrow()
  for (const data of ["{", "[]", "null", '"text"'])
    expect(() => coordinationRequest("create", undefined, data)).toThrow()
  expect(() => coordinationRequest("get", "cgrp_one", "{}")).toThrow()
  expect(() => coordinationRequest("arm", "cgrp_one")).toThrow()
})
