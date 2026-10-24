import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Permission } from "../src/permission"
import { SessionGuardrailMatch } from "../src/session/guardrail-match"

const paths = { workdir: "/workspace/project", project: "/workspace/project", home: "/home/user" }
const ask = [{ action: "external_directory", resource: "*", effect: "ask" }] as const
const roots = [os.tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"]
let fixture: string
let temp: string
let outside: string
let previousTmpdir: string | undefined

beforeAll(async () => {
  const cache = path.resolve(import.meta.dir, "../.cache")
  await mkdir(cache, { recursive: true })
  fixture = await mkdtemp(path.join(cache, "temp-scope-"))
  temp = path.join(fixture, "scratch")
  outside = path.join(fixture, "outside")
  await mkdir(temp)
  await mkdir(outside)
  await mkdir(path.join(outside, "child"))
  await symlink(outside, path.join(temp, "escape"), "dir")
  await symlink(path.join(outside, "child"), path.join(temp, "child-link"), "dir")
  await symlink(path.join(outside, "missing"), path.join(temp, "dangling"), "dir")
  previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = temp
})

afterAll(async () => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir
  await rm(fixture, { recursive: true, force: true })
})

const classify = (resource: string, action = "shell", overrides = {}) =>
  SessionGuardrailMatch.evaluate({ action, resources: [resource], paths: { ...paths, tmpdir: temp, ...overrides } })

describe("temporary directory scope", () => {
  test.each(roots)("exempts writes under %s from both outside-path gates", (root) => {
    expect(classify(`touch ${root}/ycoding-scope-test/file`)).toMatchObject({ decision: "allow" })
    expect(Permission.evaluate("external_directory", `${root}/ycoding-scope-test/*`, ask).effect).toBe("allow")
  })

  test("resolves the configured TMPDIR and the system temp alias", async () => {
    expect(classify('touch "$TMPDIR/new/file"')).toMatchObject({ decision: "allow" })
    expect(classify(`touch ${temp}/new/file`)).toMatchObject({ decision: "allow" })
    expect(Permission.evaluate("external_directory", `${temp}/new/*`, ask).effect).toBe("allow")
    const physical = await realpath(os.tmpdir())
    expect(Permission.evaluate("external_directory", `${physical}/*`, ask).effect).toBe("allow")
  })

  test.each(["../outside/file", "escape/file", "child-link/../file", "dangling/file"])("rejects temp-prefix escape %s", (relative) => {
    const target = `${temp}/${relative}`
    expect(classify(`touch ${target}`)).toMatchObject({ decision: "ask", ruleIDs: ["standard.review.outside-repo"] })
    expect(Permission.evaluate("external_directory", `${target}/*`, ask).effect).toBe("ask")
  })

  test("keeps mixed outside targets and prefix lookalikes external", () => {
    for (const target of [outside, `${temp}-other`]) {
      expect(classify(`touch ${temp}/file ${target}/file`)).toMatchObject({ decision: "ask", ruleIDs: ["standard.review.outside-repo"] })
      expect(Permission.evaluate("external_directory", `${target}/*`, ask).effect).toBe("ask")
    }
  })

  test("temp trust cannot override explicit permission denies or ceilings", () => {
    const deny = [{ action: "external_directory", resource: "*", effect: "deny" }] as const
    expect(Permission.evaluate("external_directory", `${temp}/*`, ask, deny).effect).toBe("deny")
    expect(Permission.evaluate("external_directory", `${temp}/*`, deny).effect).toBe("deny")
    expect(Permission.evaluate("edit", `${temp}/file`, [{ action: "edit", resource: "*", effect: "ask" }]).effect).toBe("ask")
  })

  test("an explicit deny spelled through an alias still blocks the temp spelling", async () => {
    const alias = path.join(fixture, "temp-alias")
    await symlink(temp, alias, "dir")
    expect(Permission.evaluate("external_directory", `${temp}/child/*`, [
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "external_directory", resource: `${alias}/*`, effect: "deny" },
    ]).effect).toBe("deny")
  })

  test.each(["git-directory", "git-workdir", "database", "project", "home"])("temp scope preserves %s destructive protection", (kind) => {
    if (kind === "git-directory") expect(classify(`git -C ${temp} reset --hard`)).toMatchObject({ decision: "ask", hardReview: true })
    if (kind === "git-workdir") expect(classify(`cd ${temp} && git reset --hard`)).toMatchObject({ decision: "ask", hardReview: true })
    if (kind === "database") expect(classify(`sqlite3 ${temp}/data.db 'DROP TABLE jobs'`)).toMatchObject({ decision: "ask", hardReview: true })
    if (kind === "project") expect(classify(`rm -rf ${temp}/project`, "shell", { workdir: `${temp}/project`, project: `${temp}/project` })).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
    if (kind === "project") expect(classify("rm -rf /private/tmp/ycoding-scope-project", "shell", { workdir: "/tmp/ycoding-scope-project", project: "/tmp/ycoding-scope-project" })).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
    if (kind === "home") expect(classify(`rm -rf ${temp}`, "shell", { home: temp })).toMatchObject({ decision: "deny", ruleIDs: ["standard.catastrophic.rm-user-home"] })
  })

  test("temp scope preserves custom review and deny rules", () => {
    for (const decision of ["ask", "deny", "hard_review"] as const) {
      const result = SessionGuardrailMatch.evaluate({ action: "file_mutation", resources: [`${temp}/file`], paths: { ...paths, tmpdir: temp }, custom: [{ invalidFiles: [], rules: [{ id: "custom.temp", source: "custom", actions: ["file_mutation"], resources: ["*"], decision, priority: 0, reason: "Custom restriction" }] }] })
      expect(result).toMatchObject({ decision: decision === "deny" ? "deny" : "ask", ruleIDs: ["custom.temp"], hardReview: decision === "hard_review" })
    }
  })
})
