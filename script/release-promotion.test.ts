import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const script = path.join(import.meta.dir, "release-promotion.sh")
const stagedRun = path.join(import.meta.dir, "release-staged-run.sh")
const sha = "1".repeat(40)
const checksums = "2".repeat(64)
const names = ["release-archive-darwin-arm64", "release-archive-desktop-darwin-arm64", "release-checksums-0.13.0", "release-stage-0.13.0", "verified-web"]
const artifacts = names.map((name, index) => ({ id: index + 20, name, digest: `sha256:${checksums}`, expired: false, workflow_run: { id: 42, head_sha: sha } }))
const run = {
  id: 42, repository: { full_name: "example/ycoding" }, head_repository: { full_name: "example/ycoding" },
  head_sha: sha, head_branch: "main", path: ".github/workflows/release.yml", event: "workflow_dispatch", run_attempt: 1,
  status: "completed", conclusion: "success",
}
const environment = {
  name: "release-production", can_admins_bypass: false, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { id: 21 } }] }],
}
const policies = { total_count: 1, branch_policies: [{ type: "branch", name: "main" }] }

type Fixture = {
  runs?: unknown
  artifacts?: unknown
  environment?: unknown
  policies?: unknown
  env?: Record<string, string>
  checksums?: string
  identity?: unknown
  web?: boolean
}

function execute(command: string, fixture: Fixture = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "ycoding-main-promotion-"))
  try {
    for (const folder of ["docs/releases", "release", "checksums", "stage", "apps/web/dist/_bun"]) mkdirSync(path.join(directory, folder), { recursive: true })
    const target = (name: string, contents: string, mode = 0o600) => writeFileSync(path.join(directory, name), contents, { mode })
    target("docs/releases/v0.13.0.md", "# YCoding v0.13.0\n")
    target("output", "")
    target("git", `#!/bin/sh\ncase "$*" in 'rev-parse HEAD'|'rev-parse refs/remotes/origin/main'|'rev-parse ${sha}^{commit}') printf '%s\\n' '${sha}';; *) exit 10;; esac\n`, 0o700)
    target("gh", `#!/bin/sh
case "$*" in
  'api repos/example/ycoding/actions/runs/42') cat runs ;;
  'api --paginate --slurp repos/example/ycoding/actions/runs/42/artifacts?per_page=100') cat artifacts ;;
  'api repos/example/ycoding/environments/release-production') cat environment ;;
  'api repos/example/ycoding/environments/release-production/deployment-branch-policies?per_page=100') cat policies ;;
  *) exit 11 ;;
esac
`, 0o700)
    target("runs", JSON.stringify(fixture.runs === undefined ? run : fixture.runs))
    target("artifacts", JSON.stringify(fixture.artifacts ?? [{ artifacts }]))
    target("environment", JSON.stringify(fixture.environment === undefined ? environment : fixture.environment))
    target("policies", JSON.stringify(fixture.policies ?? policies))
    const manifest = fixture.checksums ?? "fixture checksum manifest\n"
    const digest = new Bun.CryptoHasher("sha256").update(manifest).digest("hex")
    target("checksums/ycoding-0.13.0-checksums.txt", manifest)
    target("stage/identity.json", JSON.stringify(fixture.identity ?? {
      repository: "example/ycoding", workflow: ".github/workflows/release.yml", ref: "refs/heads/main", sha,
      event: "workflow_dispatch", attempt: 1, version: "0.13.0", run: "42", checksums: digest,
    }))
    target("apps/web/dist/index.html", "Rust\n")
    if (fixture.web !== false) target("apps/web/dist/_bun/index.html", "Bun\n")
    const result = Bun.spawnSync(["bash", command === "main" ? stagedRun : script, command], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env.PATH}`, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
        GITHUB_REF_PROTECTED: "true", GITHUB_SHA: sha, GITHUB_REPOSITORY: "example/ycoding",
        RELEASE_REVIEWER_ID: "21",
        GITHUB_RUN_ID: "43", GITHUB_OUTPUT: path.join(directory, "output"), REQUESTED_RELEASE_VERSION: "0.13.0", RELEASE_VERSION: "0.13.0",
        PUBLISH_STAGED_RUN_ID: "42", PUBLISH_CHECKSUMS: command === "verify" ? digest : checksums, PROMOTE_LATEST: "true",
        VERIFIED_STAGE_RUN_ID: "42", VERIFIED_STAGE_CHECKSUMS: digest,
        ...fixture.env,
      },
    })
    return { exit: result.exitCode, error: result.stderr.toString(), outputs: readFileSync(path.join(directory, "output"), "utf8") }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("the staged-run entry point resolves the protected main dispatch", () => {
  const result = execute("main")
  expect(result.exit, result.error).toBe(0)
  expect(result.outputs).toBe(`run-id=42\nchecksums=${checksums}\n`)
})

test.each([
  ["unprotected ref", { env: { GITHUB_REF_PROTECTED: "false" } }],
  ["different branch", { env: { GITHUB_REF: "refs/heads/prep" } }],
  ["wrong SHA", { runs: { ...run, head_sha: "3".repeat(40) } }],
  ["different repo", { runs: { ...run, head_repository: { full_name: "other/ycoding" } } }],
  ["different workflow", { runs: { ...run, path: ".github/workflows/test.yml" } }],
  ["failed run", { runs: { ...run, conclusion: "failure" } }],
  ["retry", { runs: { ...run, run_attempt: 2 } }],
  ["same run", { env: { GITHUB_RUN_ID: "42" } }],
  ["invalid digest", { env: { PUBLISH_CHECKSUMS: "bad" } }],
  ["missing version", { env: { REQUESTED_RELEASE_VERSION: "" } }],
] as const)("staged-run rejects %s without exposing a run ID or checksum", (_, fixture) => {
  const result = execute("main", fixture)
  expect(result.exit).toBe(1)
  expect(result.outputs).toBe("")
})

test("promotion resolves only the original immutable artifact IDs from the verified main run", () => {
  const result = execute("artifacts")
  expect(result.exit, result.error).toBe(0)
  expect(result.outputs).toBe("archives=20,21\nchecksums=22\nstage=23\nweb=24\n")
})

test.each([
  ["promotion rather than staging", { artifacts: [{ artifacts: artifacts.filter((artifact) => artifact.name !== names[3]) }] }],
  ["missing same-run Web", { artifacts: [{ artifacts: artifacts.slice(0, 4) }] }],
  ["expired archive", { artifacts: [{ artifacts: [{ ...artifacts[0], expired: true }, ...artifacts.slice(1)] }] }],
  ["duplicate destination", { artifacts: [{ artifacts: [...artifacts, artifacts[2]] }] }],
] as const)("promotion rejects %s without exposing a run or artifact IDs", (_, fixture) => {
  const result = execute("artifacts", fixture)
  expect(result.exit).toBe(1)
  expect(result.outputs).toBe("")
})

test("publication accepts the sole native reviewer and main-only restriction", () => {
  const result = execute("control")
  expect(result.exit, result.error).toBe(0)
})

test.each([
  { environment: null }, { environment: { ...environment, can_admins_bypass: true } },
  { environment: { ...environment, protection_rules: [] } },
  { environment: { ...environment, protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: true }] } },
  { environment: { ...environment, protection_rules: [{ ...environment.protection_rules[0], reviewers: [] }] } },
  { env: { RELEASE_REVIEWER_ID: "22" } },
  { env: { RELEASE_REVIEWER_ID: "" } },
  { policies: { ...policies, branch_policies: [{ type: "tag", name: "main" }] } },
])("publication fails closed without a protected production environment: %p", (fixture) => {
  expect(execute("control", fixture).exit).toBe(1)
})

test.each([
  [{ env: { VERIFIED_STAGE_CHECKSUMS: checksums } }, /Checksum manifest digest/],
  [{ identity: { version: "0.13.4" } }, /Stage identity/],
  [{ web: false }, /Missing staged Rust or Bun Web entry point/],
] as const)("rejects incomplete or conflicting stage bytes before publication: %p", (fixture, expected) => {
  const result = execute("verify", fixture)
  expect(result.exit).toBe(1)
  expect(result.error).toMatch(expected)
})
