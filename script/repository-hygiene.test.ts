import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

function git(args: string[], input?: string) {
  return spawnSync("git", args, { cwd: root, input, encoding: "utf8" })
}

test("the Git index excludes local verification output and runtime caches", () => {
  const result = git(["ls-files", "-z"])
  expect(result.status).toBe(0)
  expect(
    result.stdout
      .split("\0")
      .filter(
        (file) => /^(?:\.lane-logs|\.cache|\.bun|rust\/target)\//.test(file) || /(?:^|\/)node_modules\//.test(file),
      ),
  ).toEqual([])
})

test("verification records and caches remain ignored before they exist", () => {
  const files = [
    ".lane-logs/check.command",
    ".lane-logs/check.exit",
    ".lane-logs/check.inputs",
    ".lane-logs/check.log",
    ".lane-logs/wire-view/cache/bun/@t@/example.pile",
    ".cache/verification/check.log",
    ".bun/example.pile",
    "rust/target/debug/ycoding-runtime",
    "packages/client/node_modules/example/index.js",
  ]
  const result = git(["check-ignore", "--no-index", "-z", "--stdin"], `${files.join("\0")}\0`)
  expect(result.status).toBe(0)
  expect(result.stdout.split("\0").filter(Boolean)).toEqual(files)
})

test("source, contracts, lockfiles, fixtures and assets remain eligible for tracking", () => {
  const files = [
    "BETA_HANDOFF.md",
    "rust/Cargo.lock",
    "bun.lock",
    "rust/crates/core/src/lib.rs",
    "protocol/ycoding/v5/session.proto",
    "packages/protocol/src/generated/v5/contract.ts",
    "rust/crates/schema/tests/fixtures/domain-json-inputs.json",
    "extensions/meeting/test/fixture/stable-meeting/checkpointed/meetings.sqlite",
    "extensions/meeting/test/fixture/stable-meeting/wal/meetings.sqlite",
    "extensions/chrome/icons/ycoding-16.png",
    "rust/crates/schema/tests/fixtures/example.inputs",
    "rust/.lane-logs/example.txt",
  ]
  const result = git(["check-ignore", "--no-index", "-z", "--stdin"], `${files.join("\0")}\0`)
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
})
