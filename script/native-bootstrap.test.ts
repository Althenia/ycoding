import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))

test("native generator metadata and pinned dependencies", () => {
  const protocol = json("packages/protocol/package.json")
  const client = json("packages/client/package.json")
  const cli = json("packages/cli/package.json")
  expect(protocol.exports["./v5"]).toBe("./src/v5/index.ts")
  expect(protocol.exports["./v5/connection"]).toBe("./src/v5/connection/index.ts")
  expect(protocol.scripts["generate:v5"]).toBe("bun run src/v5/generate.ts")
  expect(protocol.dependencies["@bufbuild/protobuf"]).toBe("2.16.0")
  expect(protocol.devDependencies["@bufbuild/protoc-gen-es"]).toBe("2.16.0")
  expect(client.exports["./v5"]).toBe("./src/v5/index.ts")
  expect(client.scripts["generate:v5"]).toBe("bun run script/generate-v5.ts")
  expect(cli.dependencies["@npmcli/arborist"]).toBe("9.4.0")
  expect(cli.dependencies["@npmcli/config"]).toBe("10.8.1")
  expect(cli.dependencies["mime-types"]).toBe("3.0.2")
  expect(cli.dependencies["npm-package-arg"]).toBe("13.0.2")
})

test("Rust setup pins tools and verifies protoc without a dependency cache", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  expect(action).toContain('RUST_VERSION: "1.98.1"')
  expect(action).toContain('PROTOC_VERSION: "36.2"')
  expect(action).toContain('test "$actual" = "$sha256"')
  expect(action).toContain('echo "PROTOC=$executable" >> "$GITHUB_ENV"')
  expect(action).not.toContain("actions/cache/")
  const before = action.split("- name: Install Rust toolchain")[0]
  expect(before).toContain("uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0")
  for (const entry of ["~/.rustup/toolchains", "~/.rustup/update-hashes", "~/.rustup/settings.toml"])
    expect(before).toContain(entry)
  expect(before).toContain("key: ${{ runner.os }}-${{ runner.arch }}-rustup-1.98.1")
})

test("Rust notices commands remain available", () => {
  const scripts = json("package.json").scripts
  expect(scripts["generate:rust-notices"]).toBe("bun script/rust-notices.ts")
  expect(scripts["check:rust-notices"]).toBe("bun script/rust-notices.ts --check")
})


test("release targets install checksum-verified native Rust and protoc", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  for (const platform of ["Linux-X64", "macOS-ARM64", "macOS-X64", "Windows-X64"])
    expect(action).toContain(`${platform})`)
  expect(action).toContain("228cc7add4616cc14ca5e80dee83209d44449a7aee95a914ae748fa374efb078")
  const workflow = Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")) as {
    jobs: { build: { strategy: { matrix: { include: { target: string }[] } }; steps: { uses?: string }[] } }
  }
  expect(workflow.jobs.build.strategy.matrix.include.map((entry) => entry.target).sort()).toEqual([
    "darwin-arm64", "darwin-x64", "linux-x64", "windows-x64",
  ])
  expect(workflow.jobs.build.steps.some((step) => step.uses === "./.github/actions/setup-rust")).toBe(true)
})


test("source verification selects native wire and autonomy contracts", () => {
  const workflow = Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")) as {
    jobs: { "verify-source": { steps: { name: string; if?: string; run?: string }[] } }
  }
  const steps = workflow.jobs["verify-source"].steps
  const selected = steps.find((step) => step.name === "Verify native contract boundaries")
  expect(selected?.if).toBe("matrix.suite == 'tui-runtime'")
  expect(selected?.run).toContain("-p ycoding-schema --test autonomy_review")
  expect(selected?.run).toContain("-p ycoding-protocol --test wire_session")
  expect(selected?.run).not.toContain("--workspace")
})


test("native contract runtime is built and verified before test feature unification", () => {
  const workflow = Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")) as {
    jobs: { "verify-source": { steps: { name: string; run?: string }[] } }
  }
  const steps = workflow.jobs["verify-source"].steps
  const receipt = steps.findIndex((step) => step.name === "Build and verify native runtime receipt")
  const contracts = steps.findIndex((step) => step.name === "Verify native contract boundaries")
  expect(receipt).toBeGreaterThanOrEqual(0)
  expect(receipt).toBeLessThan(contracts)
  expect(steps[receipt]?.run).toContain("cargo build --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --bin ycoding-runtime")
  expect(steps[receipt]?.run).toContain("script/runtime-receipt.sh write")
  expect(steps[receipt]?.run).toContain("script/runtime-receipt.sh verify")
})
