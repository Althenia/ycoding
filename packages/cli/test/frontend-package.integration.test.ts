import { expect, test } from "bun:test"
import { resolveFrontendPackage } from "../src/services/frontend-package"
import { v5Server } from "./fixture/v5-server"

test("frontend package resolution consumes the backend entrypoint asset over v5", async () => {
  const requests: unknown[] = []
  const server = v5Server((name, input) => {
    expect(name).toBe("frontendPackage.resolve")
    requests.push(input)
    return {
      data: {
        name: "fixture-theme",
        version: "1.0.0",
        digest: "a".repeat(64),
        root: "/backend/packages/fixture",
        entrypoint: { path: "/backend/packages/fixture/tui/index.js", digest: "b".repeat(64) },
      },
    }
  })
  try {
    expect(await resolveFrontendPackage({ url: server.url }, "fixture-theme@1.0.0")).toBe(
      "/backend/packages/fixture/tui/index.js",
    )
    expect(requests).toEqual([
      { query: { location: { directory: process.cwd() } }, payload: { spec: "fixture-theme@1.0.0" } },
    ])
  } finally {
    await server.close()
  }
})

test("frontend package rejection propagates instead of returning an unverified local entrypoint", async () => {
  const server = v5Server(() => new Error("rejected package"))
  try {
    await expect(resolveFrontendPackage({ url: server.url }, "fixture-rejected@1.0.0")).rejects.toThrow()
  } finally {
    await server.close()
  }
})
