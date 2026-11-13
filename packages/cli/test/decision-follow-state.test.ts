import { expect, test } from "bun:test"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@ycoding-ai/core/global"
import { followLedgerLimit, openFollowState, validateFollowState, type FollowState } from "../src/commands/handlers/decision/follow-state"

const server = "a".repeat(64)
const state = (): FollowState => ({ version: 1, rootSessionID: "ses_root", server, cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] })

for (const [name, change] of [
  ["root", { rootSessionID: "ses_other" }],
  ["server", { server: "b".repeat(64) }],
  ["unknown fields", { secret: "NEVER-STORE" }],
  ["epoch", { sourceEpoch: "private/path" }],
  ["missing root cursor", { sourceEpoch: "epoch_one", cursors: [] }],
  ["missing epoch", { cursors: [{ sessionID: "ses_root", after: 1 }] }],
  ["negative cursor", { cursors: [{ sessionID: "ses_root", after: -1 }] }],
  ["duplicate cursor", { cursors: [{ sessionID: "ses_root" }, { sessionID: "ses_root" }] }],
  ["pending fields", { pending: [{ kind: "permission", sessionID: "ses_root", id: "per_synthetic", summary: "secret" }] }],
  ["ledger shape", { requestSeen: ["invalid"] }],
  ["ledger duplicates", { terminalSeen: ["form\0ses_root\0frm_synthetic", "form\0ses_root\0frm_synthetic"] }],
  ["ledger bound", { seen: Array.from({ length: followLedgerLimit + 1 }, (_, index) => `ses_root\0evt_synthetic\0${index}`) }],
  ["delivery fields", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [], secret: "NEVER-STORE" }] } }],
  ["delivery thread", { delivery: { announced: [], targets: [{ target: "", outbox: [] }] } }],
  ["delivery thread control characters", { delivery: { announced: [], targets: [{ target: "thr\nroot", outbox: [] }] } }],
  ["delivery duplicate thread", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [] }, { target: "thr_root", outbox: [] }] } }],
  ["delivery target bound", { delivery: { announced: [], targets: Array.from({ length: 9 }, (_, index) => ({ target: `thr_${index}`, outbox: [] })) } }],
  ["delivery missing targets", { delivery: { announced: [], targets: [] } }],
  ["delivery event type", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_root", id: "evt_one", type: "session.step.started", seq: 1 }] }] } }],
  ["delivery event without sequence", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_root", id: "evt_one", type: "session.execution.started" }] }] } }],
  ["delivery event kind", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_root", id: "per_one", requestKind: "secret" }] }] } }],
  ["delivery ownership with sequence", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_member", id: "grp_one", type: "owner-changed", revision: 1, seq: 1 }] }] } }],
  ["delivery ownership without revision", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_member", id: "grp_one", type: "owner-released" }] }] } }],
  ["delivery owner on a lifecycle event", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_root", id: "evt_one", type: "session.execution.started", seq: 1, ownerSessionID: "ses_owner" }] }] } }],
  ["delivery event both kinds", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_root", id: "per_one", requestKind: "permission", type: "session.execution.started", seq: 1 }] }] } }],
  ["delivery message ID", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [], inflight: { threadID: "thr_root", clientMessageID: "random", events: [{ sessionID: "ses_root", id: "per_one", requestKind: "permission" }] } }] } }],
  ["delivery empty batch", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [], inflight: { threadID: "thr_root", clientMessageID: "00000000-0000-8000-8000-000000000000", events: [] } }] } }],
  ["delivery announced", { delivery: { announced: ["invalid"], targets: [{ target: "thr_root", outbox: [] }] } }],
  ["delivery announced duplicates", { delivery: { announced: ["permission\0ses_root\0per_one", "permission\0ses_root\0per_one"], targets: [{ target: "thr_root", outbox: [] }] } }],
  ["delivery dot batch without a resolved thread", { delivery: { announced: [], targets: [{ target: "dot", outbox: [], inflight: { threadID: "dot", clientMessageID: "00000000-0000-8000-8000-000000000000", events: [{ sessionID: "ses_root", id: "per_one", requestKind: "permission" }] } }] } }],
  ["delivery batch on another thread", { delivery: { announced: [], targets: [{ target: "thr_root", outbox: [], inflight: { threadID: "thr_other", clientMessageID: "00000000-0000-8000-8000-000000000000", events: [{ sessionID: "ses_root", id: "per_one", requestKind: "permission" }] } }] } }],
  ["delivery snapshot without members", { delivery: { announced: [], targets: [{ target: "dot", outbox: [{ sessionID: "ses_root", id: "grp_one", snapshot: true, revision: 1, members: [] }] }] } }],
  ["delivery snapshot with a change type", { delivery: { announced: [], targets: [{ target: "dot", outbox: [{ sessionID: "ses_root", id: "grp_one", snapshot: true, type: "owner-changed", revision: 1, members: [{ sessionID: "ses_member" }] }] }] } }],
  ["delivery members on a change", { delivery: { announced: [], targets: [{ target: "dot", outbox: [{ sessionID: "ses_member", id: "grp_one", type: "owner-changed", revision: 1, members: [{ sessionID: "ses_member" }] }] }] } }],
] as const) {
  test(`follow state rejects ${name}`, () => {
    expect(() => validateFollowState({ ...state(), ...change }, "ses_root", server)).toThrow()
  })
}

async function directory() {
  const root = path.join(Global.Path.data, "tasks")
  await mkdir(root, { recursive: true })
  return realpath(await mkdtemp(path.join(root, "decision-follow-test-")))
}

test("follow state is private, atomic, restorable and has one owned writer", async () => {
  const dir = await directory()
  const filename = path.join(dir, "state.json")
  try {
    const first = await openFollowState(filename, "ses_root", server)
    await expect(openFollowState(filename, "ses_root", server)).rejects.toThrow()
    const saved = { ...first.state, sourceEpoch: "epoch_one", cursors: [{ sessionID: "ses_root", after: 2 }],
      pending: [{ kind: "form", sessionID: "ses_root", id: "frm_synthetic" }], seen: [`ses_root\0evt_synthetic\0${2}`], requestSeen: ["form\0ses_root\0frm_synthetic"], terminalSeen: ["permission\0ses_root\0per_synthetic"] }
    await first.save(saved)
    expect((await lstat(filename)).mode & 0o077).toBe(0)
    await first.close()
    const second = await openFollowState(filename, "ses_root", server)
    expect(second.state).toEqual(saved)
    await second.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("follow state size exhaustion preserves the last atomic state", async () => {
  const dir = await directory()
  const filename = path.join(dir, "state.json")
  try {
    const store = await openFollowState(filename, "ses_root", server)
    try {
      await store.save(store.state)
      const before = await readFile(filename, "utf8")
      const large = { ...store.state, sourceEpoch: "epoch_one", cursors: [{ sessionID: "ses_root", after: 0 }],
        seen: Array.from({ length: followLedgerLimit }, (_, index) => `ses_root\0evt_${"x".repeat(240)}\0${index}`) }
      await expect(store.save(large)).rejects.toThrow(/size/)
      expect(await readFile(filename, "utf8")).toBe(before)
    } finally { await store.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("follow storage rejects a symlinked parent without touching its target", async () => {
  const dir = await directory()
  try {
    const real = path.join(dir, "real")
    await mkdir(real)
    await symlink(real, path.join(dir, "alias"))
    await expect(openFollowState(path.join(dir, "alias", "state.json"), "ses_root", server)).rejects.toThrow(path.join(real, "state.json"))
    await expect(readFile(path.join(real, "state.json.lock"))).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("follow state accepts and restores a well-formed delivery ledger", () => {
  const value = { ...state(), sourceEpoch: "epoch_one", cursors: [{ sessionID: "ses_root", after: 3 }], delivery: {
    announced: ["guardrail\0ses_root\0grq_one", "project-escalation:permission\0ses_child\0per_one"],
    targets: [
      { target: "dot", outbox: [{ sessionID: "ses_child", id: "evt_child", type: "session.execution.succeeded", seq: 4 },
        { sessionID: "ses_root", id: "grp_one", snapshot: true as const, revision: 2, members: [{ sessionID: "ses_member", ownerSessionID: "ses_owner" }, { sessionID: "ses_other" }] }],
        inflight: { threadID: "thr_root", clientMessageID: "0123abcd-0000-8000-8000-0123456789ab", events: [{ sessionID: "ses_root", id: "grq_one", requestKind: "guardrail", fingerprint: "f".repeat(64) }] } },
      { target: "task thread/1", outbox: [{ sessionID: "ses_child", id: "que_child", requestKind: "child-question", parentID: "ses_root", revision: 2 },
        { sessionID: "ses_child", id: "per_one", requestKind: "permission", escalated: true as const },
        { sessionID: "ses_member", id: "grp_one", type: "owner-changed", revision: 3, ownerSessionID: "ses_owner" },
        { sessionID: "ses_member", id: "grp_one", type: "owner-released", revision: 4, removed: true as const }] },
    ],
  } }
  expect(validateFollowState(structuredClone(value), "ses_root", server)).toEqual(value)
})

const parentRequirement = "its directory must be owned by the current user and not writable by group or others"

test("a symlinked state directory names a canonical path that opens end to end", async () => {
  const dir = await directory()
  try {
    const real = path.join(dir, "real")
    await mkdir(real, { mode: 0o700 })
    await symlink(real, path.join(dir, "alias"))
    const canonical = path.join(real, "state.json")
    await expect(openFollowState(path.join(dir, "alias", "state.json"), "ses_root", server)).rejects.toThrow(`use canonical --state ${JSON.stringify(canonical)}`)
    const store = await openFollowState(canonical, "ses_root", server)
    await store.save(store.state)
    await store.close()
    expect((await lstat(canonical)).isFile()).toBe(true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a symlinked state directory whose canonical directory is shared names no path and states the requirement", async () => {
  const dir = await directory()
  try {
    const real = path.join(dir, "shared")
    await mkdir(real)
    await chmod(real, 0o1777)
    await symlink(real, path.join(dir, "alias"))
    const error = await openFollowState(path.join(dir, "alias", "state.json"), "ses_root", server).then(() => undefined, (failure: unknown) => failure as Error)
    expect(error?.message).toStartWith("[state-invalid]")
    expect(error?.message).toContain(parentRequirement)
    expect(error?.message).toContain("omit --state to use the default private state location")
    expect(error?.message).not.toContain("use canonical")
    expect(error?.message).not.toContain(dir)
    await expect(readFile(path.join(real, "state.json.lock"))).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const mode of [0o777, 0o1777, 0o770, 0o722]) {
  test(`a state directory with mode ${mode.toString(8)} is rejected with its requirement`, async () => {
    const dir = await directory()
    try {
      const shared = path.join(dir, "shared")
      await mkdir(shared)
      await chmod(shared, mode)
      const error = await openFollowState(path.join(shared, "state.json"), "ses_root", server).then(() => undefined, (failure: unknown) => failure as Error)
      expect(error?.message).toStartWith("[state-invalid]")
      expect(error?.message).toContain(parentRequirement)
      expect(error?.message).not.toContain(dir)
      await expect(readFile(path.join(shared, "state.json.lock"))).rejects.toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test("a private state directory is accepted", async () => {
  const dir = await directory()
  try {
    const owned = path.join(dir, "owned")
    await mkdir(owned)
    await chmod(owned, 0o700)
    const store = await openFollowState(path.join(owned, "state.json"), "ses_root", server)
    await store.save(store.state)
    await store.close()
    expect((await lstat(path.join(owned, "state.json"))).mode & 0o077).toBe(0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const mode of ["invalid", "symlink", "hardlink", "permissions", "replaced", "directory", "oversized"] as const) {
  test(`follow storage refuses ${mode} without replacing existing data`, async () => {
    const dir = await directory()
    const filename = path.join(dir, "state.json")
    const sentinel = path.join(dir, "sentinel.json")
    try {
      await writeFile(sentinel, "preserve", { mode: 0o600 })
      if (mode === "symlink") await symlink(sentinel, filename)
      else if (mode === "hardlink") await link(sentinel, filename)
      else if (mode === "invalid") await writeFile(filename, "not JSON", { mode: 0o600 })
      else if (mode === "directory") await mkdir(filename)
      else if (mode === "oversized") await writeFile(filename, "x".repeat(1024 * 1024 + 1), { mode: 0o600 })
      else if (mode === "permissions") { await writeFile(filename, JSON.stringify(state()), { mode: 0o600 }); await chmod(filename, 0o644) }
      if (mode === "replaced") {
        const store = await openFollowState(filename, "ses_root", server)
        await symlink(sentinel, filename)
        await expect(store.save(state())).rejects.toThrow(/replaced/)
        await store.close()
      } else await expect(openFollowState(filename, "ses_root", server)).rejects.toThrow()
      expect(await readFile(sentinel, "utf8")).toBe("preserve")
      if (mode === "invalid") expect(await readFile(filename, "utf8")).toBe("not JSON")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
