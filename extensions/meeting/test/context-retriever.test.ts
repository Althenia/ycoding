import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { createContextRetriever } from "../src/context-retriever"
import { createMeetingMemoryStore } from "../src/knowledge-memory"

async function git(directory: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const exit = await proc.exited
  if (exit !== 0) throw new Error(await new Response(proc.stderr).text())
}

test("retrieves skill, workspace doc, memory and MCP, skips secrets and escapes", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-context-"))
  const outside = await fs.mkdtemp(path.join(tmpdir(), "meeting-context-outside-"))
  const dataHome = await fs.mkdtemp(path.join(tmpdir(), "meeting-context-data-"))
  try {
    await git(directory, ["init", "-q"])
    await fs.mkdir(path.join(directory, "docs"), { recursive: true })
    await fs.writeFile(path.join(directory, "docs", "retrieval.md"), "# Retrieval\n\nVector retrieval latency budget for meetings and ranking notes.\n")
    await fs.writeFile(path.join(directory, ".env"), "retrieval secret value\n")
    await fs.writeFile(path.join(directory, ".env.local"), "retrieval secret value\n")
    await fs.writeFile(path.join(directory, "credentials.md"), "retrieval credentials should never appear\n")
    await fs.writeFile(path.join(directory, "secret-key.txt"), "retrieval secret key should never appear\n")
    await fs.writeFile(path.join(outside, "escaped.md"), "retrieval escaped outside workspace content\n")
    await fs.symlink(path.join(outside, "escaped.md"), path.join(directory, "docs", "escaped.md"))

    const memory = createMeetingMemoryStore({ directory, dataHome })
    const note = "---\ntype: decision\ntitle: Memory Retrieval\ntags: [retrieval]\n---\n\nMemory retrieval context for latency planning.\n"
    const created = await memory.apply({ scope: "repository", id: "retrieval-memory", operation: "create", content: note, expectedRevision: "new" })
    expect(created.status).toBe("applied")

    const retriever = createContextRetriever({
      directory,
      memory,
      listSkills: async () => [
        { id: "retrieval-skill", name: "Retrieval Skill", description: "Vector retrieval helpers", content: "Use vector retrieval ranking and latency budgets for meeting context." },
        { id: "unrelated", name: "Unrelated", content: "Cooking recipes and travel notes." },
      ],
      listReferences: async () => [{ path: "docs/escaped.md" }, { path: "../outside/escaped.md" }],
      retrieveMCP: async () => [{ server: "docs-mcp", target: "retrieval/guide", revision: "rev-1", content: "MCP retrieval guide with latency budget details." }],
    })

    const bundle = await retriever.retrieve({ query: "vector retrieval latency" })
    expect(bundle.skills.map((item) => item.id)).toEqual(["retrieval-skill"])
    expect(bundle.documents.map((item) => item.path)).toContain("docs/retrieval.md")
    expect(bundle.documents.map((item) => item.path)).not.toContain("docs/escaped.md")
    expect(JSON.stringify(bundle)).not.toContain("should never appear")
    expect(JSON.stringify(bundle)).not.toContain("escaped outside")
    expect(JSON.stringify(bundle)).not.toContain(".env")
    expect(bundle.knowledge.some((item) => item.source === "repository:retrieval-memory")).toBe(true)
    expect(bundle.knowledge.some((item) => item.source === "docs-mcp:retrieval/guide")).toBe(true)
    expect(bundle.sources).toContainEqual({ kind: "skill", id: "retrieval-skill", label: "Retrieval Skill" })
    expect(bundle.sources).toContainEqual({ kind: "document", id: "docs/retrieval.md", label: "docs/retrieval.md" })
    expect(bundle.sources.some((source) => source.kind === "knowledge" && source.id === "repository:retrieval-memory")).toBe(true)
    expect(bundle.sources.some((source) => source.kind === "mcp" && source.id === "docs-mcp:retrieval/guide")).toBe(true)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
    await fs.rm(dataHome, { recursive: true, force: true })
  }
})

test("enforces maxCharacters budget and survives MCP errors", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-context-budget-"))
  try {
    await fs.mkdir(path.join(directory, "docs"), { recursive: true })
    await fs.writeFile(path.join(directory, "docs", "retrieval.md"), "retrieval ".repeat(400))
    const retriever = createContextRetriever({
      directory,
      listSkills: async () => [{ id: "retrieval-skill", name: "Retrieval Skill", content: "retrieval ".repeat(400) }],
      retrieveMCP: async () => {
        throw new Error("offline")
      },
    })
    const bundle = await retriever.retrieve({ query: "retrieval", maxCharacters: 900 })
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(900)
    expect(bundle.knowledge).toEqual([])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("uses recent transcript text for matching", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meeting-context-transcript-"))
  try {
    const retriever = createContextRetriever({
      directory,
      listSkills: async () => [{ id: "thai-skill", name: "Thai Skill", content: "การประชุม latency retrieval notes" }],
    })
    const bundle = await retriever.retrieve({ query: "summary", recentTranscriptText: "การประชุม retrieval" })
    expect(bundle.skills.map((item) => item.id)).toEqual(["thai-skill"])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
