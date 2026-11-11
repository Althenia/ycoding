import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { createMeetingMemoryStore } from "../src/knowledge-memory"

const contentFor = (title: string, body: string) => `---\ntype: decision\ntitle: ${title}\ntags: [meeting, retrieval]\n---\n\n${body}\n`

async function git(directory: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const exit = await proc.exited
  if (exit !== 0) throw new Error(await new Response(proc.stderr).text())
}

test("repository memory create read search replace with core repo key", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-repo-"))
  const dataHome = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-data-"))
  try {
    await git(directory, ["init", "-q"])
    const commonRaw = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: directory })
    const commonText = new TextDecoder().decode(commonRaw.stdout).trim()
    const commonAbsolute = path.isAbsolute(commonText) ? commonText : path.resolve(directory, commonText)
    const canonical = await fs.realpath(commonAbsolute)
    const expectedKey = `repo_${createHash("sha256").update(canonical, "utf8").digest("hex")}`
    const expectedRoot = path.join(dataHome, "ycoding", "memory", "repository", expectedKey)

    const store = createMeetingMemoryStore({ directory, dataHome })
    const note = contentFor("Retrieval Note", "Latency budget for vector retrieval in meetings.")
    const created = await store.apply({ scope: "repository", id: "voice/retrieval-note", operation: "create", content: note, expectedRevision: "new" })
    expect(created.status).toBe("applied")
    if (created.status !== "applied") throw new Error("expected applied")
    expect(created.revision).toBe(createHash("sha256").update(note, "utf8").digest("hex"))
    expect(await fs.readFile(path.join(expectedRoot, "voice", "retrieval-note.md"), "utf8")).toBe(note)

    const rootMode = (await fs.stat(expectedRoot)).mode & 0o777
    const fileMode = (await fs.stat(path.join(expectedRoot, "voice", "retrieval-note.md"))).mode & 0o777
    const dirMode = (await fs.stat(path.join(expectedRoot, "voice"))).mode & 0o777
    expect(rootMode).toBe(0o700)
    expect(dirMode).toBe(0o700)
    expect(fileMode).toBe(0o600)

    const read = await store.read({ scope: "repository", id: "voice/retrieval-note" })
    expect(read?.content).toBe(note)
    expect(read?.title).toBe("Retrieval Note")
    expect(read?.type).toBe("decision")
    expect(read?.tags).toEqual(["meeting", "retrieval"])
    expect(read?.revision).toBe(created.revision)

    const hits = await store.search({ scope: "repository", query: "vector retrieval" })
    expect(hits.map((hit) => hit.id)).toContain("voice/retrieval-note")

    const updated = contentFor("Retrieval Note", "Updated latency budget for vector retrieval.")
    const replaced = await store.apply({ scope: "repository", id: "voice/retrieval-note", operation: "replace", content: updated, expectedRevision: created.revision })
    expect(replaced.status).toBe("applied")
    expect(await store.read({ scope: "repository", id: "voice/retrieval-note" })).toMatchObject({ content: updated })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(dataHome, { recursive: true, force: true })
  }
})

test("repository memory worktree resolves to same store", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-main-"))
  const dataHome = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-data-"))
  const worktree = `${directory}-linked`
  try {
    await git(directory, ["init", "-q"])
    await git(directory, ["config", "user.email", "test@example.com"])
    await git(directory, ["config", "user.name", "Test"])
    await fs.writeFile(path.join(directory, "README.md"), "seed\n")
    await git(directory, ["add", "README.md"])
    await git(directory, ["commit", "-qm", "seed"])
    await git(directory, ["worktree", "add", "-q", worktree, "HEAD"])
    const storeA = createMeetingMemoryStore({ directory, dataHome })
    const storeB = createMeetingMemoryStore({ directory: worktree, dataHome })
    const note = contentFor("Shared", "Worktree shared retrieval note.")
    const created = await storeA.apply({ scope: "repository", id: "shared-note", operation: "create", content: note, expectedRevision: "new" })
    expect(created.status).toBe("applied")
    expect((await storeB.read({ scope: "repository", id: "shared-note" }))?.content).toBe(note)
  } finally {
    await git(directory, ["worktree", "remove", "--force", worktree]).catch(() => undefined)
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(worktree, { recursive: true, force: true })
    await fs.rm(dataHome, { recursive: true, force: true })
  }
})

test("stale replace does not mutate disk and concurrent create collides", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-stale-"))
  const dataHome = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-data-"))
  try {
    await git(directory, ["init", "-q"])
    const store = createMeetingMemoryStore({ directory, dataHome })
    const note = contentFor("Original", "Original body for stale checks.")
    const created = await store.apply({ scope: "knowledge", id: "stale-note", operation: "create", content: note, expectedRevision: "new" })
    expect(created.status).toBe("applied")
    const stale = await store.apply({ scope: "knowledge", id: "stale-note", operation: "replace", content: contentFor("Changed", "Changed body."), expectedRevision: "0".repeat(64) })
    expect(stale).toEqual({ status: "stale", error: "Concept changed on disk; reconcile and review a fresh proposal" })
    expect((await store.read({ scope: "knowledge", id: "stale-note" }))?.content).toBe(note)

    const results = await Promise.all([
      store.apply({ scope: "knowledge", id: "race-note", operation: "create", content: contentFor("Race", "Race body one."), expectedRevision: "new" }),
      store.apply({ scope: "knowledge", id: "race-note", operation: "create", content: contentFor("Race", "Race body two."), expectedRevision: "new" }),
    ])
    expect(results.filter((item) => item.status === "applied")).toHaveLength(1)
    expect(results.filter((item) => item.status === "stale")).toHaveLength(1)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(dataHome, { recursive: true, force: true })
  }
})

test("invalid ids and missing frontmatter type are rejected", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-invalid-"))
  const dataHome = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-data-"))
  try {
    await git(directory, ["init", "-q"])
    const store = createMeetingMemoryStore({ directory, dataHome })
    const valid = contentFor("Valid", "Valid body.")
    await expect(store.apply({ scope: "knowledge", id: "../escape", operation: "create", content: valid, expectedRevision: "new" })).rejects.toThrow()
    await expect(store.apply({ scope: "knowledge", id: "index", operation: "create", content: valid, expectedRevision: "new" })).rejects.toThrow()
    await expect(store.apply({ scope: "knowledge", id: "UpperCase", operation: "create", content: valid, expectedRevision: "new" })).rejects.toThrow()
    await expect(store.read({ scope: "knowledge", id: "../escape" })).rejects.toThrow()
    await expect(store.apply({ scope: "knowledge", id: "no-type", operation: "create", content: "---\ntitle: Missing\n---\n\nBody\n", expectedRevision: "new" })).rejects.toThrow()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(dataHome, { recursive: true, force: true })
  }
})

test("repository scope outside git fails cleanly", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-nogit-"))
  const dataHome = await fs.mkdtemp(path.join(tmpdir(), "meeting-memory-data-"))
  try {
    const store = createMeetingMemoryStore({ directory, dataHome })
    expect(await store.search({ scope: "repository", query: "anything retrieval" })).toEqual([])
    expect(await store.read({ scope: "repository", id: "some-note" })).toBeUndefined()
    await expect(store.apply({ scope: "repository", id: "some-note", operation: "create", content: contentFor("Nope", "Body."), expectedRevision: "new" })).rejects.toThrow("Repository memory requires a Git repository; use knowledge scope")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(dataHome, { recursive: true, force: true })
  }
})
