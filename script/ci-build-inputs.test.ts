import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const both = "desktop=true\nweb=true\n"
const neither = "desktop=false\nweb=false\n"
const desktopOnly = "desktop=true\nweb=false\n"
const webOnly = "desktop=false\nweb=true\n"

function withHistory(entries: string, verify: (run: (event: string, options?: Record<string, string>) => string) => void) {
  const cwd = mkdtempSync(path.join(tmpdir(), "ycoding-ci-inputs-"))
  const git = (args: string[], stdin?: string) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) })
    if (!result.success) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  try {
    git(["init", "--initial-branch=main"])
    const commit = (ref: string, mark: number, parents: string, changes: string) =>
      `commit refs/heads/${ref}\nmark :${mark}\ncommitter CI Fixture <ci@example.test> ${mark} +0000\ndata 1\n${mark}\n${parents}${changes}\n`
    git(["fast-import", "--quiet"], [
      commit("main", 1, "", 'M 100644 inline "packages/desktop/src/old.ts"\ndata 1\nx\n'),
      commit("main", 2, "from :1\n", 'M 100644 inline "docs/product-direction.md"\ndata 1\nx\n'),
      commit("topic", 3, "from :1\n", entries),
      commit("main", 4, "from :2\nmerge :3\n", entries),
      "done\n",
    ].join(""))
    verify((event, options = {}) => {
      const result = Bun.spawnSync([process.execPath, path.join(root, "script/ci-build-inputs.ts")], {
        cwd,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: event,
          GITHUB_SHA: git(["rev-parse", "HEAD"]),
          CI_PR_BASE: git(["rev-parse", "HEAD^1"]),
          CI_PR_HEAD: git(["rev-parse", "HEAD^2"]),
          ...options,
        },
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return result.stdout.toString()
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const added = (file: string) => `M 100644 inline "${file}"\ndata 1\nx\n`

test.each([
  ["a Desktop renderer source", "packages/desktop/src/responsive-layer.tsx", desktopOnly],
  ["a TUI sound bundled by Desktop", "packages/tui/src/assets/audio/bip-bop-01.mp3", desktopOnly],
  ["a Web-only source", "apps/web/src/remote/office/OfficeScene.ts", webOnly],
  ["a Web public asset", "apps/web/public/robots.txt", webOnly],
  ["a test-named file copied as a public asset", "apps/web/public/src/example.test.js", webOnly],
  ["a published configuration example", "docs/examples/ycoding.jsonc", webOnly],
  ["a schema generator input", "packages/core/src/config/goal.ts", webOnly],
  ["a Worker source", "infra/cloudflare/src/router.ts", webOnly],
  ["a stylesheet imported by both frontends", "apps/web/src/styles/workspace-shell.css", both],
  ["an image used through a shared module", "apps/web/src/assets/providers/grok.svg", both],
  ["a transitive workspace source", "packages/schema/src/session-event.ts", both],
  ["the root lockfile", "bun.lock", both],
  ["root TypeScript settings", "tsconfig.json", both],
  ["the nested Bun bootstrap action", ".github/actions/install-bun/action.yml", both],
  ["the normal workflow", ".github/workflows/test.yml", both],
  ["an internal guide", "docs/architecture.md", neither],
  ["a release-only workflow", ".github/workflows/release.yml", neither],
  ["a Web test", "apps/web/src/theme/schemes.test.ts", neither],
])("selects the expected builds for %s", (_label, file, expected) => {
  withHistory(added(file), (run) => expect(run("pull_request")).toBe(expected))
})

test("selects both sides of a rename and does not drop deleted inputs", () => {
  withHistory('R "packages/desktop/src/old.ts" "apps/web/public/new name.txt"\n', (run) => {
    expect(run("pull_request")).toBe(both)
  })
  withHistory('D "packages/desktop/src/old.ts"\n', (run) => {
    expect(run("pull_request")).toBe(desktopOnly)
  })
})

test("builds both when a native comparison is missing or uncertain", () => {
  withHistory(added("docs/architecture.md"), (run) => {
    expect(run("workflow_dispatch")).toBe(both)
    expect(run("pull_request", { CI_PR_BASE: "0".repeat(40) })).toBe(both)
    expect(run("pull_request", { CI_PR_BASE: "a".repeat(40) })).toBe(both)
    expect(run("pull_request", { CI_PR_HEAD: "a".repeat(40) })).toBe(both)
    expect(run("pull_request", { GITHUB_SHA: "a".repeat(40) })).toBe(both)
  })
})

function yamlFields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a YAML mapping")
  return Object.fromEntries(Object.entries(value))
}

test("keeps branch pushes out of CI while retaining pull requests and manual runs", () => {
  for (const name of ["test", "typecheck", "nix-eval"]) {
    const events = workflowEvents(name)
    expect(events).not.toHaveProperty("push")
    expect(events).toHaveProperty("pull_request")
    expect(events).toHaveProperty("workflow_dispatch")
  }
  expect(yamlFields(workflowEvents("nix-hashes").push).branches).toEqual(["beta"])
  expect(workflowEvents("nix-hashes")).toHaveProperty("workflow_dispatch")
  expect(workflowEvents("release").push).toEqual({ tags: ["v*"] })
  expect(workflowEvents("release")).toHaveProperty("workflow_dispatch")
  const selector = workflowJobs("test")["build-inputs"]?.steps.find((step) => step.id === "select")
  expect(selector?.shell).toBe("bash")
  expect(selector?.run).toBe('bun script/ci-build-inputs.ts | tee -a "$GITHUB_OUTPUT"')
})

function workflowEvents(name: string) {
  const workflow = yamlFields(Bun.YAML.parse(readFileSync(path.join(root, `.github/workflows/${name}.yml`), "utf8")))
  return yamlFields(workflow.on)
}

function workflowJobs(name: string) {
  const workflow = yamlFields(Bun.YAML.parse(readFileSync(path.join(root, `.github/workflows/${name}.yml`), "utf8")))
  return Object.fromEntries(Object.entries(yamlFields(workflow.jobs)).map(([id, value]) => {
    const job = yamlFields(value)
    if (!Array.isArray(job.steps)) throw new Error(`Missing workflow steps for ${id}`)
    return [id, { name: job.name, if: job.if, needs: job.needs, steps: job.steps.map(yamlFields) }]
  }))
}

test("keeps the normal source and Desktop checks successful on a skip and exposes real build failures", () => {
  const jobs = workflowJobs("test")
  expect(jobs.source?.name).toBe("source verification (linux)")
  expect(jobs.desktop?.name).toBe("desktop frontend verification")
  for (const [job, target, commands] of [
    ["source", "web", ["bun run build:web", "bun run build:cloudflare"]],
    ["desktop", "desktop", ["bun run --cwd packages/desktop build:frontend"]],
  ] as const) {
    const check = jobs[job]!
    expect(check.needs).toBe("build-inputs")
    expect(check.if).toBe("${{ !cancelled() }}")
    for (const command of commands) {
      const build = check.steps.find((step) => step.run === command)
      expect(build?.if).toBe(`needs.build-inputs.outputs.${target} != 'false'`)
      expect(build).not.toHaveProperty("continue-on-error")
    }
    const skip = check.steps.find((step) => step.if === `needs.build-inputs.outputs.${target} == 'false'` && typeof step.run === "string" && step.run.startsWith("echo "))
    expect(skip).toBeDefined()
  }
  const source = jobs.source!.steps
  for (const step of source.filter((step) => typeof step.run === "string" && /bun test|check:generated/.test(step.run))) expect(step.if).toBeUndefined()
})

test("retains the entire release workflow, including full builds, publication and deployment", () => {
  const release = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")
  const jobs = workflowJobs("release")
  const prepare = "${{ github.event_name == 'workflow_dispatch' }}"
  const publish = "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}"
  for (const job of ["verify-source", "build", "build-desktop", "finalize-release"]) expect(jobs[job]?.if).toBe(prepare)
  for (const job of ["release-tui", "deploy-web"]) expect(jobs[job]?.if).toBe(publish)
  expect(jobs["finalize-release"]?.needs).toEqual(["verify-source", "build", "build-desktop"])
  expect(jobs["release-tui"]?.needs).toBe("verify-staged-release")
  expect(jobs["deploy-web"]?.needs).toEqual(["verify-staged-release", "release-tui"])
  expect(jobs["verify-source"]?.steps.find((step) => step.run === "bun run build:web")?.if).toBe("matrix.suite == 'web'")
  const desktop = jobs["build-desktop"]?.steps.find((step) => typeof step.run === "string" && step.run.includes("packages/desktop/script/build.sh"))
  expect(desktop).toBeDefined()
  expect(desktop?.if).toBeUndefined()
  expect([...release.matchAll(/- suite: (\S+)/g)].map((match) => match[1])).toEqual(["types", "web", "cli", "tui-project", "tui-runtime"])
  expect([...release.matchAll(/- target: (\S+)/g)].map((match) => match[1])).toEqual(["darwin-arm64"])
  expect(release).not.toContain("build-inputs")
})
