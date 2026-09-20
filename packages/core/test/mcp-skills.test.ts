import { describe, expect, test } from "bun:test"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { ConfigMarkdown } from "@ycoding-ai/core/config/markdown"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { MCPClient } from "@ycoding-ai/core/mcp/client"
import { MCPSkills } from "@ycoding-ai/core/mcp/skills"
import { Effect } from "effect"
import { skillBody, skillServer, skillsMcpLayer, type Skill } from "./fixture/mcp-skills"

const SKILL_MD = skillBody(
  { name: "git-workflow", description: "Follow this team's Git conventions" },
  "# Git workflow\n\nSee `references/GUIDE.md`.\n",
)

const skill: Skill = {
  uri: "skill://git-workflow/SKILL.md",
  frontmatter: { name: "git-workflow", description: "Follow this team's Git conventions" },
  files: [
    { name: "SKILL.md", text: SKILL_MD },
    { name: "references/GUIDE.md", text: "# Guide\n" },
  ],
}

const other: Skill = {
  uri: "skill://acme/billing/refunds/SKILL.md",
  frontmatter: { name: "refunds", description: "Process refunds" },
  files: [{ name: "SKILL.md", text: skillBody({ name: "refunds", description: "Process refunds" }, "# Refunds\n") }],
}

const connect = (url: string, name = "skills") =>
  MCPClient.connect(name, new ConfigMCP.Remote({ type: "remote", url, oauth: false }), import.meta.dir)

describe("MCP skills extension contract", () => {
  test("exposes extension methods only after the server declares the capability", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill], undeclared: true })
          const connection = yield* connect(server.url)
          expect(connection.skills).toBeUndefined()
          expect(yield* connection.skillEntries()).toEqual([])
          expect(server.state.listCalls).toBe(0)
        }),
      ),
    )
  })

  test("ignores the extension when the required Resources capability is absent", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill], noResources: true })
          const connection = yield* connect(server.url)
          expect(connection.skills).toBeUndefined()
          expect(yield* connection.skillEntries()).toEqual([])
          expect(server.state.listCalls).toBe(0)
        }),
      ),
    )
  })

  test("lists and paginates entries with the required result fields", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill, other], paginate: true })
          const connection = yield* connect(server.url)
          const entries = yield* connection.skillEntries()
          // Both pages are collected; ordering within a page is the server's, so assert membership.
          expect(entries.map((entry) => entry.uri).toSorted()).toEqual([
            "skill://acme/billing/refunds/SKILL.md",
            "skill://git-workflow/SKILL.md",
          ])
          expect(entries.every((entry) => entry.server === "skills")).toBe(true)
          expect(server.state.listCalls).toBe(2)
          // Metadata only: listing must not retrieve any skill file.
          expect(server.state.readCalls).toBe(0)
        }),
      ),
    )
  })

  test("accepts an empty listing as a valid extension", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [] })
          const connection = yield* connect(server.url)
          expect(connection.skills).toEqual({ directoryRead: true })
          expect(yield* connection.skillEntries()).toEqual([])
        }),
      ),
    )
  })

  test("requires the extension's result fields without a fallback for older base revisions", async () => {
    // The extension exists only at base revision 2026-07-28 and later, where `resultType`, `ttlMs`,
    // and `cacheScope` are REQUIRED. A server that omits them is not serving this extension.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill], omitResultFields: true })
          const connection = yield* connect(server.url)
          return yield* connection.skillEntries().pipe(Effect.flip)
        }),
      ),
    )
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain("ttlMs")
  })

  test("rejects malformed entries instead of loading them", async () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      [
        "missing SKILL.md",
        {
          uri: "skill://a/SKILL.md",
          frontmatter: { name: "a", description: "d" },
          resources: [{ uri: "skill://a/other.md", digest: `sha256:${"a".repeat(64)}`, size: 1 }],
        },
      ],
      ["no resources", { uri: "skill://a/SKILL.md", frontmatter: { name: "a", description: "d" } }],
      [
        "bad digest",
        {
          uri: "skill://a/SKILL.md",
          frontmatter: { name: "a", description: "d" },
          resources: [{ uri: "skill://a/SKILL.md", digest: "sha256:short", size: 1 }],
        },
      ],
      [
        "missing description",
        {
          uri: "skill://a/SKILL.md",
          frontmatter: { name: "a" },
          resources: [{ uri: "skill://a/SKILL.md", digest: `sha256:${"a".repeat(64)}`, size: 1 }],
        },
      ],
      [
        "escaped resource",
        {
          uri: "skill://a/SKILL.md",
          frontmatter: { name: "a", description: "d" },
          resources: [
            { uri: "skill://a/SKILL.md", digest: `sha256:${"a".repeat(64)}`, size: 1 },
            { uri: "skill://a/../b/SKILL.md", digest: `sha256:${"a".repeat(64)}`, size: 1 },
          ],
        },
      ],
    ]
    for (const [label, raw] of cases) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* skillServer({ rawSkills: [raw] })
            const connection = yield* connect(server.url)
            expect({ label, entries: yield* connection.skillEntries() }).toEqual({ label, entries: [] })
          }),
        ),
      )
    }
  })

  test("enforces the per-skill resource and byte limits", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resources = yield* skillServer({ skills: [skill], overflowResources: true })
          const entries = yield* connect(resources.url).pipe(Effect.flatMap((connection) => connection.skillEntries()))
          expect(entries).toEqual([])

          const bytes = yield* skillServer({ skills: [skill], overflowBytes: true })
          const limited = yield* connect(bytes.url).pipe(Effect.flatMap((connection) => connection.skillEntries()))
          expect(limited).toEqual([])
        }),
      ),
    )
  })

  test("declines a dynamic manifest at load, not at listing", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill], dynamic: true })
          const connection = yield* connect(server.url)
          const entries = yield* connection.skillEntries()
          expect(entries.map((entry) => entry.resources)).toEqual(["dynamic"])

          const failed = yield* Effect.gen(function* () {
            const service = yield* MCP.Service
            return yield* service
              .readSkillResource({ server: "skills", entry: entries[0], uri: "skill://git-workflow/SKILL.md" })
              .pipe(Effect.flip)
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))
          expect(failed).toBeInstanceOf(MCP.SkillUnavailableError)
          expect(failed).toMatchObject({ reason: "dynamic" })
          expect(server.state.readCalls).toBe(0)
        }),
      ),
    )
  })

  test("confirms unlisted skills via skills/get and errors for unknown URIs", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill, other], partial: 1 })
          const connection = yield* connect(server.url)
          expect((yield* connection.skillEntries()).map((entry) => entry.uri)).toEqual([
            "skill://git-workflow/SKILL.md",
          ])

          const confirmed = yield* connection.skillEntry({ uri: "skill://acme/billing/refunds/SKILL.md" })
          expect(confirmed).toMatchObject({ server: "skills", uri: "skill://acme/billing/refunds/SKILL.md" })

          const missing = yield* connection.skillEntry({ uri: "skill://nope/SKILL.md" }).pipe(Effect.flip)
          expect(missing).toBeInstanceOf(MCPClient.SkillRequestError)
          expect(missing).toMatchObject({ code: -32602 })

          const unavailable = yield* Effect.gen(function* () {
            const service = yield* MCP.Service
            return yield* service.getSkill({ server: "skills", uri: "skill://nope/SKILL.md" }).pipe(Effect.flip)
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))
          expect(unavailable).toBeInstanceOf(MCP.SkillUnavailableError)
          expect(unavailable).toMatchObject({ reason: "not-found" })
        }),
      ),
    )
  })

  test("rejects a skills/get response for a different URI without reading bytes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill], getUriOverride: "skill://other/SKILL.md" })
          const connection = yield* connect(server.url)
          const failed = yield* connection.skillEntry({ uri: skill.uri }).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(MCPClient.EntryRejectedError)
          expect(failed).toMatchObject({ reason: "uri-mismatch" })
          expect(server.state.readCalls).toBe(0)
        }),
      ),
    )
  })

  test("verifies size, digest, and frontmatter on read, and refuses unlisted files", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill] })
          yield* Effect.gen(function* () {
            const service = yield* MCP.Service
            const entry = yield* service.getSkill({ server: "skills", uri: skill.uri })
            const read = yield* service.readSkillResource({
              server: "skills",
              entry,
              uri: "skill://git-workflow/references/GUIDE.md",
            })
            expect(read).toMatchObject({ text: "# Guide\n" })

            const unlisted = yield* service
              .readSkillResource({ server: "skills", entry, uri: "skill://git-workflow/references/OTHER.md" })
              .pipe(Effect.flip)
            expect(unlisted).toBeInstanceOf(MCP.SkillVerificationError)
            expect(unlisted).toMatchObject({ reason: "unlisted-resource" })

            const ok = MCPSkills.frontmatter(entry, entry.frontmatter)
            expect(ok).toEqual({ ok: true })
            expect(MCPSkills.frontmatter(entry, { ...entry.frontmatter, name: "other" })).toEqual({
              ok: false,
              reason: "frontmatter-mismatch",
            })
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))
        }),
      ),
    )
  })

  test("treats altered bytes as verification failures", async () => {
    const expected = { size: "size-mismatch", digest: "digest-mismatch" } as const
    for (const corrupt of ["size", "digest"] as const) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* skillServer({ skills: [skill], corrupt })
            yield* Effect.gen(function* () {
              const service = yield* MCP.Service
              const entry = yield* service.getSkill({ server: "skills", uri: skill.uri })
              const failed = yield* service
                .readSkillResource({ server: "skills", entry, uri: skill.uri })
                .pipe(Effect.flip)
              expect({
                corrupt,
                reason: failed instanceof MCP.SkillVerificationError ? failed.reason : undefined,
              }).toEqual({ corrupt, reason: expected[corrupt] })
            }).pipe(Effect.provide(skillsMcpLayer(server.url)))
          }),
        ),
      )
    }
  })

  test("detects frontmatter that disagrees with the held entry", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill], corruptFrontmatter: true })
          yield* Effect.gen(function* () {
            const service = yield* MCP.Service
            const entry = yield* service.getSkill({ server: "skills", uri: skill.uri })
            // The served bytes match the manifest, so retrieval succeeds; the entry advertises a
            // description the served SKILL.md does not contain.
            const file = yield* service.readSkillResource({ server: "skills", entry, uri: skill.uri })
            expect(entry.frontmatter.description).toBe("tampered")
            if (!("text" in file)) throw new Error("expected text SKILL.md")
            expect(file.text).toContain("Follow this team's Git conventions")

            // Parsing the loaded SKILL.md and comparing field by field against the held entry is the
            // check that rejects it; without it the model would receive content the user never approved.
            const parsed = ConfigMarkdown.parseOption(file.text ?? "")
            expect(parsed?.data).toMatchObject({ name: "git-workflow" })
            expect(MCPSkills.frontmatter(entry, parsed?.data)).toEqual({ ok: false, reason: "frontmatter-mismatch" })
            expect(MCPSkills.frontmatter(entry, entry.frontmatter)).toEqual({ ok: true })
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))
        }),
      ),
    )
  })

  test("never retrieves skill files during listing or entry retrieval", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill, other] })
          yield* Effect.gen(function* () {
            const service = yield* MCP.Service
            yield* service.skillCatalog()
            yield* service.getSkill({ server: "skills", uri: skill.uri })
            expect(server.state.readCalls).toBe(0)
            expect((yield* service.skillCatalog()).length).toBe(2)
            expect(server.state.readCalls).toBe(0)
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))
        }),
      ),
    )
  })

  test("gates directory reads on the directoryRead setting", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gated = yield* skillServer({ skills: [skill], noDirectoryRead: true })
          const connection = yield* connect(gated.url)
          expect(yield* connection.readResourceDirectory({ uri: "skill://git-workflow" })).toBeUndefined()
          expect(gated.state.directoryCalls).toBe(0)

          const allowed = yield* skillServer({
            skills: [skill],
            directoryEntries: [
              { uri: "skill://git-workflow/references", name: "references", mimeType: "inode/directory" },
            ],
          })
          const open = yield* connect(allowed.url)
          expect(yield* open.readResourceDirectory({ uri: "skill://git-workflow" })).toEqual({
            resources: [{ uri: "skill://git-workflow/references", name: "references", mimeType: "inode/directory" }],
          })
          expect(allowed.state.directoryCalls).toBe(1)
        }),
      ),
    )
  })

  test("paginates standard directory results without requiring cache fields", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({
            skills: [skill],
            paginateDirectory: true,
            omitDirectoryCacheFields: true,
            directoryEntries: [
              { uri: "skill://git-workflow/references", name: "references", mimeType: "inode/directory" },
              { uri: "skill://git-workflow/SKILL.md", name: "SKILL.md", mimeType: "text/markdown" },
            ],
          })
          const connection = yield* connect(server.url)
          expect(yield* connection.readResourceDirectory({ uri: "skill://git-workflow" })).toEqual({
            resources: [
              { uri: "skill://git-workflow/references", name: "references", mimeType: "inode/directory" },
              { uri: "skill://git-workflow/SKILL.md", name: "SKILL.md", mimeType: "text/markdown" },
            ],
          })
          expect(server.state.directoryCalls).toBe(2)
        }),
      ),
    )
  })

  test("derives a content-bound approval identity from the manifest", () => {
    const server = new ConfigMCP.Remote({ type: "remote", url: "https://example.invalid", oauth: false })
    expect(server.url).toBe("https://example.invalid")
    const base = MCPSkills.entry("skills", {
      uri: skill.uri,
      frontmatter: skill.frontmatter,
      resources: [{ uri: skill.uri, digest: `sha256:${"a".repeat(64)}`, size: 1 }],
    })
    expect(base.ok).toBe(true)
    if (!base.ok) return
    const rotated = MCPSkills.entry("skills", {
      uri: skill.uri,
      frontmatter: skill.frontmatter,
      resources: [
        { uri: skill.uri, digest: `sha256:${"a".repeat(64)}`, size: 1 },
        { uri: "skill://git-workflow/extra.md", digest: `sha256:${"d".repeat(64)}`, size: 2 },
      ],
    })
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return
    expect(MCPSkills.identity(base.entry)).not.toBe(MCPSkills.identity(rotated.entry))
    // Server label participates in identity: the same URI on two servers is two skills.
    expect(MCPSkills.identity(base.entry)).not.toBe(MCPSkills.identity({ ...base.entry, server: "other" }))
  })

  test("resolves relative references inside the skill and rejects escapes", () => {
    const nested = MCPSkills.entry("skills", {
      uri: "skill://acme/billing/refunds/SKILL.md",
      frontmatter: { name: "refunds", description: "Process refunds" },
      resources: [{ uri: "skill://acme/billing/refunds/SKILL.md", digest: `sha256:${"a".repeat(64)}`, size: 1 }],
    })
    if (!nested.ok) throw new Error("fixture entry must decode")
    expect(MCPSkills.resolve(nested.entry, "references/GUIDE.md")).toBe(
      "skill://acme/billing/refunds/references/GUIDE.md",
    )
    // Escapes resolve outside the skill root and are rejected; a top-level skill has no parent to
    // climb into, so the guard is the skill root rather than the URI authority.
    expect(MCPSkills.resolve(nested.entry, "../../../etc/passwd")).toBeUndefined()
    expect(MCPSkills.resolve(nested.entry, "/etc/passwd")).toBeUndefined()
    expect(MCPSkills.resolve(nested.entry, "https://example.com/x")).toBeUndefined()
    expect(MCPSkills.resolve(nested.entry, "a?b")).toBeUndefined()
    expect(MCPSkills.resolve(nested.entry, "a\\b")).toBeUndefined()
    expect(MCPSkills.resolve(nested.entry, "..")).toBeUndefined()
  })

  test("hashes retrieved bytes with the manifest's digest format", () => {
    expect(MCPSkills.digest(new TextEncoder().encode(SKILL_MD))).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test("rejects malformed URIs without throwing", () => {
    // Entry URIs are schema-unvalidated strings from a remote server. `resolve` builds a URL from
    // them, so a malformed origin or reference must be a typed rejection rather than a TypeError.
    const malformed: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["unparseable origin", { uri: "not a uri", frontmatter: { name: "a", description: "d" }, resources: "dynamic" }],
      ["empty", { uri: "", frontmatter: { name: "a", description: "d" }, resources: "dynamic" }],
      [
        "uri without SKILL.md",
        { uri: "skill://a", frontmatter: { name: "a", description: "d" }, resources: "dynamic" },
      ],
      [
        "uri under another filename",
        { uri: "skill://a/other.md", frontmatter: { name: "a", description: "d" }, resources: "dynamic" },
      ],
      [
        "invalid authority",
        { uri: "http://[/a/SKILL.md", frontmatter: { name: "a", description: "d" }, resources: "dynamic" },
      ],
    ]
    for (const [label, raw] of malformed) {
      const result = MCPSkills.entry("skills", raw)
      expect({ label, ok: result.ok }).toEqual({ label, ok: false })
      if (!result.ok) expect(result.reason).toBe("malformed-uri")
    }

    const valid = MCPSkills.entry("skills", {
      uri: "skill://git-workflow/SKILL.md",
      frontmatter: { name: "git-workflow", description: "d" },
      resources: "dynamic",
    })
    if (!valid.ok) throw new Error("fixture entry must decode")
    // A reference that cannot be parsed is a rejection, not a crash.
    expect(MCPSkills.resolve(valid.entry, "http://[")).toBeUndefined()
    expect(MCPSkills.resolve(valid.entry, "")).toBeUndefined()
    // A cross-scheme reference resolves outside the skill root and is rejected.
    expect(MCPSkills.resolve(valid.entry, "file:///etc/passwd")).toBeUndefined()
  })

  test("accepts native absolute URI schemes and keeps reads bound to the entry origin", async () => {
    const native = MCPSkills.entry("skills", {
      uri: "github://owner/repo/skills/refunds/SKILL.md",
      frontmatter: { name: "refunds", description: "Process refunds" },
      resources: [
        {
          uri: "github://owner/repo/skills/refunds/SKILL.md",
          digest: `sha256:${"a".repeat(64)}`,
          size: 1,
        },
      ],
    })
    expect(native.ok).toBe(true)
    if (!native.ok) return
    expect(MCPSkills.resolve(native.entry, "references/GUIDE.md")).toBe(
      "github://owner/repo/skills/refunds/references/GUIDE.md",
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill] })
          const failed = yield* Effect.gen(function* () {
            const service = yield* MCP.Service
            const entry = yield* service.getSkill({ server: "skills", uri: skill.uri })
            return yield* service
              .readSkillResource({ server: "skills", entry: { ...entry, server: "other" }, uri: skill.uri })
              .pipe(Effect.flip)
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))
          expect(failed).toBeInstanceOf(MCP.SkillVerificationError)
          expect(server.state.readCalls).toBe(0)
        }),
      ),
    )
  })

  test("requires the manifest name to match the URI's final segment", () => {
    // The extension requires the final <skill-path> segment to equal frontmatter.name, so the name is
    // recoverable from the URI alone.
    const mismatch = MCPSkills.entry("skills", {
      uri: "skill://b/SKILL.md",
      frontmatter: { name: "a", description: "d" },
      resources: "dynamic",
    })
    expect(mismatch).toEqual({ ok: false, reason: "name-mismatch" })
  })

  test("compares nested frontmatter by value rather than key insertion order", () => {
    const base = MCPSkills.entry("skills", {
      uri: "skill://a/SKILL.md",
      frontmatter: { name: "a", description: "d", metadata: { version: "2.1.0", tags: ["x"], license: "MIT" } },
      resources: "dynamic",
    })
    if (!base.ok) throw new Error("fixture entry must decode")
    // Same content, different key order: equal. JSON.stringify would report a spurious mismatch.
    expect(
      MCPSkills.frontmatter(base.entry, {
        name: "a",
        description: "d",
        metadata: { license: "MIT", tags: ["x"], version: "2.1.0" },
      }),
    ).toEqual({ ok: true })
    // A real nested difference is still detected.
    expect(
      MCPSkills.frontmatter(base.entry, {
        name: "a",
        description: "d",
        metadata: { license: "MIT", tags: ["x"], version: "9.9.9" },
      }),
    ).toEqual({ ok: false, reason: "frontmatter-mismatch" })
    expect(MCPSkills.frontmatter(base.entry, { name: "a", description: "d", metadata: { license: "MIT" } })).toEqual({
      ok: false,
      reason: "frontmatter-mismatch",
    })
    expect(MCPSkills.frontmatter(base.entry, { name: "a", description: "d" })).toEqual({
      ok: false,
      reason: "frontmatter-mismatch",
    })
  })

  test("verifies retrieved bytes against a manifest entry directly", () => {
    const text = "# Guide\n"
    const size = new TextEncoder().encode(text).byteLength
    const digest = MCPSkills.digest(new TextEncoder().encode(text))
    const base = MCPSkills.entry("skills", {
      uri: skill.uri,
      frontmatter: skill.frontmatter,
      resources: [
        // A manifest must enumerate its own SKILL.md; the helper rejects one that does not.
        {
          uri: skill.uri,
          digest: MCPSkills.digest(new TextEncoder().encode(SKILL_MD)),
          size: new TextEncoder().encode(SKILL_MD).byteLength,
        },
        { uri: "skill://git-workflow/references/GUIDE.md", digest, size },
      ],
    })
    if (!base.ok) throw new Error("fixture entry must decode")

    const accepted = MCPSkills.file({
      entry: base.entry,
      uri: "skill://git-workflow/references/GUIDE.md",
      size,
      digest,
      text,
    })
    expect(accepted.ok).toBe(true)

    expect(
      MCPSkills.file({
        entry: base.entry,
        uri: "skill://git-workflow/references/OTHER.md",
        size,
        digest,
        text,
      }),
    ).toEqual({ ok: false, reason: "unlisted-resource" })

    expect(
      MCPSkills.file({
        entry: base.entry,
        uri: "skill://git-workflow/references/GUIDE.md",
        size: size + 1,
        digest,
        text,
      }),
    ).toEqual({ ok: false, reason: "size-mismatch" })

    expect(
      MCPSkills.file({
        entry: base.entry,
        uri: "skill://git-workflow/references/GUIDE.md",
        size,
        digest: MCPSkills.digest(new TextEncoder().encode("# Other\n")),
        text,
      }),
    ).toEqual({ ok: false, reason: "digest-mismatch" })

    // A manifest that omits SKILL.md is invalid and must not be loaded.
    expect(
      MCPSkills.entry("skills", {
        uri: skill.uri,
        frontmatter: skill.frontmatter,
        resources: [{ uri: "skill://git-workflow/references/GUIDE.md", digest, size }],
      }),
    ).toEqual({ ok: false, reason: "missing-skill-md" })
  })
})
