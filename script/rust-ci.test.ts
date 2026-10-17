import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const read = (file: string) => Bun.file(path.join(root, file)).text()
const action = await read(".github/actions/setup-rust/action.yml")
const release = await read(".github/workflows/release.yml")
const testWorkflow = await read(".github/workflows/test.yml")
const steps = (Bun.YAML.parse(action) as { runs: { steps: { name: string; if?: string; run?: string; uses?: string; env?: Record<string, string> }[] } }).runs.steps

const protoc = [
  ["Linux-X64", "linux-x86_64", "121f6c7afe1d4d0e3ea6aab9432038599250134cbf4474cb1167d2c7decd4278"],
  ["macOS-ARM64", "osx-aarch_64", "9cd98a532c5c5e0c4161314de0225de27e4c8a323917b6ea7b1b714d3ae23466"],
  ["macOS-X64", "osx-x86_64", "228cc7add4616cc14ca5e80dee83209d44449a7aee95a914ae748fa374efb078"],
  ["Windows-X64", "win64", "f0c128dc0d8492eceece83bb459a4c0e316764b929ffbf1aa416357fd644edd3"],
] as const

function section(content: string, from: string, to?: string) {
  const start = content.split(from)[1] ?? ""
  return to ? (start.split(to)[0] ?? "") : start
}

function step(content: string, name: string) {
  return content.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0] ?? ""
}

async function run(name: string, env: Record<string, string>, shim?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-setup-rust-"))
  try {
    const bin = path.join(dir, "bin")
    await fs.mkdir(bin)
    if (shim) {
      await Bun.write(path.join(bin, "curl"), shim)
      await fs.chmod(path.join(bin, "curl"), 0o755)
    }
    const github = path.join(dir, "github-env")
    await Bun.write(github, "")
    const definition = steps.find((item) => item.name === name)!
    const child = Bun.spawn(["bash", "-c", definition.run!], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RUNNER_TEMP: dir,
        GITHUB_ENV: github,
        ...definition.env,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { code, stderr, github: await Bun.file(github).text() }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("setup-rust pins Rust 1.98.1 with rustfmt and clippy through the runner's rustup", () => {
  const toolchain = steps.find((item) => item.name === "Install Rust toolchain")!
  expect(toolchain.env?.RUST_VERSION).toBe("1.98.1")
  expect(toolchain.run).toContain('rustup toolchain install "$RUST_VERSION" --profile minimal --component rustfmt --component clippy')
  expect(toolchain.run).toContain('echo "RUSTUP_TOOLCHAIN=$RUST_VERSION" >> "$GITHUB_ENV"')
  expect(toolchain.run).toContain("cargo fmt --version")
  expect(toolchain.run).toContain("cargo clippy --version")
})

test("setup-rust uses no third-party action and installs no unpinned tool", () => {
  expect(steps.every((item) => item.uses === undefined)).toBe(true)
  expect(action).not.toContain("latest")
  expect(action).not.toContain("brew ")
  expect(action).not.toContain("apt-get")
  expect(action).not.toContain("choco")
})

test.each(protoc)("setup-rust pins the verified protoc 36.2 archive and SHA-256 for %s", (platform, asset, sha256) => {
  const install = steps.find((item) => item.name === "Install protoc")!
  expect(install.env?.PROTOC_VERSION).toBe("36.2")
  expect(install.run).toContain(`${platform}) asset=${asset}; sha256=${sha256} ;;`)
  expect(install.run).toContain(
    'https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOC_VERSION/protoc-$PROTOC_VERSION-$asset.zip',
  )
  expect(install.run).toContain('echo "PROTOC=$executable" >> "$GITHUB_ENV"')
  expect(install.run!.indexOf("checksum mismatch")).toBeLessThan(install.run!.indexOf("Expand-Archive"))
  expect(install.run!.indexOf("checksum mismatch")).toBeLessThan(install.run!.indexOf("unzip"))
})

test("setup-rust fails clearly when the runner has no rustup", async () => {
  const result = await run("Install Rust toolchain", { RUNNER_OS: "Linux" })
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("rustup is not installed")
  expect(result.github).toBe("")
})

test("setup-rust rejects an unsupported runner platform before downloading", async () => {
  const result = await run("Install protoc", { RUNNER_OS: "Linux", RUNNER_ARCH: "ARM64" }, "#!/bin/sh\nexit 99\n")
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Unsupported runner for protoc 36.2: Linux-ARM64")
  expect(result.github).toBe("")
})

test("setup-rust rejects a protoc archive whose SHA-256 differs and never exports PROTOC", async () => {
  const result = await run(
    "Install protoc",
    { RUNNER_OS: "Linux", RUNNER_ARCH: "X64" },
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then printf tampered > "$2"; fi; shift; done\n',
  )
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("protoc checksum mismatch")
  expect(result.github).toBe("")
})

test.each(["core", "protocol"])("%s build script resolves protoc through PROTOC or PATH", async (crate) => {
  const build = await read(`rust/crates/${crate}/build.rs`)
  expect(build).not.toContain("/opt/homebrew")
  expect(build).not.toContain("protoc_executable")
  expect(build).toContain('println!("cargo:rerun-if-env-changed=PROTOC");')
})

const runtimeBuild =
  "cargo build --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --bin ycoding-runtime"
const ready =
  'bun run rust/crates/runtime/tests/support/ready-runtime.ts "$GITHUB_WORKSPACE/rust/target/debug/ycoding-runtime" bun run --cwd'

test("release verification runs the Rust gates in a 20-minute Ubuntu leg", () => {
  const verify = section(release, "\n  verify-source:", "\n  build:")
  expect(verify).toContain(["          - suite: rust", "            runner: ubuntu-24.04"].join("\n"))
  expect(verify).toContain("    timeout-minutes: 20\n")
  const check = step(verify, "Verify Rust workspace")
  expect(check).toContain("        if: matrix.suite == 'rust'\n")
  const commands = [
    "python3 script/rust-workspace-check.py",
    "cargo fmt --manifest-path rust/Cargo.toml --all -- --check",
    "cargo clippy --locked --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings",
    "cargo test --locked --manifest-path rust/Cargo.toml --workspace --no-fail-fast",
  ]
  commands.forEach((command, index) => {
    expect(check).toContain(command)
    if (index > 0) expect(check.indexOf(commands[index - 1]!)).toBeLessThan(check.indexOf(command))
  })
  const interop = step(verify, "Verify Rust runtime client interoperability")
  expect(interop).toContain("        if: matrix.suite == 'rust'\n")
  expect(interop).toContain(`${ready} packages/client test:integration:rust`)
  expect(verify.indexOf("- name: Build debug runtime")).toBeLessThan(verify.indexOf("- name: Verify Rust workspace"))
  expect(verify.indexOf("- name: Verify Rust workspace")).toBeLessThan(
    verify.indexOf("- name: Verify Rust runtime client interoperability"),
  )
})

test("legs that execute the native runtime install Rust and build the debug runtime before their suites", () => {
  const verify = section(release, "\n  verify-source:", "\n  build:")
  const condition = "matrix.suite == 'rust' || matrix.suite == 'remote' || matrix.suite == 'cli' || matrix.suite == 'browser'"
  expect(step(verify, "Setup Rust")).toBe(
    `        if: ${condition} || matrix.suite == 'rust-windows'\n        uses: ./.github/actions/setup-rust\n`,
  )
  expect(step(verify, "Build debug runtime")).toBe(`        if: ${condition}\n        run: ${runtimeBuild}\n`)
  expect(verify.indexOf("- name: Setup Bun")).toBeLessThan(verify.indexOf("- name: Setup Rust"))
  expect(verify.indexOf("- name: Setup Rust")).toBeLessThan(verify.indexOf("- name: Build debug runtime"))
  for (const name of [
    "Verify local remote integration",
    "Verify CLI suites",
    "Verify isolated-browser integration suites",
    "Verify Rust workspace",
  ])
    expect(verify.indexOf("- name: Build debug runtime")).toBeLessThan(verify.indexOf(`- name: ${name}`))
})

test("the browser leg runs the native runtime TUI suite and the explicit ignored Chrome check", () => {
  const verify = section(release, "\n  verify-source:", "\n  build:")
  expect(step(verify, "Verify isolated-browser integration suites")).toBe(
    [
      "        if: matrix.suite == 'browser'",
      "        run: |",
      "          set -euo pipefail",
      "          bun run --cwd packages/core test:integration:browser",
      "          bun run --cwd packages/server test:integration:browser",
      "",
    ].join("\n"),
  )
  expect(step(verify, "Verify native isolated-browser runtime")).toBe(
    ["        if: matrix.suite == 'browser'", `        run: ${ready} packages/tui test:integration:browser`, ""].join("\n"),
  )
  expect(step(verify, "Verify Rust isolated-browser integration")).toBe(
    [
      "        if: matrix.suite == 'browser'",
      "        env:",
      '          YCODING_TEST_ISOLATED_BROWSER_CHROME: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
      "        run: cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-core --test browser_native_integration -- --ignored",
      "",
    ].join("\n"),
  )
  expect(verify.indexOf("- name: Verify approved browser host")).toBeLessThan(
    verify.indexOf("- name: Verify native isolated-browser runtime"),
  )
})

test("native release builds install Rust before building the TUI artifact", () => {
  const build = section(release, "\n  build:", "\n  isolated-browser-acceptance:")
  expect(step(build, "Setup Rust")).toBe("        uses: ./.github/actions/setup-rust\n")
  expect(build.indexOf("- name: Setup Rust")).toBeLessThan(build.indexOf("- name: Build TUI artifact"))
  expect(build).toContain("    timeout-minutes: 30\n")
})

test("the test workflow installs Rust and builds the debug runtime before the unit suites and native builds", () => {
  expect(step(testWorkflow, "Setup Rust")).toBe("        uses: ./.github/actions/setup-rust\n")
  expect(step(testWorkflow, "Build debug runtime")).toBe(`        run: ${runtimeBuild}\n`)
  const order = ["Setup Bun", "Setup Rust", "Build debug runtime", "Run unit tests", "Verify compiled service lifecycle", "Verify Node build"]
  order.slice(1).forEach((name, index) =>
    expect(testWorkflow.indexOf(`- name: ${order[index]}`)).toBeLessThan(testWorkflow.indexOf(`- name: ${name}`)),
  )
  expect(testWorkflow).toContain("        timeout-minutes: 20\n        run: GITHUB_ACTIONS=false bun turbo test")
})

test("setup-rust selects the crate-shipped prebuilt NASM objects on Windows only", async () => {
  const nasm = steps.filter((item) => item.run?.includes("AWS_LC_SYS_PREBUILT_NASM"))
  expect(nasm.map((item) => item.name)).toEqual(["Select prebuilt NASM objects"])
  expect(nasm[0]!.if).toBe("runner.os == 'Windows'")
  const result = await run("Select prebuilt NASM objects", {})
  expect(result.code).toBe(0)
  expect(result.github).toBe("AWS_LC_SYS_PREBUILT_NASM=1\n")
})

async function protocWithVersionOutput(output: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-setup-protoc-"))
  try {
    const bin = path.join(dir, "bin")
    await fs.mkdir(bin)
    const shims: Record<string, string> = {
      curl: '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then : > "$2"; fi; shift; done\n',
      sha256sum: "#!/bin/sh\necho 121f6c7afe1d4d0e3ea6aab9432038599250134cbf4474cb1167d2c7decd4278  \"$1\"\n",
      unzip: `#!/bin/sh\nmkdir -p "$4/bin"\nprintf '#!/bin/sh\\nprintf "${output}"\\n' > "$4/bin/protoc"\nchmod +x "$4/bin/protoc"\n`,
    }
    for (const [name, script] of Object.entries(shims)) {
      await Bun.write(path.join(bin, name), script)
      await fs.chmod(path.join(bin, name), 0o755)
    }
    const github = path.join(dir, "github-env")
    await Bun.write(github, "")
    const definition = steps.find((item) => item.name === "Install protoc")!
    const child = Bun.spawn(["bash", "-c", definition.run!], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RUNNER_TEMP: dir,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        GITHUB_ENV: github,
        ...definition.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { code, stderr, github: (await Bun.file(github).text()).replace(dir, "<temp>") }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("setup-rust accepts protoc version output with Windows line endings", async () => {
  const result = await protocWithVersionOutput("libprotoc 36.2\\r\\n")
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.github).toBe("PROTOC=<temp>/protoc-36.2/bin/protoc\n")
})

test("setup-rust rejects a protoc whose version differs and never exports PROTOC", async () => {
  const result = await protocWithVersionOutput("libprotoc 36.1\\r\\n")
  expect(result.code).not.toBe(0)
  expect(result.github).toBe("")
})

test("every protoc fallback resolves PROTOC, then protoc on PATH", async () => {
  const hardcoded = Bun.spawnSync(["git", "grep", "--untracked", "-n", "opt/homebrew/bin/protoc", "--", ".", ":!script/rust-ci.test.ts"], {
    cwd: root,
  })
  expect(new TextDecoder().decode(hardcoded.stdout)).toBe("")
  const lookups = [
    ["rust/crates/protocol/tests/operation_generation.rs", 'std::env::var("PROTOC").unwrap_or_else(|_| "protoc".into())', 4],
    ["packages/protocol/src/v5/generate.ts", 'process.env.PROTOC ?? "protoc"', 2],
    ["packages/protocol/test/operation-generation.test.ts", 'process.env.PROTOC ?? "protoc"', 1],
    ["protocol/ycoding/v5/testdata/generate.py", 'os.environ.get("PROTOC", "protoc")', 1],
  ] as const
  for (const [file, lookup, count] of lookups) expect((await read(file)).split(lookup).length - 1, file).toBe(count)
  expect(await read("infra/cloudflare/test/integration/README.md")).toContain("Set `PROTOC` when `protoc` is not on `PATH`.")
})

test("the release source gate runs this contract test", () => {
  const verify = section(release, "\n  verify-source:", "\n  build:")
  expect(step(verify, "Verify installer and web assets")).toContain('"$GITHUB_WORKSPACE/script/rust-ci.test.ts"')
})

test("CLI tests are cached against the native runtime sources, and typecheck inputs stay hash-only", async () => {
  const turbo = JSON.parse(await read("turbo.json"))
  expect(turbo.tasks["@ycoding-ai/cli#test"].inputs).toEqual([
    "$TURBO_DEFAULT$",
    "$TURBO_ROOT$/rust/Cargo.toml",
    "$TURBO_ROOT$/rust/Cargo.lock",
    "$TURBO_ROOT$/rust/crates/**",
    "$TURBO_ROOT$/protocol/**",
    "$TURBO_ROOT$/.github/actions/setup-rust/**",
  ])
  for (const [name, task] of Object.entries<{ inputs?: string[]; outputs?: string[] }>(turbo.tasks))
    if (name.includes("typecheck")) expect(JSON.stringify(task), name).not.toContain("rust")
  expect(JSON.stringify(turbo.tasks["typecheck-inputs"])).toBe('{"dependsOn":["^typecheck-inputs"]}')
})

test("the Rust leg fetches every locked target's sources before the notice checks", async () => {
  const verify = section(release, "\n  verify-source:", "\n  build:")
  const fetch = step(verify, "Fetch locked Rust sources")
  expect(fetch).toBe("        if: matrix.suite == 'rust'\n        run: cargo fetch --locked --manifest-path rust/Cargo.toml\n")
  expect(step(verify, "Verify Rust notices")).toBe(
    [
      "        if: matrix.suite == 'rust'",
      "        run: |",
      "          set -euo pipefail",
      "          bun run check:rust-notices",
      "          bun test --cwd script ./rust-notices.test.ts",
      "",
    ].join("\n"),
  )
  for (const name of ["Setup Rust", "Verify Rust workspace", "Fetch locked Rust sources", "Verify Rust notices"])
    expect(verify.indexOf(`- name: ${name}`), name).toBeGreaterThan(-1)
  expect(verify.indexOf("- name: Setup Rust")).toBeLessThan(verify.indexOf("- name: Fetch locked Rust sources"))
  expect(verify.indexOf("- name: Fetch locked Rust sources")).toBeLessThan(verify.indexOf("- name: Verify Rust notices"))
  const scripts = JSON.parse(await read("package.json")).scripts
  expect(scripts["generate:rust-notices"]).toBe("bun script/rust-notices.ts")
  expect(scripts["check:rust-notices"]).toBe("bun script/rust-notices.ts --check")
})

const windowsProcessTest =
  "platform::process::tree::windows_tests::terminating_an_already_reaped_child_never_signals_the_stored_pid"
const testSteps = (
  Bun.YAML.parse(testWorkflow) as { jobs: { unit: { steps: { name: string; if?: string; run?: string; "timeout-minutes"?: number }[] } } }
).jobs.unit.steps
const windowsProcessStep = testSteps.find((item) => item.name === "Verify Windows process lifecycle")

test("the test workflow runs the native process tests on Windows before the unit suites", () => {
  expect(windowsProcessStep?.if).toBe("runner.os == 'Windows'")
  expect(windowsProcessStep?.["timeout-minutes"]).toBe(20)
  expect(windowsProcessStep?.run).toContain(
    "cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-core --lib platform::process",
  )
  expect(windowsProcessStep?.run).toContain(windowsProcessTest)
  const names = testSteps.map((item) => item.name)
  expect(names.indexOf("Build debug runtime")).toBeLessThan(names.indexOf("Verify Windows process lifecycle"))
  expect(names.indexOf("Verify Windows process lifecycle")).toBeLessThan(names.indexOf("Run unit tests"))
  expect(testSteps.find((item) => item.name === "Run unit tests")?.["timeout-minutes"]).toBe(20)
})

async function windowsProcessGate(cargo: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-windows-process-"))
  try {
    const bin = path.join(dir, "bin")
    await fs.mkdir(bin)
    await Bun.write(path.join(bin, "cargo"), cargo)
    await fs.chmod(path.join(bin, "cargo"), 0o755)
    const child = Bun.spawn(["bash", "-c", windowsProcessStep!.run!], {
      env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { code, stderr }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const filteredRun = (output: string, status = 0) =>
  `#!/bin/sh\ntest "$*" = "test --locked --manifest-path rust/Cargo.toml -p ycoding-core --lib platform::process" || exit 97\ncat <<'OUT'\n${output}\nOUT\nexit ${status}\n`

test("the Windows process gate passes only when the stale-PID test ran and succeeded", async () => {
  const ran = await windowsProcessGate(
    filteredRun(`running 1 test\r\ntest ${windowsProcessTest} ... ok\r\n\r\ntest result: ok. 1 passed; 0 failed`),
  )
  expect(ran.stderr).toBe("")
  expect(ran.code).toBe(0)
})

test("the Windows process gate fails when the filter matches no stale-PID test", async () => {
  const none = await windowsProcessGate(filteredRun("running 0 tests\n\ntest result: ok. 0 passed; 0 failed"))
  expect(none.code).not.toBe(0)
  expect(none.stderr).toContain("did not run")
  const ignored = await windowsProcessGate(
    filteredRun(`running 1 test\ntest ${windowsProcessTest} ... ignored\n\ntest result: ok. 0 passed; 0 failed; 1 ignored`),
  )
  expect(ignored.code).not.toBe(0)
})

test("the Windows process gate fails when cargo fails even if the stale-PID test passed", async () => {
  const failed = await windowsProcessGate(
    filteredRun(`running 2 tests\ntest ${windowsProcessTest} ... ok\ntest other ... FAILED`, 101),
  )
  expect(failed.code).not.toBe(0)
})

const verifySource = () => section(release, "\n  verify-source:", "\n  build:")
const releaseVerifySteps = (
  Bun.YAML.parse(release) as {
    jobs: { "verify-source": { steps: { name: string; if?: string; shell?: string; run?: string; uses?: string }[] } }
  }
).jobs["verify-source"].steps

test("release verification adds a native Windows leg that runs under bash without Bun", () => {
  const verify = verifySource()
  expect(verify).toContain(["          - suite: rust-windows", "            runner: windows-2025"].join("\n"))
  expect(verify).toContain("    defaults:\n      run:\n        shell: bash\n")
  expect(verify).toContain("    timeout-minutes: 20\n")
  expect(releaseVerifySteps.find((item) => item.name === "Setup Bun")?.if).toBe("matrix.suite != 'rust-windows'")
  const names = releaseVerifySteps.map((item) => item.name)
  expect(names.indexOf("Setup Rust")).toBeLessThan(names.indexOf("Verify Windows process lifecycle"))
  expect(releaseVerifySteps.find((item) => item.name === "Setup Rust")?.if).toContain("matrix.suite == 'rust-windows'")
  expect(releaseVerifySteps.find((item) => item.name === "Build debug runtime")?.if).not.toContain("rust-windows")
})

test("the release Windows leg runs the same process gate as the test workflow, in explicit bash", () => {
  const release = releaseVerifySteps.find((item) => item.name === "Verify Windows process lifecycle")
  expect(release?.if).toBe("matrix.suite == 'rust-windows'")
  expect(release?.shell).toBe("bash")
  expect(release?.run).toBe(windowsProcessStep?.run)
  expect(release?.run).toContain(windowsProcessTest)
  expect(releaseVerifySteps.filter((item) => item.if?.includes("rust-windows") && item.name !== "Setup Rust" && item.name !== "Setup Bun").map((item) => item.name)).toEqual([
    "Verify Windows process lifecycle",
  ])
})

test("the Windows leg gates web deployment without ignored failures and manual runs still publish nothing", () => {
  expect(release).not.toContain("continue-on-error")
  const deploy = section(release, "\n  deploy-web:", "\n    runs-on:")
  expect(deploy).toContain("    needs: [verify-source, package, isolated-browser-acceptance]\n")
  expect(deploy).toContain("    if: ${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}")
  expect(section(release, "\n  release-tui:", "\n    runs-on:")).toContain("    needs: deploy-web")
})
