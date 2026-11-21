import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function inspect(manifest: string, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-rust-test-layout-"))
  try {
    const crate = path.join(root, "rust/crates/example")
    await mkdir(path.join(crate, "tests"), { recursive: true })
    await Bun.write(
      path.join(crate, "Cargo.toml"),
      `[package]\nname = "ycoding-example"\nversion = "0.1.0"\n${manifest}`,
    )
    await Promise.all(
      Object.entries(files).map(([name, content]) => Bun.write(path.join(crate, "tests", name), content)),
    )
    const process = Bun.spawn(["python3", path.join(import.meta.dir, "rust_test_layout.py"), root], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("automatic Rust test targets retain their source identities", async () => {
  const result = await inspect("", { "one.rs": "#[test] fn first() {}", "empty.rs": "pub fn fixture() {}" })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).packages["ycoding-example"]).toEqual({
    "empty.rs": { target: "empty", prefix: "" },
    "one.rs": { target: "one", prefix: "" },
  })
})

test("explicit suites map each source once while preserving standalone targets", async () => {
  const result = await inspect(
    'autotests = false\n[[test]]\nname = "contracts"\npath = "tests/contracts.rs"\n[[test]]\nname = "isolated"\npath = "tests/isolated.rs"\n',
    {
      "one.rs": "#![cfg(unix)]\n#[test] fn first() {}",
      "two.rs": "#[test] #[ignore] fn second() {}",
      "isolated.rs": "#[test] fn process_isolation() {}",
      "contracts.rs": '#[path = "one.rs"]\npub mod one;\n#[path = "two.rs"]\npub mod two;\n',
    },
  )
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).packages["ycoding-example"]).toEqual({
    "isolated.rs": { target: "isolated", prefix: "" },
    "one.rs": { target: "contracts", prefix: "one::" },
    "two.rs": { target: "contracts", prefix: "two::" },
  })
})

test("an unregistered Rust test source fails the layout gate", async () => {
  const result = await inspect("autotests = false\n", { "one.rs": "#[test] fn first() {}" })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("unregistered test source one.rs")
})

test("an explicit target cannot duplicate an automatically discovered source", async () => {
  const result = await inspect('[[test]]\nname = "duplicate"\npath = "tests/one.rs"\n', {
    "one.rs": "#[test] fn first() {}",
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("test source one.rs is registered more than once")
})

test("a source included by two suites fails instead of running its cases twice", async () => {
  const result = await inspect('autotests = false\n[[test]]\nname = "first"\n[[test]]\nname = "second"\n', {
    "one.rs": "#[test] fn first() {}",
    "first.rs": '#[path = "one.rs"]\npub mod one;\n',
    "second.rs": '#[path = "one.rs"]\npub mod one;\n',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("test source one.rs is registered more than once")
})

test("automatic discovery cannot coexist with explicit suite aggregation", async () => {
  const result = await inspect('[[test]]\nname = "contracts"\n', {
    "one.rs": "#[test] fn first() {}",
    "contracts.rs": '#[path = "one.rs"]\npub mod one;\n',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("suite aggregation requires autotests = false")
})

test("suite module paths cannot escape the crate test directory", async () => {
  const result = await inspect('autotests = false\n[[test]]\nname = "contracts"\n', {
    "contracts.rs": '#[path = "../../outside.rs"]\npub mod outside;\n',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("suite module escapes its test directory")
})

test("a stale suite source path fails explicitly", async () => {
  const result = await inspect('autotests = false\n[[test]]\nname = "contracts"\n', {
    "contracts.rs": '#[path = "missing.rs"]\npub mod missing;\n',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("missing test source missing.rs")
})
