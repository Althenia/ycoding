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
    await expect(openFollowState(path.join(dir, "alias", "state.json"), "ses_root", server)).rejects.toThrow(/symlink/)
    await expect(readFile(path.join(real, "state.json.lock"))).rejects.toThrow()
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
