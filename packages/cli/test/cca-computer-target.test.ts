import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { createCcaComputerControl } from "../src/remote-control/cca-computer"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const principal = { enabled: true as const, accessRevision: 1, profile: "desk", credentialID: "cred-synthetic", accountID: "account-synthetic", accountGeneration: 1 }
const enrollment = { status: "completed", installationID: "install-synthetic", executorID: "env-synthetic", accountHash: createHash("sha256").update(principal.accountID).digest("hex") }

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cca-target-"))
  dirs.push(dir)
  const statePath = path.join(dir, "cca.json")
  await writeFile(statePath, JSON.stringify(enrollment))
  let config: NativeDots.Configuration = principal
  let token = "synthetic-token"
  let name = "Named desk"
  let dotID = "dot-synthetic"
  let attached = false
  let attachAfterPost = true
  let delay: (() => Promise<void>) | undefined
  let postDelay: (() => Promise<void>) | undefined
  let failReads = false
  let configurationReads = 0
  const configWaiters: { count: number; resolve: () => void }[] = []
  const posts: { url: string; headers: Headers }[] = []
  const control = createCcaComputerControl({
    statePath,
    native: {
      configuration: async () => {
        configurationReads++
        for (const waiter of configWaiters) if (configurationReads >= waiter.count) waiter.resolve()
        return config
      },
      credential: async () => config.enabled ? { ...config, key: "synthetic-key", access: token } : undefined,
    },
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        posts.push({ url, headers: new Headers(init.headers) })
        await postDelay?.()
        attached = attachAfterPost
        return new Response(null, { status: 204 })
      }
      if (url.includes("/computers?")) {
        if (failReads) throw new Error("synthetic read failure")
        await delay?.()
        return Response.json({ thread_id: "thread-synthetic", computers: [
          { environment_id: "env-other", display_name: name, is_attached: false, can_connect: true },
          { environment_id: enrollment.executorID, display_name: name, is_attached: attached, can_connect: true },
        ] })
      }
      if (url.includes("/root-thread")) return Response.json({ root_thread_id: "thread-synthetic" })
      return Response.json({ items: [{ id: dotID, status: "active" }], cursor: null })
    },
  })
  return { control, posts, statePath,
    configure: (value: NativeDots.Configuration) => { config = value },
    rename: (value: string) => { name = value },
    token: (value: string) => { token = value },
    dot: (value: string) => { dotID = value },
    delay: (value?: () => Promise<void>) => { delay = value },
    postDelay: (value?: () => Promise<void>) => { postDelay = value },
    failReads: () => { failReads = true },
    remainDetached: () => { attachAfterPost = false },
    configurationReads: () => configurationReads,
    afterConfigurationReads: (count: number) => configurationReads >= count ? Promise.resolve() : new Promise<void>((resolve) => { configWaiters.push({ count, resolve }) }),
  }
}

test("observed names are presentation only and target receipts identify the enrolled environment", async () => {
  const f = await fixture()
  const before = await f.control.computer()
  expect(before.name).toBe("Named desk")
  expect(before.target).toEqual({ dotID: "dot-synthetic", threadID: "thread-synthetic", environmentID: enrollment.executorID, revision: expect.stringMatching(/^[a-f0-9]{64}$/) })
  const sent = JSON.stringify(before)
  for (const value of [principal.accountID, principal.credentialID, "synthetic-token"]) expect(sent).not.toContain(value)
  f.rename("Renamed desk")
  await writeFile(f.statePath, JSON.stringify({ ...enrollment, updatedAt: "later", displayName: "Renamed desk" }))
  const result = await f.control.attach(before.target)
  expect(result.state).toBe("attached")
  expect(result.name).toBe("Renamed desk")
  expect(result.target).toEqual(before.target)
  expect(f.posts).toHaveLength(1)
  expect(f.posts[0]!.url).toContain("/computers/env-synthetic/connect-and-replace?")
})

test("a displayed target cannot drift to another Dot before confirmation", async () => {
  const f = await fixture()
  const observed = await f.control.computer()
  f.dot("dot-new")
  expect(await f.control.attach(observed.target)).toMatchObject({ state: "unavailable", problem: "target-changed" })
  expect(f.posts).toEqual([])
})

test.each(["off", "revision", "generation", "executor", "status", "account"] as const)("%s changes during discovery prevent attachment and old-context publication", async (change) => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.delay(async () => { entered.resolve(); await release.promise })
  const pending = f.control.attach()
  await entered.promise
  if (change === "off") f.configure({ enabled: false })
  if (change === "revision") f.configure({ ...principal, accessRevision: 3 })
  if (change === "generation") f.configure({ ...principal, accountGeneration: 2 })
  if (["executor", "status", "account"].includes(change)) await writeFile(f.statePath, JSON.stringify({ ...enrollment,
    ...(change === "executor" ? { executorID: "env-new" } : {}),
    ...(change === "status" ? { status: "pending" } : {}),
    ...(change === "account" ? { accountHash: "mismatch" } : {}),
  }))
  release.resolve()
  expect((await pending).state).toBe("unavailable")
  expect(f.posts).toEqual([])
})

test("a stale receipt revision never dispatches, even when its tuple still matches", async () => {
  const f = await fixture()
  const observed = await f.control.computer()
  expect(await f.control.attach({ ...observed.target!, revision: "b".repeat(64) })).toMatchObject({ state: "unavailable", problem: "target-changed" })
  expect(f.posts).toEqual([])
})

test.each(["status", "account"] as const)("cached status validates enrollment %s before reuse", async (change) => {
  const f = await fixture()
  await f.control.attach()
  await writeFile(f.statePath, JSON.stringify({ ...enrollment, ...(change === "status" ? { status: "pending" } : { accountHash: "mismatch" }) }))
  expect(await f.control.computer()).toMatchObject({ state: "unavailable", problem: "enrollment" })
})

test("the dispatch uses a refreshed token from the same pinned principal", async () => {
  const f = await fixture()
  f.delay(async () => { f.token("synthetic-refreshed") })
  expect((await f.control.attach()).state).toBe("attached")
  expect(f.posts[0]!.headers.get("authorization")).toBe("Bearer synthetic-refreshed")
})

test("a different principal does not join an in-flight attachment and its old result is not published", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.postDelay(async () => { entered.resolve(); await release.promise })
  const first = f.control.attach()
  await entered.promise
  f.configure({ enabled: false })
  expect(await f.control.attach()).toMatchObject({ state: "unavailable", problem: "configuration" })
  release.resolve()
  expect((await first).state).toBe("unavailable")
  expect(f.posts).toHaveLength(1)
})

test.each(["configuration", "enrollment", "read", "target"] as const)("an already sent POST with unreconciled %s reports unconfirmed without replay", async (change) => {
  const f = await fixture()
  f.postDelay(async () => {
    if (change === "configuration") f.configure({ enabled: false })
    if (change === "enrollment") await writeFile(f.statePath, JSON.stringify({ ...enrollment, status: "pending" }))
    if (change === "read") f.failReads()
    if (change === "target") f.dot("dot-other")
  })
  const result = await f.control.attach()
  expect(result).toMatchObject({ problem: "unconfirmed" })
  expect(result.state).not.toBe("attached")
  expect(f.posts).toHaveLength(1)
  if (change === "read") expect(await f.control.computer()).toEqual(result)
  expect(f.posts).toHaveLength(1)
})

test("unconfirmed detached reconciliation is cached instead of plain detached", async () => {
  const f = await fixture()
  f.remainDetached()
  const result = await f.control.attach()
  expect(result.problem).toBe("unconfirmed")
  expect(await f.control.computer()).toEqual(result)
  expect(f.posts).toHaveLength(1)
})

test("equal expected-target tuples coalesce even with different property insertion order", async () => {
  const f = await fixture()
  const target = (await f.control.computer()).target!
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.postDelay(async () => { entered.resolve(); await release.promise })
  const first = f.control.attach(target)
  await entered.promise
  const reordered = { revision: target.revision, environmentID: target.environmentID, threadID: target.threadID, dotID: target.dotID }
  const readCount = f.configurationReads()
  const second = f.control.attach(reordered)
  await f.afterConfigurationReads(readCount + 2)
  await new Promise<void>((resolve) => setImmediate(resolve))
  release.resolve()
  const results = await Promise.all([first, second])
  expect(f.posts).toHaveLength(1)
  expect(results[0]).toEqual(results[1])
})
