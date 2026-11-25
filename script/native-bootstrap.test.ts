import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
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

test("Rust setup pins tools and verifies protoc before extracting cached archives", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  expect(action).toContain('RUST_VERSION: "1.98.1"')
  expect(action).toContain('PROTOC_VERSION: "36.2"')
  expect(action).toContain('test "$actual" = "$sha256"')
  expect(action).toContain('echo "PROTOC=$executable" >> "$GITHUB_ENV"')
  expect(action).not.toMatch(/actions\/cache(?:\/[a-z]+)?@(?![a-f0-9]{40}\b)/)
  const before = action.split("- name: Install Rust toolchain")[0]
  expect(before).toContain("uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0")
  for (const entry of ["~/.rustup/toolchains", "~/.rustup/update-hashes", "~/.rustup/settings.toml"])
    expect(before).toContain(entry)
  expect(before).toContain("key: ${{ runner.os }}-${{ runner.arch }}-rustup-1.98.1")
})

test("optional sccache installation verifies pinned archives before use", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  const step = (name: string) => action.split(`- name: ${name}\n`)[1]?.split("\n    - name: ")[0] ?? ""
  expect(action).toContain('  sccache:\n    description: "Install the checksum-verified sccache compiler wrapper"\n    required: false\n    default: "false"')
  const restore = step("Cache sccache archive")
  const install = step("Install sccache")
  const save = step("Save sccache archive")
  expect(restore).toContain("if: inputs.sccache == 'true'")
  expect(restore).toContain("uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9")
  expect(restore).toContain("key: ${{ runner.os }}-${{ runner.arch }}-sccache-archive-0.19.0")
  expect(install).toContain("if: inputs.sccache == 'true'")
  expect(install).toContain("version=0.19.0")
  expect(install).toContain("macOS-ARM64) target=aarch64-apple-darwin; sha256=a35a0b7d622618774bc1bb8102d72562dfb21e619f88b153b370d7f89bc286af")
  expect(install).toContain("Linux-X64) target=x86_64-unknown-linux-musl; sha256=aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd")
  expect(install).toContain('*) echo "Unsupported runner for sccache $version: $RUNNER_OS-$RUNNER_ARCH" >&2; exit 1 ;;')
  expect(install).toContain(`test "$(shasum -a 256 < "$archive" | cut -d' ' -f1)" = "$sha256" || { echo "sccache checksum mismatch for $target" >&2; exit 1; }`)
  const verify = install.indexOf('test "$(shasum -a 256')
  expect(verify).toBeGreaterThan(install.indexOf('curl --fail'))
  expect(verify).toBeLessThan(install.indexOf('tar -xzf "$archive"'))
  expect(install.indexOf('tar -xzf "$archive"')).toBeLessThan(install.indexOf('"$executable" --version'))
  expect(install).toContain('echo "$(dirname "$executable")" >> "$GITHUB_PATH"')
  expect(install).toContain('echo "SCCACHE_DIR=$RUNNER_TEMP/sccache-store" >> "$GITHUB_ENV"')
  expect(install.indexOf('>> "$GITHUB_PATH"')).toBeLessThan(install.indexOf('>> "$GITHUB_ENV"'))
  expect(save).toContain("uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9")
  expect(save).toContain("if: inputs.sccache == 'true' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && steps.sccache-archive.outputs.cache-hit != 'true'")
  expect(save).toContain("key: ${{ steps.sccache-archive.outputs.cache-primary-key }}")
  for (const cache of [restore, save]) expect(cache).toContain("path: ${{ runner.temp }}/sccache-archive-0.19.0")
})

test("generic Rust dependency cache keys on lockfile and vendor and saves only through the purging composite", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  const save = readFileSync(path.join(root, ".github/actions/setup-rust/save/action.yml"), "utf8")
  const restore = action.split("- name: Restore Rust dependencies and build artifacts\n")[1]?.split("\n    - name: ")[0] ?? ""
  expect(restore).toContain("if: inputs.release-cache == ''")
  expect(restore).toContain("id: cargo-cache")
  expect(restore).toContain("uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9")
  expect(restore).toContain("key: ${{ runner.os }}-${{ runner.arch }}-cargo-${{ inputs.cache-profile }}-${{ hashFiles('rust/Cargo.lock', 'rust/Cargo.toml', 'rust/vendor/**') }}\n")
  expect(restore).toContain("restore-keys: |\n          ${{ runner.os }}-${{ runner.arch }}-cargo-${{ inputs.cache-profile }}-\n")
  expect(restore).not.toContain("**/*.rs")
  expect(action).toContain("value: ${{ steps.cargo-cache.outputs.cache-hit }}")
  expect(action).toContain("value: ${{ steps.cargo-cache.outputs.cache-primary-key }}")
  expect(action).not.toContain("- name: Cache Rust dependencies and build artifacts")
  const purge = save.split("- name: Remove workspace build artifacts\n")[1]?.split("\n    - name: ")[0] ?? ""
  const saveStep = save.split("- name: Save Rust dependencies and build artifacts\n")[1] ?? ""
  for (const step of [purge, saveStep]) expect(step).toContain("if: always() && inputs.cache-key != '' && inputs.cache-hit != 'true'")
  expect(purge).toContain("cargo metadata --locked --manifest-path rust/Cargo.toml --no-deps")
  expect(purge).toContain('rm -rf "$profile/build/$name"')
  expect(saveStep).toContain("uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9")
  expect(saveStep).toContain("key: ${{ inputs.cache-key }}")
  expect(save.indexOf("- name: Remove workspace build artifacts")).toBeLessThan(save.indexOf("- name: Save Rust dependencies and build artifacts"))
  expect(saveStep.match(/path: \|\n([\s\S]+?)\n\s+key:/)?.[1]?.trim().split(/\n\s*/)).toEqual(
    restore.match(/path: \|\n([\s\S]+?)\s+key:/)?.[1]?.trim().split(/\n\s*/),
  )
})

test("workspace artifact purge keeps third-party artifacts whose names match workspace target names", () => {
  const save = Bun.YAML.parse(readFileSync(path.join(root, ".github/actions/setup-rust/save/action.yml"), "utf8")) as {
    runs: { steps: Array<{ name: string; run?: string }> }
  }
  const script = save.runs.steps.find((step) => step.name === "Remove workspace build artifacts")?.run ?? ""
  const work = mkdtempSync(path.join(os.tmpdir(), "ycoding-purge-"))
  try {
    mkdirSync(path.join(work, "rust"))
    for (const entry of ["Cargo.toml", "Cargo.lock", "crates", "vendor"])
      if (existsSync(path.join(root, "rust", entry))) symlinkSync(path.join(root, "rust", entry), path.join(work, "rust", entry))
    const release = path.join(work, "rust/target/release")
    const hash = "0123456789abcdef"
    const thirdParty = [
      `deps/liblog-${hash}.rlib`,
      `deps/liblog-${hash}.rmeta`,
      `deps/log-${hash}.d`,
      `.fingerprint/log-${hash}/lib-log`,
    ]
    const workspace = [
      `deps/libycoding_core-${hash}.rlib`,
      `.fingerprint/ycoding-core-${hash}/lib-ycoding_core`,
      "ycoding-runtime",
    ]
    for (const file of [...thirdParty, ...workspace]) {
      mkdirSync(path.dirname(path.join(release, file)), { recursive: true })
      writeFileSync(path.join(release, file), "")
    }
    mkdirSync(path.join(release, "build"), { recursive: true })
    const result = Bun.spawnSync(["bash", "-c", script], { cwd: work, stdout: "pipe", stderr: "pipe" })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    expect(thirdParty.filter((file) => !existsSync(path.join(release, file)))).toEqual([])
    expect(workspace.filter((file) => existsSync(path.join(release, file)))).toEqual([])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}, 120_000)

test("vendored timestamps normalize only after an exact dependency cache hit", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  const step = action.split("- name: Normalize vendored source timestamps\n")[1]?.split("\n    - name: ")[0] ?? ""
  expect(step).toContain("if: steps.release-cache.outputs.cache-hit == 'true' || steps.cargo-cache.outputs.cache-hit == 'true'")
  expect(step).toContain("run: find rust/vendor -exec touch -t 200001010000 {} +")
  expect(action.indexOf("- name: Restore Apple Silicon release dependencies")).toBeLessThan(action.indexOf("- name: Normalize vendored source timestamps"))
  expect(action.indexOf("- name: Restore Rust dependencies and build artifacts")).toBeLessThan(action.indexOf("- name: Normalize vendored source timestamps"))
})

test("Rust notices commands remain available", () => {
  const scripts = json("package.json").scripts
  expect(scripts["generate:rust-notices"]).toBe("bun script/rust-notices.ts")
  expect(scripts["check:rust-notices"]).toBe("bun script/rust-notices.ts --check")
})


test("the Apple Silicon runtime producer installs checksum-verified native Rust and protoc", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  for (const platform of ["Linux-X64", "macOS-ARM64", "macOS-X64", "Windows-X64"])
    expect(action).toContain(`${platform})`)
  expect(action).toContain("228cc7add4616cc14ca5e80dee83209d44449a7aee95a914ae748fa374efb078")
  const workflow = Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")) as {
    jobs: { "build-desktop-runtime": { "runs-on": string; steps: { name: string; uses?: string }[] } }
  }
  const build = workflow.jobs["build-desktop-runtime"]
  expect(build["runs-on"]).toBe("macos-26")
  expect(build.steps.filter((step) => step.uses === "./.github/actions/setup-rust").map((step) => step.name)).toEqual(["Setup Rust"])
})

test("only the default-branch Apple Silicon runtime producer writes the release dependency cache", () => {
  const action = readFileSync(path.join(root, ".github/actions/setup-rust/action.yml"), "utf8")
  const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")
  const restore = action.split("- name: Restore Apple Silicon release dependencies\n")[1]?.split("\n    - name: ")[0] ?? ""
  const save = workflow.split("- name: Save Apple Silicon release dependencies\n")[1]?.split("\n      - name: ")[0] ?? ""
  const build = workflow.split("\n  build-desktop-runtime:\n")[1]?.split("\n  finalize-release:\n")[0] ?? ""
  const [producer, packagers] = build.split("\n      - name: Import macOS signing identity\n")
  if (producer === undefined || packagers === undefined) throw new Error("Missing Apple Silicon runtime or signing steps")
  expect(restore).toContain("uses: actions/cache/restore@")
  expect(restore).toContain("rust/Cargo.lock")
  expect(restore).not.toContain("**/*.rs")
  expect(save).toContain("uses: actions/cache/save@")
  expect(save).toContain("github.event.repository.default_branch")
  expect(save).toContain("key: ${{ steps.desktop-rust.outputs.release-cache-key }}")
  expect(restore.match(/path: \|\n([\s\S]+?)\s+key:/)?.[1]?.trim().split(/\n\s*/)).toEqual(
    save.match(/path: \|\n([\s\S]+?)\s+key:/)?.[1]?.trim().split(/\n\s*/),
  )
  expect(producer).toContain("- name: Save Apple Silicon release dependencies")
  expect(producer).toContain("release-cache: writer")
  const stage = producer.split("- name: Stage Apple Silicon release runtime\n")[1]?.split("\n      - name: ")[0] ?? ""
  expect(build).not.toMatch(/YCODING_(?:ANTIGRAVITY|MUSE)_(?:CLIENT_ID|CLIENT_SECRET)/)
  expect(producer).not.toContain("secrets.")
  for (const name of ["YCODING_MACOS_SIGNING_P12", "YCODING_MACOS_SIGNING_PASSWORD"]) {
    expect([...build.matchAll(new RegExp(`secrets\\.${name}`, "g"))]).toHaveLength(1)
    expect(packagers.split("\n      - name: ")[0]).toContain(`secrets.${name}`)
  }
  expect(stage).not.toContain("Missing $name Actions secret")
  expect(stage).not.toContain("The release runtime does not embed")
  expect(stage).not.toContain("A provider client value is present in the release cache path")
  expect(stage).toContain('bun packages/cli/script/runtime.ts stage-release "$RUNNER_TEMP/release-runtime"')
  expect(stage).toContain('if [ "$SAVES_RELEASE_CACHES" = true ]; then')
  expect(stage).toContain('rm -f "$release/ycoding-runtime" "$release/ycoding-runtime.d"')
  expect(packagers).not.toContain("release-cache:")
  expect(packagers).not.toContain("actions/cache/save@")
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
