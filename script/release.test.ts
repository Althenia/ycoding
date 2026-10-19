import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const workflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/release.yml")).text()
const testWorkflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/test.yml")).text()
const checks = workflow.split("\n").filter((line) => line.trim().startsWith("tar -tz"))

const jobs = (Bun.YAML.parse(workflow) as { jobs: Record<string, { steps: { name: string; run?: string }[] }> }).jobs
const script = (job: string, name: string) => jobs[job]!.steps.find((step) => step.name === name)!.run!
const job = (name: string) => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0] ?? ""

async function inTemporary<T>(prefix: string, use: (root: string) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    return await use(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function bash(source: string, cwd: string, env: Record<string, string>) {
  const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", source], {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

type Scope = {
  version: string
  channel: string
  suites: { suite: string; runner: string }[]
  targets: { target: string; runner: string; platform: string; arch: string }[]
}

function resolveScope(input: { version?: string; ref: string; notes: Record<string, string> }) {
  return inTemporary("ycoding-release-scope-", async (root) => {
    for (const [version, text] of Object.entries(input.notes))
      await Bun.write(path.join(root, `docs/releases/v${version}.md`), text)
    const output = path.join(root, "output")
    await Bun.write(output, "")
    const result = bash(script("scope", "Select release scope"), root, {
      INPUT_VERSION: input.version ?? "",
      GITHUB_REF: input.ref,
      GITHUB_REF_NAME: input.ref.replace(/^refs\/(heads|tags)\//, ""),
      GITHUB_OUTPUT: output,
    })
    const values = Object.fromEntries(
      (await Bun.file(output).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    )
    if (result.code !== 0) return { code: result.code, stderr: result.stderr, values }
    return {
      code: result.code,
      stderr: result.stderr,
      values,
      scope: {
        version: values.version,
        channel: values.channel,
        suites: JSON.parse(values.suites),
        targets: JSON.parse(values.targets),
      } as Scope,
    }
  })
}

const stableSuites = [
  { suite: "types", runner: "ubuntu-24.04" },
  { suite: "web", runner: "ubuntu-24.04" },
  { suite: "remote", runner: "ubuntu-24.04" },
  { suite: "cli", runner: "ubuntu-24.04" },
  { suite: "tui", runner: "ubuntu-24.04" },
  { suite: "browser", runner: "macos-26" },
  { suite: "extension", runner: "macos-26" },
  { suite: "rust", runner: "ubuntu-24.04" },
  { suite: "rust-macos", runner: "macos-26" },
  { suite: "rust-windows", runner: "windows-2025" },
]
const betaSuites = [
  { suite: "types", runner: "ubuntu-24.04" },
  { suite: "web", runner: "ubuntu-24.04" },
  { suite: "remote", runner: "ubuntu-24.04" },
  { suite: "cli", runner: "ubuntu-24.04" },
  { suite: "tui", runner: "ubuntu-24.04" },
  { suite: "browser", runner: "macos-26" },
  { suite: "extension", runner: "macos-26" },
  { suite: "rust-macos", runner: "macos-26" },
]
const appleSilicon = { target: "darwin-arm64", runner: "macos-26", platform: "darwin", arch: "arm64" }
const stableTargets = [
  appleSilicon,
  { target: "linux-x64", runner: "ubuntu-24.04", platform: "linux", arch: "x64" },
  { target: "windows-x64", runner: "windows-2025", platform: "win32", arch: "x64" },
]
const plist = [
  "<key>CFBundleIdentifier</key><string>app.ycoding.computer-use</string>",
  "<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>",
  "<key>CFBundleIconFile</key><string>YCoding.icns</string>",
].join("\n")

async function nativeArtifact(root: string, target: string) {
  const directory = path.join(root, "unpacked", `ycoding-${target}`)
  await Bun.write(path.join(directory, "ycoding-chrome-extension/manifest.json"), "{}\n")
  if (target.startsWith("windows")) return Bun.write(path.join(directory, "ycoding.exe"), "synthetic executable\n")
  await Bun.write(path.join(directory, "ycoding"), "synthetic executable\n")
  if (!target.startsWith("darwin")) return
  const contents = path.join(directory, "YCoding Computer Use.app/Contents")
  await Bun.write(path.join(contents, "Info.plist"), `${plist}\n`)
  await Bun.write(path.join(contents, "MacOS/ycoding-computer-use"), "synthetic app\n")
  await Bun.write(path.join(contents, "Resources/YCoding.icns"), "synthetic icon\n")
  await Bun.write(path.join(contents, "_CodeSignature/CodeResources"), "synthetic resources\n")
}

function packageRelease(root: string, version: string, targets: { target: string }[]) {
  return bash(script("package", "Create release archives and checksums"), root, {
    RELEASE_VERSION: version,
    RELEASE_TARGETS: JSON.stringify(targets),
  })
}

function verifyPrepared(root: string, version: string, targets: { target: string }[]) {
  return bash(script("release-tui", "Verify prepared release assets"), root, {
    RELEASE_VERSION: version,
    RELEASE_TARGETS: JSON.stringify(targets),
  })
}

function preparedRelease<T>(
  version: string,
  targets: { target: string }[],
  artifacts: string[],
  use: (root: string, result: ReturnType<typeof bash>) => Promise<T>,
) {
  return inTemporary("ycoding-release-package-", async (root) => {
    await Bun.write(path.join(root, "LICENSE"), "synthetic license\n")
    await Bun.write(path.join(root, "NOTICE"), "synthetic notice\n")
    await Bun.write(path.join(root, `docs/releases/v${version}.md`), "synthetic release notes\n")
    for (const target of artifacts) await nativeArtifact(root, target)
    return use(root, packageRelease(root, version, targets))
  })
}

for (const valid of [true, false])
  test(
    valid ? "archive checks consume complete listings" : "archive checks reject a missing executable and app",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-release-check-"))
      try {
        const entries = path.join(root, "entries")
        await fs.mkdir(entries)
        await Bun.write(path.join(entries, "ycoding"), "synthetic executable\n")
        if (valid) {
          await fs.chmod(path.join(entries, "ycoding"), 0o755)
          await Bun.write(
            path.join(entries, "YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use"),
            "synthetic app\n",
          )
          await fs.chmod(path.join(entries, "YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use"), 0o755)
          await Bun.write(path.join(entries, "ycoding-chrome-extension/manifest.json"), "{}\n")
        }
        // Exceed the pipe buffer after the first match to expose an early-closing grep.
        for (let index = 0; index < 500; index++)
          await Bun.write(path.join(entries, `${index}-${"fixture".repeat(20)}`), "synthetic listing entry\n")
        const archive = path.join(root, "archive.tar.gz")
        const create = Bun.spawn(
          [
            "tar",
            "-czf",
            archive,
            "-C",
            entries,
            "ycoding",
            ...(valid ? ["YCoding Computer Use.app", "ycoding-chrome-extension"] : []),
            ...(await fs.readdir(entries)).filter((name) => !name.toLowerCase().startsWith("ycoding")),
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        expect(await create.exited).toBe(0)
        expect(checks.length).toBeGreaterThan(0)
        for (const check of checks) {
          const command = check.trim().replace(/"release\/[^"]+"/, '"$ARCHIVE"')
          // BSD tar can hide EPIPE; cat preserves a producer failure like GNU tar in release CI.
          const result = Bun.spawn(
            ["bash", "-o", "pipefail", "-c", `tar() { command tar "$@" > "$LISTING" && cat "$LISTING"; }; ${command}`],
            {
              env: { ...process.env, ARCHIVE: archive, LISTING: path.join(root, "listing") },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const error = await new Response(result.stderr).text()
          expect((await result.exited) === 0, `${command}: ${error}`).toBe(valid)
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )

test("release workflow ships no Godot desktop client", () => {
  expect(workflow).not.toMatch(/godot/i)
  expect(workflow).not.toMatch(/\boffice\b/i)
})

test.each([
  ["a stable tag", { ref: "refs/tags/v0.10.18", notes: { "0.10.18": "# YCoding v0.10.18\n" } }, "0.10.18", "latest"],
  [
    "a beta tag",
    { ref: "refs/tags/v0.11.0-beta.1", notes: { "0.11.0-beta.1": "# YCoding v0.11.0-beta.1\n" } },
    "0.11.0-beta.1",
    "beta",
  ],
  [
    "a manual beta-branch run without a version",
    {
      ref: "refs/heads/beta",
      notes: { "0.10.17": "# YCoding v0.10.17\n", "0.11.0-beta.1": "# YCoding v0.11.0-beta.1\n" },
    },
    "0.11.0-beta.1",
    "beta",
  ],
  [
    "a manual run with an explicit stable version",
    {
      version: "0.10.17",
      ref: "refs/heads/beta",
      notes: { "0.10.17": "# YCoding v0.10.17\n", "0.11.0-beta.1": "# YCoding v0.11.0-beta.1\n" },
    },
    "0.10.17",
    "latest",
  ],
  [
    "a manual run on a branch whose name starts with v",
    { ref: "refs/heads/v2", notes: { "0.10.17": "# YCoding v0.10.17\n" } },
    "0.10.17",
    "latest",
  ],
] as const)("the release scope resolves %s once", async (_, input, version, channel) => {
  const result = await resolveScope(input)
  expect(result.code, result.stderr).toBe(0)
  expect(result.scope?.version).toBe(version)
  expect(result.scope?.channel).toBe(channel)
  expect(result.scope?.suites).toEqual(channel === "beta" ? betaSuites : stableSuites)
  expect(result.scope?.targets).toEqual(channel === "beta" ? [appleSilicon] : stableTargets)
})

test.each([
  [
    "an invalid version",
    { version: "1.2", ref: "refs/heads/beta", notes: { "1.2": "notes\n" } },
    "Invalid release version: 1.2",
  ],
  [
    "missing notes",
    { ref: "refs/tags/v0.11.0-beta.2", notes: { "0.11.0-beta.1": "notes\n" } },
    "Missing release notes: docs/releases/v0.11.0-beta.2.md",
  ],
  [
    "empty notes",
    { ref: "refs/tags/v0.11.0-beta.1", notes: { "0.11.0-beta.1": "" } },
    "Release notes are empty: docs/releases/v0.11.0-beta.1.md",
  ],
] as const)("the release scope rejects %s before selecting any job", async (_, input, message) => {
  const result = await resolveScope(input)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain(message)
  expect(result.values).toEqual({})
})

test("the release scope is resolved once, from the exact source, without credentials, and every matrix inherits it", () => {
  const scope = job("scope")
  expect(scope).toContain(
    "    if: ${{ github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/v') }}\n",
  )
  expect(scope).toContain("          fetch-depth: 0\n          persist-credentials: false\n")
  expect(scope).toContain("          INPUT_VERSION: ${{ inputs.version }}\n")
  expect(scope).not.toContain("secrets.")
  expect(scope).not.toContain("permissions:")
  expect(script("scope", "Select release scope")).not.toContain("${{")
  expect(scope.indexOf("- name: Verify tag is reachable from release branch")).toBeLessThan(
    scope.indexOf("- name: Select release scope"),
  )
  for (const name of ["verify-source", "build"]) {
    expect(job(name)).toContain("    needs: scope\n")
    expect(job(name)).toContain(
      [
        "    env:",
        "      RELEASE_VERSION: ${{ needs.scope.outputs.version }}",
        "      YCODING_VERSION: ${{ needs.scope.outputs.version }}",
        "      YCODING_CHANNEL: ${{ needs.scope.outputs.channel }}",
      ].join("\n"),
    )
  }
  expect(job("verify-source")).toContain("        include: ${{ fromJSON(needs.scope.outputs.suites) }}\n")
  expect(job("build")).toContain("        include: ${{ fromJSON(needs.scope.outputs.targets) }}\n")
  for (const name of ["package", "release-tui"])
    expect(job(name)).toContain("      RELEASE_VERSION: ${{ needs.scope.outputs.version }}\n")
  expect(workflow.match(/- name: Select release scope/g)).toHaveLength(1)
  expect(workflow.match(/- name: Verify tag is reachable from release branch/g)).toHaveLength(1)
  expect(workflow).not.toContain("Resolve release version")
  expect(workflow).not.toContain('"${{ inputs.version }}"')
})

test("release workflows and Rust setup build, package, and expect no Intel macOS target", async () => {
  const action = await Bun.file(path.join(import.meta.dir, "../.github/actions/setup-rust/action.yml")).text()
  for (const content of [workflow, action])
    for (const intel of ["darwin-x64", "macos-15-intel", "macos-13", "osx-x86_64", "macOS-X64", "x86_64-apple-darwin"])
      expect(content).not.toContain(intel)
})

test.each([
  [
    "stable",
    "9.9.9",
    stableTargets,
    ["ycoding-9.9.9-darwin-arm64.tar.gz", "ycoding-9.9.9-linux-x64.tar.gz", "ycoding-9.9.9-windows-x64.zip"],
  ],
  ["beta", "9.9.9-beta.1", [appleSilicon], ["ycoding-9.9.9-beta.1-darwin-arm64.tar.gz"]],
] as const)(
  "%s packaging archives exactly the scoped targets with the license texts and one checksum file",
  (_, version, targets, archives) =>
    preparedRelease(
      version,
      targets,
      targets.map((target) => target.target),
      async (root, result) => {
        expect(result.code, result.stderr).toBe(0)
        const assets = [...archives, "LICENSE", "NOTICE", `v${version}.md`]
        expect((await fs.readdir(path.join(root, "release"))).sort()).toEqual(
          [...assets, `ycoding-${version}-checksums.txt`].sort(),
        )
        const sums = (await Bun.file(path.join(root, `release/ycoding-${version}-checksums.txt`)).text())
          .trim()
          .split("\n")
        expect(sums.map((line) => line.split(/\s+/)[1]).sort()).toEqual([...assets].sort())
        const archive = path.join(root, `release/ycoding-${version}-darwin-arm64.tar.gz`)
        const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString().trim().split("\n")
        expect([...new Set(listing.map((entry) => entry.split("/")[0]))].sort()).toEqual([
          "YCoding Computer Use.app",
          "ycoding",
          "ycoding-chrome-extension",
        ])
        const verified = verifyPrepared(root, version, targets)
        expect(verified.code, verified.stderr).toBe(0)
      },
    ),
)

test.each([
  ["an unverified Linux executable beside a beta", "9.9.9-beta.1", [appleSilicon], ["darwin-arm64", "linux-x64"]],
  ["a missing Windows executable from a stable release", "9.9.9", stableTargets, ["darwin-arm64", "linux-x64"]],
] as const)("packaging rejects %s", (_, version, targets, artifacts) =>
  preparedRelease(version, targets, [...artifacts], async (root, result) => {
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Downloaded executables do not match the release targets")
    expect(await fs.readdir(root)).not.toContain("release")
  }),
)

test("packaging rejects an incomplete signed app bundle", () =>
  inTemporary("ycoding-release-app-", async (root) => {
    await Bun.write(path.join(root, "LICENSE"), "synthetic license\n")
    await Bun.write(path.join(root, "NOTICE"), "synthetic notice\n")
    await nativeArtifact(root, "darwin-arm64")
    await fs.rm(path.join(root, "unpacked/ycoding-darwin-arm64/YCoding Computer Use.app/Contents/_CodeSignature"), {
      recursive: true,
    })
    expect(packageRelease(root, "9.9.9-beta.1", [appleSilicon]).code).not.toBe(0)
    expect(await fs.readdir(path.join(root, "release"))).toEqual([])
  }))

test.each([
  [
    "an extra unverified archive",
    async (root: string) => Bun.write(path.join(root, "release/ycoding-9.9.9-beta.1-linux-x64.tar.gz"), "unverified\n"),
    "do not match the release targets",
  ],
  [
    "a modified archive",
    async (root: string) =>
      Bun.write(path.join(root, "release/ycoding-9.9.9-beta.1-darwin-arm64.tar.gz"), "tampered\n"),
    "FAILED",
  ],
  [
    "modified release notes",
    async (root: string) => Bun.write(path.join(root, "release/v9.9.9-beta.1.md"), "tampered\n"),
    "FAILED",
  ],
  [
    "a checksum file that omits an asset",
    async (root: string) => {
      const file = path.join(root, "release/ycoding-9.9.9-beta.1-checksums.txt")
      await Bun.write(
        file,
        (await Bun.file(file).text())
          .split("\n")
          .filter((line) => !line.endsWith("NOTICE"))
          .join("\n"),
      )
    },
    "does not cover exactly the release assets",
  ],
] as const)("publication rejects %s before creating the release", (_, mutate, message) =>
  preparedRelease("9.9.9-beta.1", [appleSilicon], ["darwin-arm64"], async (root, result) => {
    expect(result.code, result.stderr).toBe(0)
    await mutate(root)
    const verified = verifyPrepared(root, "9.9.9-beta.1", [appleSilicon])
    expect(verified.code).not.toBe(0)
    expect(verified.stderr + verified.stdout).toContain(message)
  }),
)

test("publication verifies the prepared assets before creating the release", () => {
  const publish = job("release-tui")
  expect(publish.indexOf("- name: Download prepared release assets")).toBeLessThan(
    publish.indexOf("- name: Verify prepared release assets"),
  )
  expect(publish.indexOf("- name: Verify prepared release assets")).toBeLessThan(
    publish.indexOf("- name: Create GitHub release"),
  )
  expect(publish).toContain("          RELEASE_TARGETS: ${{ needs.scope.outputs.targets }}\n")
  expect(job("package")).toContain("          RELEASE_TARGETS: ${{ needs.scope.outputs.targets }}\n")
})

test("release builds prove the release profile recovers from panics before signing and building", async () => {
  const build = job("build")
  expect(build).toContain(
    "          cargo build --locked --manifest-path rust/Cargo.toml --release -p ycoding-runtime -p ycoding-store --bin ycoding-runtime --example release_recovery\n" +
      "          \"rust/target/release/examples/release_recovery${{ runner.os == 'Windows' && '.exe' || '' }}\"\n",
  )
  expect(build).not.toContain("cargo run")
  expect(build.indexOf("- name: Setup Rust")).toBeLessThan(build.indexOf("- name: Verify release panic recovery"))
  expect(build.indexOf("- name: Verify release panic recovery")).toBeLessThan(
    build.indexOf("- name: Import macOS signing identity"),
  )
  expect(build.indexOf("- name: Verify release panic recovery")).toBeLessThan(
    build.indexOf("- name: Build TUI artifact"),
  )
  const action = await Bun.file(path.join(import.meta.dir, "../.github/actions/setup-rust/action.yml")).text()
  for (const content of [workflow, action]) {
    expect(content).not.toContain("CARGO_PROFILE_RELEASE_PANIC")
    expect(content).not.toContain("panic=abort")
  }
  expect(await Bun.file(path.join(import.meta.dir, "../rust/crates/store/examples/release_recovery.rs")).exists()).toBe(
    true,
  )
})

test.each([
  ["the recovery example succeeds", 0, true],
  ["the recovery example aborts", 134, false],
] as const)(
  "the release panic gate builds the runtime and example in one Cargo selection and fails unless %s",
  (_, status, passes) =>
    inTemporary("ycoding-release-panic-", async (root) => {
      const models = path.join(root, "packages/cli/script/models-dev.snapshot.json")
      await Bun.write(models, "{}\n")
      const calls = path.join(root, "calls")
      const source = script("build", "Verify release panic recovery").replace(
        "${{ runner.os == 'Windows' && '.exe' || '' }}",
        "",
      )
      const result = bash(
        [
          `cargo() { printf 'cargo %s\\nmodels %s\\n' "$*" "$YCODING_BUNDLED_MODELS_PATH" >> "$CALLS"; mkdir -p rust/target/release/examples; printf '#!/bin/sh\\necho example >> "$CALLS"\\nexit ${status}\\n' > rust/target/release/examples/release_recovery; chmod +x rust/target/release/examples/release_recovery; }`,
          source,
        ].join("\n"),
        root,
        { CALLS: calls },
      )
      expect(result.code === 0, result.stderr).toBe(passes)
      expect(await Bun.file(calls).text()).toBe(
        [
          "cargo build --locked --manifest-path rust/Cargo.toml --release -p ycoding-runtime -p ycoding-store --bin ycoding-runtime --example release_recovery",
          `models ${await fs.realpath(models)}`,
          "example",
          "",
        ].join("\n"),
      )
    }),
)

const macGates =
  "test-integration/node-build.test.ts test/computer-use-packaging.test.ts test/update.test.ts test/install-local.test.ts"

test("the Apple Silicon build runs the macOS CLI packaging, installer, and updater gates against its warm release build", () => {
  const build = job("build")
  const step = build.split("      - name: Verify macOS CLI packaging, installer, and updater\n")[1] ?? ""
  expect(step).toContain("        if: runner.os == 'macOS'\n        working-directory: packages/cli\n")
  expect(step).toContain('        env:\n          YCODING_MACOS_SIGNING_IDENTITY: ""\n')
  expect(step).toContain(`bun test --timeout 30000 ${macGates} 2>&1 | tee`)
  expect(build.indexOf("- name: Build TUI artifact")).toBeLessThan(
    build.indexOf("- name: Verify macOS CLI packaging, installer, and updater"),
  )
  expect(build.indexOf("- name: Remove macOS signing keychain")).toBeLessThan(
    build.indexOf("- name: Verify macOS CLI packaging, installer, and updater"),
  )
})

test.each([
  ["every test passes", " 41 pass\n 0 fail\n", 0, true],
  ["a test is skipped", " 40 pass\n 1 skip\n 0 fail\n", 0, false],
  ["a test is marked todo", " 40 pass\n 2 todo\n 0 fail\n", 0, false],
  ["the suite fails", " 40 pass\n 1 fail\n", 1, false],
] as const)("the macOS CLI gate passes only when %s", (_, log, status, passes) =>
  inTemporary("ycoding-macos-cli-gate-", async (root) => {
    const result = bash(
      `bun() { test "$*" = "test --timeout 30000 ${macGates}" || exit 97; printf '%s' "$LOG" >&2; return "$STATUS"; }\n${script("build", "Verify macOS CLI packaging, installer, and updater")}`,
      root,
      { RUNNER_TEMP: root, LOG: log, STATUS: String(status) },
    )
    expect(result.code === 0, result.stderr).toBe(passes)
  }),
)

test("macOS release builds sign the app with the pinned release certificate and never fall back to ad hoc", () => {
  const build = workflow.split("\n  build:")[1]?.split("\n  isolated-browser-acceptance:")[0] ?? ""
  const importStep =
    build.split("      - name: Import macOS signing identity")[1]?.split("      - name: Build TUI artifact")[0] ?? ""
  const stage =
    build.split("      - name: Stage native executables")[1]?.split("      - name: Upload native executables")[0] ?? ""
  expect(build).toContain("      YCODING_MACOS_SIGNING_IDENTITY: YCoding Code Signing")
  expect(build).toContain("      YCODING_MACOS_SIGNING_SHA1: 9dd524184b0db949ffac7f0ada0ae860ac7f5f85\n")
  expect(importStep).toContain("if: runner.os == 'macOS'")
  expect(importStep).toContain("YCODING_MACOS_SIGNING_P12: ${{ secrets.YCODING_MACOS_SIGNING_P12 }}")
  expect(importStep).toContain("YCODING_MACOS_SIGNING_PASSWORD: ${{ secrets.YCODING_MACOS_SIGNING_PASSWORD }}")
  expect(importStep).toContain(
    'test -n "$YCODING_MACOS_SIGNING_P12" || { echo "Missing YCODING_MACOS_SIGNING_P12 Actions secret" >&2; exit 1; }',
  )
  expect(importStep).toContain(
    'test -n "$YCODING_MACOS_SIGNING_PASSWORD" || { echo "Missing YCODING_MACOS_SIGNING_PASSWORD Actions secret" >&2; exit 1; }',
  )
  for (const command of [
    'security create-keychain -p "$keychain_password" "$keychain"',
    'security unlock-keychain -p "$keychain_password" "$keychain"',
    "-T /usr/bin/codesign",
    'security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"',
    'security list-keychains -d user -s "$keychain" ${original[@]+"${original[@]}"}',
    'echo "::add-mask::$keychain_password"',
  ])
    expect(importStep).toContain(command)
  expect(importStep).not.toContain("|| true")
  expect(importStep).not.toContain("login.keychain")
  expect(importStep).toContain(
    'grep -F "$(printf \'%s\' "$YCODING_MACOS_SIGNING_SHA1" | tr a-f A-F) \\"$YCODING_MACOS_SIGNING_IDENTITY\\""',
  )
  expect(build.indexOf("- name: Import macOS signing identity")).toBeLessThan(
    build.indexOf("- name: Build TUI artifact"),
  )
  expect(stage).toContain('codesign --verify --deep --strict "$staging/YCoding Computer Use.app"')
  expect(stage).toContain(
    'codesign -d -r- "$staging/YCoding Computer Use.app" 2>&1 | grep -Ex "designated => identifier',
  )
  expect(build).toContain("if: ${{ always() && runner.os == 'macOS' }}")
  expect(build).toContain('security list-keychains -d user -s "${original[@]}"')
  expect(build).toContain('security delete-keychain "$keychain"')
  expect(workflow).not.toContain("codesign --force --sign -")
  expect(workflow).not.toContain("ad-hoc")
})

test("isolated-browser acceptance accepts installed Chrome 152 or newer", async () => {
  const browserHost = await Bun.file(
    path.join(import.meta.dir, "../.github/actions/verify-browser-host/action.yml"),
  ).text()
  const check = /\n(\s*major="\$\(printf[\s\S]*?\n\s*\})\n/.exec(browserHost)?.[1]
  expect(check).toBeDefined()
  const accepts = (version: string) =>
    Bun.spawnSync(["bash", "-euo", "pipefail", "-c", `version=${JSON.stringify(version)}\n${check}`], {
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode === 0
  expect(accepts("Google Chrome 151.0.7000.10")).toBe(false)
  expect(accepts("Google Chrome 152.0.7100.20")).toBe(true)
  expect(accepts("Google Chrome 153.0.8010.54")).toBe(true)
  expect(accepts("Google Chrome 1000.0.1.2")).toBe(true)
  expect(accepts("Google Chrome")).toBe(false)
  expect(workflow).not.toContain("Chrome 152)")
})

test("release archives include the Chrome extension beside the executable", () => {
  expect(workflow).toContain('cp -R "dist/tui/tui-${{ matrix.target }}/bin/ycoding-chrome-extension" "$staging/"')
  expect(workflow).toContain(
    'tar -C "$source" -czf "release/ycoding-$version-$target.tar.gz" ycoding ycoding-chrome-extension',
  )
  expect(workflow).toContain('zip -r "../../release/ycoding-$version-$target.zip" ycoding.exe ycoding-chrome-extension')
  expect(workflow).toContain(
    `tar -tzf "release/ycoding-$version-$target.tar.gz" | grep -x 'ycoding-chrome-extension/manifest.json' >/dev/null`,
  )
})

test("macOS release archives stage the signed app and preserve its bundle tree", () => {
  expect(workflow).toContain('cp -R "dist/tui/tui-${{ matrix.target }}/bin/YCoding Computer Use.app" "$staging/"')
  expect(workflow).toContain('codesign --verify --deep --strict "$staging/YCoding Computer Use.app"')
  expect(workflow).toContain('chmod +x "$source/ycoding" "$app/Contents/MacOS/ycoding-computer-use"')
  expect(workflow).toContain('app="$source/YCoding Computer Use.app"')
  expect(workflow).toContain("mac_entries=(ycoding ycoding-chrome-extension)")
  expect(workflow).toContain(`grep -x 'YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use'`)
  expect(workflow).not.toContain("bin/ycoding-computer-use")
  expect(workflow).toContain('mac_entries+=("YCoding Computer Use.app")')
  expect(workflow).toContain(
    'test -f "$app/Contents/Resources/YCoding.icns" && test ! -L "$app/Contents/Resources/YCoding.icns" && test -s "$app/Contents/Resources/YCoding.icns"',
  )
  expect(workflow).toContain("<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>")
  expect(job("package")).toContain("runs-on: ubuntu-24.04")
  expect(job("package")).toContain('test "$(cd "$app" && find . -mindepth 1 | sed')
})

const pin = "9dd524184b0db949ffac7f0ada0ae860ac7f5f85"

test.each([
  ["a self-signed root requirement", `identifier "app.ycoding.computer-use" and certificate root = H"${pin}"`, true],
  ["a self-signed leaf requirement", `identifier "app.ycoding.computer-use" and certificate leaf = H"${pin}"`, true],
  ["an ad-hoc cdhash requirement", 'cdhash H"1593f00c9269224608bcfc16986b4c7b1b09a2d5"', false],
  [
    "a different certificate",
    `identifier "app.ycoding.computer-use" and certificate leaf = H"${"0".repeat(40)}"`,
    false,
  ],
  ["a different identifier", `identifier "app.ycoding.other" and certificate leaf = H"${pin}"`, false],
  ["an unanchored identifier only", 'identifier "app.ycoding.computer-use"', false],
])("the release signature check accepts only the pinned certificate: %s", (_, requirement, accepted) => {
  const stage =
    workflow.split("      - name: Stage native executables")[1]?.split("      - name: Upload native executables")[0] ??
    ""
  const check = stage
    .split("\n")
    .find((line) => line.includes("codesign -d -r-"))
    ?.trim()
  expect(check).toBeDefined()
  const command = check!.replace(/^codesign -d -r- "[^"]+" 2>&1/, 'printf "%s\\n" "designated => $REQUIREMENT"')
  const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", command], {
    env: { ...process.env, REQUIREMENT: requirement, YCODING_MACOS_SIGNING_SHA1: pin },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode === 0, result.stderr.toString()).toBe(accepted)
})

test("release archives keep the layout installed updaters accept and ship the license texts as separate assets", () => {
  expect(workflow).not.toContain('cp LICENSE NOTICE "$staging/"')
  expect(workflow).not.toMatch(/ycoding-chrome-extension LICENSE/)
  expect(workflow).toContain('cp LICENSE NOTICE "docs/releases/v$version.md" release/\n')
  const packageJob = job("package")
  expect(packageJob.indexOf('cp LICENSE NOTICE "docs/releases/v$version.md" release/')).toBeLessThan(
    packageJob.indexOf("sha256sum"),
  )
  expect(packageJob).toContain(
    '(cd release && sha256sum "${assets[@]}" LICENSE NOTICE "v$version.md" > "ycoding-$version-checksums.txt")',
  )
  expect(job("release-tui")).toContain('gh release create "v$version" release/*')
  expect(job("release-tui")).not.toContain('release/* "docs/releases/v$version.md"')
})

const tarGuard = workflow
  .split("\n")
  .find((line) => line.includes('test "$(tar -tzf') && line.includes("cut -d/ -f1 | LC_ALL=C sort -u"))!
  .trim()
const zipGuard = workflow
  .split("\n")
  .find((line) => line.includes('test "$(unzip -Z1') && line.includes("cut -d/ -f1 | LC_ALL=C sort -u"))!
  .trim()

for (const extra of [undefined, "LICENSE", "NOTICE", "extra"])
  test(
    extra
      ? `the archive layout guard rejects an extra ${extra} entry`
      : "the archive layout guard accepts exactly the entries installed updaters accept",
    () =>
      inTemporary("ycoding-release-layout-", async (root) => {
        const source = path.join(root, "source")
        await fs.mkdir(path.join(source, "YCoding Computer Use.app/Contents"), { recursive: true })
        await fs.mkdir(path.join(source, "ycoding-chrome-extension"))
        for (const file of [
          "ycoding",
          "ycoding.exe",
          "ycoding-chrome-extension/manifest.json",
          "YCoding Computer Use.app/Contents/Info.plist",
          "LICENSE",
          "NOTICE",
          "extra",
        ])
          await Bun.write(path.join(source, file), `${file}\n`)
        await fs.mkdir(path.join(root, "release"))
        const add = extra ? [extra] : []
        const cases = [
          ["darwin-arm64", ["ycoding", "ycoding-chrome-extension", "YCoding Computer Use.app"]],
          ["linux-x64", ["ycoding", "ycoding-chrome-extension"]],
        ] as const
        for (const [target, entries] of cases) {
          expect(
            bash(
              `tar -C ${JSON.stringify(source)} -czf "release/ycoding-9.9.9-${target}.tar.gz" ${[...entries, ...add].map((entry) => JSON.stringify(entry)).join(" ")}`,
              root,
              {},
            ).code,
          ).toBe(0)
          const result = bash(
            `version=9.9.9\ntarget=${target}\nexpected=(${entries.map((entry) => JSON.stringify(entry)).join(" ")})\n${tarGuard}`,
            root,
            {},
          )
          expect(result.code === 0, `${target}: ${result.stderr}`).toBe(extra === undefined)
        }
        expect(
          Bun.spawnSync(
            [
              "zip",
              "-qr",
              path.join(root, "release/ycoding-9.9.9-windows-x64.zip"),
              "ycoding.exe",
              "ycoding-chrome-extension",
              ...add,
            ],
            { cwd: source },
          ).exitCode,
        ).toBe(0)
        const zip = bash(`version=9.9.9\ntarget=windows-x64\n${zipGuard}`, root, {})
        expect(zip.code === 0, zip.stderr).toBe(extra === undefined)
      }),
  )

test("one v tag verifies a shared note and publishes only the TUI GitHub release", () => {
  const verify = job("verify-source")
  const tui = job("release-tui")
  expect(workflow).toContain("      - v*")
  expect(workflow).not.toContain("      - tui-v*")
  expect(workflow).not.toContain("      - web-v*")
  expect(job("scope")).toContain('release_notes="docs/releases/v$version.md"')
  expect(verify).toContain("bun run test:web")
  expect(verify).toContain("bun run test:remote")
  expect(verify).toContain("bun run test:integration:web")
  expect(verify).toContain("bun run test:integration:remote")
  expect(verify).toContain("bun run build:cloudflare")
  expect(tui).toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  expect(tui).toContain('gh release create "v$version"')
  expect(tui.match(/--title "[^"]+"/g)).toEqual(['--title "YCoding $version"'])
  expect(tui).toContain('release/* --verify-tag --target "$GITHUB_SHA"')
  expect(tui).toContain('test("^v[0-9]")')
  expect(tui).toContain('test(\\"^v[0-9]\\")')
  expect(tui).toContain("contents: write")
  expect((workflow.match(/gh release create /g) ?? []).length).toBe(1)
  expect((workflow.match(/contents: write/g) ?? []).length).toBe(1)
})

test("the first unified release has nonempty shared notes", async () => {
  const notes = Bun.file(path.join(import.meta.dir, "../docs/releases/v0.6.5.md"))
  expect(await notes.exists()).toBe(true)
  expect((await notes.text()).trim()).toContain("# YCoding v0.6.5")
})

const publishCondition =
  "${{ !cancelled() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && needs.verify-source.result == 'success' && needs.package.result == 'success' && needs.isolated-browser-acceptance.result == 'success' && (needs.deploy-web.result == 'success' || (needs.scope.outputs.channel == 'beta' && needs.deploy-web.result == 'skipped')) }}"

test("stable v tags deploy web after the shared checks without GitHub write access, and beta tags never deploy", () => {
  const deploy = job("deploy-web")
  expect(deploy).toContain("needs: [scope, verify-source, package, isolated-browser-acceptance]")
  expect(deploy).toContain(
    "    if: ${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && needs.scope.outputs.channel == 'latest' }}\n",
  )
  expect(deploy).toContain("bun run build:web")
  expect(deploy).toContain("          bun run deploy:cloudflare\n")
  expect(deploy.indexOf("bun run build:web")).toBeLessThan(deploy.indexOf("bun run deploy:cloudflare"))
  expect(workflow).not.toContain("--env beta")
  expect(deploy).not.toContain("gh release")
  expect(deploy).not.toContain("GH_TOKEN:")
  expect(deploy).not.toContain("contents: write")
  expect(workflow).not.toContain("verify-source-web:")
})

test("GitHub Release publication waits for every gate and a stable deployment, and accepts only a skipped beta deployment", () => {
  const tui = job("release-tui")
  expect(tui).toContain("    needs: [scope, verify-source, package, isolated-browser-acceptance, deploy-web]\n")
  expect(tui).toContain(`    if: ${publishCondition}\n`)
  expect(tui).toContain('case "$version" in *-beta.*) release_flags=(--prerelease --latest=false) ;; esac')
})

test("Cloudflare deployment requires a scoped Actions token before Wrangler runs", () => {
  const deploy = job("deploy-web")
  expect(deploy).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}")
  expect(deploy).toContain('test -n "$CLOUDFLARE_API_TOKEN"')
  expect(deploy.indexOf('test -n "$CLOUDFLARE_API_TOKEN"')).toBeLessThan(deploy.indexOf("bun run deploy:cloudflare"))
})

test("manual release runs prepare assets without publishing or deploying", () => {
  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow).toContain('        required: false\n        default: ""\n')
  for (const name of ["scope", "verify-source", "build", "isolated-browser-acceptance", "package"])
    expect(job(name)).toContain("github.event_name == 'workflow_dispatch'")
  expect(job("release-tui")).toContain("github.event_name == 'push'")
  expect(job("deploy-web")).toContain("github.event_name == 'push'")
})

test("release workflow verifies the web application and relay before the Cloudflare build", () => {
  expect(workflow).toContain("bun run test:web")
  expect(workflow).toContain("bun run test:remote")
  expect(workflow).toContain("bun run build:web")
  expect(workflow).toContain("bun run test:cloudflare")
  expect(workflow).toContain("bun run build:cloudflare")
  expect(workflow.indexOf("bun run build:web")).toBeLessThan(workflow.indexOf("bun run build:cloudflare"))
  // CLI, helper, and isolated-browser release checks stay in place.
  expect(workflow).toContain("bun run --cwd packages/core test:integration:browser")
  expect(workflow).toContain("bun run --cwd packages/server test:integration:browser")
  expect(workflow).toContain("bun run --cwd packages/tui test:integration:browser")
  expect(workflow).toContain("isolated-browser-smoke.ts")
})

test("test workflow verifies the web application and relay before the Cloudflare build", () => {
  expect(testWorkflow).toContain("bun run test:web")
  expect(testWorkflow).toContain("bun run test:remote")
  expect(testWorkflow).toContain("bun run build:web")
  expect(testWorkflow).toContain("bun run test:cloudflare")
  expect(testWorkflow).toContain("bun run build:cloudflare")
  expect(testWorkflow.indexOf("bun run build:web")).toBeLessThan(testWorkflow.indexOf("bun run build:cloudflare"))
})

test("web integration gates run against built artifacts in both workflows", () => {
  for (const content of [workflow, testWorkflow]) {
    expect(content).toContain("bun run test:integration:web")
    expect(content.indexOf("bun run build:web")).toBeLessThan(content.indexOf("bun run test:integration:web"))
  }
})

test("remote integration gate runs the composed real flow after the web build in both workflows", async () => {
  const rootPackage = JSON.parse(await Bun.file(path.join(import.meta.dir, "../package.json")).text())
  expect(rootPackage.scripts["test:integration:remote"]).toBe("bun infra/cloudflare/test/integration/real-flow.ts")
  expect(await Bun.file(path.join(import.meta.dir, "../infra/cloudflare/test/integration/real-flow.ts")).exists()).toBe(
    true,
  )
  for (const content of [workflow, testWorkflow]) {
    expect(content).toContain("bun run test:integration:remote")
    expect(content.indexOf("bun run build:web")).toBeLessThan(content.indexOf("bun run test:integration:remote"))
  }
  expect(testWorkflow).toContain(
    [
      "      - name: Verify local remote integration",
      "        if: runner.os == 'Linux'",
      "        timeout-minutes: 20",
      "        run: bun run test:integration:remote",
    ].join("\n"),
  )
  expect(workflow).toContain(
    [
      "      - name: Build web application",
      "        if: matrix.suite == 'web' || matrix.suite == 'remote'",
      "        run: bun run build:web",
    ].join("\n"),
  )
  expect(workflow).toContain(
    [
      "      - name: Verify local remote integration",
      "        if: matrix.suite == 'remote'",
      "        timeout-minutes: 20",
      "        run: bun run test:integration:remote",
    ].join("\n"),
  )
})

test("release types verification checks cache invalidation before typechecking", () => {
  const step = workflow.split("      - name: Check workspace and types")[1]?.split("\n      - name:")[0] ?? ""
  const check = "bun test --cwd script ./typecheck-cache.integration.test.ts"
  expect(step).toContain("if: matrix.suite == 'types'")
  expect(step).toContain(check)
  expect(step.indexOf(check)).toBeLessThan(step.indexOf("bun run typecheck"))
})

test("source verification legs start in parallel with the native builds once the scope is resolved", () => {
  const verify = job("verify-source")
  const build = job("build")
  expect(verify).toContain("    needs: scope\n")
  expect(build).toContain("    needs: scope\n")
  expect(verify).toContain("fail-fast: false")
  expect(verify).toContain("runs-on: ${{ matrix.runner }}")
  expect(build).toContain("runs-on: ${{ matrix.runner }}")
  for (const [step, condition] of [
    ["Check workspace and types", "matrix.suite == 'types'"],
    ["Verify web application and relay", "matrix.suite == 'web'"],
    ["Build web application", "matrix.suite == 'web' || matrix.suite == 'remote'"],
    ["Verify built web integration", "matrix.suite == 'web'"],
    ["Verify local remote integration", "matrix.suite == 'remote'"],
    ["Verify Cloudflare Worker", "matrix.suite == 'web'"],
    ["Verify CLI suites", "matrix.suite == 'cli'"],
    ["Verify Chrome extension suites", "matrix.suite == 'cli'"],
    ["Verify transcript and approval suites", "matrix.suite == 'tui'"],
    ["Verify goal continuation", "matrix.suite == 'tui'"],
    ["Verify installer and web assets", "matrix.suite == 'web'"],
    ["Verify approved browser host", "matrix.suite == 'browser' || matrix.suite == 'extension'"],
    ["Verify isolated-browser integration suites", "matrix.suite == 'browser'"],
    ["Provision Chrome for Testing", "matrix.suite == 'extension'"],
    ["Verify Chrome extension integration suite", "matrix.suite == 'extension'"],
    ["Verify native isolated-browser runtime", "matrix.suite == 'browser'"],
    ["Verify Rust isolated-browser integration", "matrix.suite == 'browser'"],
    ["Verify Rust workspace", "matrix.suite == 'rust' || matrix.suite == 'rust-macos'"],
    ["Verify Rust runtime client interoperability", "matrix.suite == 'rust' || matrix.suite == 'rust-macos'"],
  ])
    expect(verify).toContain(`      - name: ${step}\n        if: ${condition}\n`)
  expect(verify).toContain("uses: ./.github/actions/verify-browser-host")
  expect(verify).toContain("run: bun run test:extension")
  expect(verify).toContain("run: bun run test:integration:extension")
  expect(verify).toContain('executable="$(bun script/chrome-for-testing.ts "$RUNNER_TEMP/chrome-for-testing")"')
  expect(verify).toContain("YCODING_TEST_ISOLATED_BROWSER_CHROME=$executable")
  expect(verify).not.toContain("puppeteer")
  expect(verify).toContain('"$GITHUB_WORKSPACE/script/chrome-for-testing.test.ts"')
  expect(verify.indexOf("- name: Provision Chrome for Testing")).toBeLessThan(
    verify.indexOf("- name: Verify Chrome extension integration suite"),
  )
})

test("packaging overlaps packaged-browser acceptance without bypassing either deployment gate", () => {
  const sections = workflow
    .split("\njobs:\n")[1]!
    .split(/(?:^|\n) {2}([\w-]+):\n/)
    .slice(1)
  const dependencies = [
    ["scope", undefined],
    ["verify-source", "scope"],
    ["build", "scope"],
    ["isolated-browser-acceptance", "build"],
    ["package", "[scope, build]"],
    ["deploy-web", "[scope, verify-source, package, isolated-browser-acceptance]"],
    ["release-tui", "[scope, verify-source, package, isolated-browser-acceptance, deploy-web]"],
  ] as const
  expect(sections.filter((_, index) => index % 2 === 0).sort()).toEqual(dependencies.map(([name]) => name).sort())
  const prepare = "${{ github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/v') }}"
  for (const [name, needs] of dependencies) {
    const section = sections[sections.indexOf(name) + 1] ?? ""
    expect(/^ {4}needs: (.+)$/m.exec(section)?.[1]).toBe(needs)
    expect(/^ {4}if: (.+)$/m.exec(section)?.[1]).toBe(
      name === "release-tui"
        ? publishCondition
        : name === "deploy-web"
          ? "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && needs.scope.outputs.channel == 'latest' }}"
          : prepare,
    )
  }
  expect(workflow).not.toContain("continue-on-error:")
  expect(workflow).toContain("permissions:\n  contents: read\n")
  for (const name of ["scope", "verify-source"]) {
    expect(job(name)).not.toContain("secrets.")
    expect(job(name)).not.toContain("token:")
    expect(job(name)).not.toContain("permissions:")
    expect(job(name)).toContain("persist-credentials: false")
  }
  expect(job("scope")).toContain('git merge-base --is-ancestor "$GITHUB_SHA" "origin/$branch"')
  expect(job("scope")).toContain(
    "      - name: Verify tag is reachable from release branch\n        if: github.event_name == 'push'\n",
  )
})

test.each(["0.10.6", "0.11.0-beta.1", "0.11.0-beta.10"])("release version validation accepts %s", (version) => {
  const check = workflow
    .split("\n")
    .find((line) => line.includes("grep -Eq '^(0|"))!
    .trim()
    .replace(/ \\$/, "")
  expect(
    Bun.spawnSync(["bash", "-o", "pipefail", "-c", check], {
      env: { ...process.env, version },
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode,
  ).toBe(0)
})

test.each([
  ["v0.10.6", "main", ""],
  ["v0.11.0-beta.1", "beta", "--prerelease --latest=false"],
])("%s selects the release branch and publication flags", (tag, branch, flags) => {
  const sourceStep = script("scope", "Verify tag is reachable from release branch")
  const publicationStart = workflow.indexOf("          release_flags=()")
  const publicationEnd = workflow.indexOf("\n          gh release create", publicationStart)
  const publication = workflow.slice(publicationStart, publicationEnd)
  const result = Bun.spawnSync(
    [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      `git() { printf 'git %s\\n' "$*"; }\n${sourceStep}\nversion="$RELEASE_VERSION"\n${publication}\nprintf 'flags %s\\n' "\${release_flags[*]}"`,
    ],
    {
      env: {
        ...process.env,
        GITHUB_REF_NAME: tag,
        GITHUB_SHA: "synthetic-verified-sha",
        RELEASE_VERSION: tag.slice(1),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toContain(`origin ${branch}:refs/remotes/origin/${branch}`)
  expect(result.stdout.toString()).toContain(`git merge-base --is-ancestor synthetic-verified-sha origin/${branch}\n`)
  expect(result.stdout.toString()).toContain(`flags ${flags}\n`)
  expect(workflow).toContain('"${release_flags[@]}"')
})

test.each([
  ["0.10.6", true],
  ["0.11.0-beta.1", false],
])("changelog range lookup for %s filters prereleases only for stable releases", (version, stable) => {
  const start = workflow.indexOf('          case "$version" in\n            *-beta.*)\n              release_query=')
  const end = workflow.indexOf("\n          range=", start)
  const selection = workflow.slice(start, end)
  const result = Bun.spawnSync(
    [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      `gh() { printf '%s\n' "$*" >&3; if [ "$1" = api ]; then printf 'v0.10.6\n'; fi; }\nexec 3>&2\nversion="$RELEASE_VERSION"\nRELEASE_TAG="v$version"\nGH_REPO=Althenia/ycoding\n${selection}\nprintf '%s\n' "$prev"`,
    ],
    {
      env: { ...process.env, RELEASE_VERSION: version },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toBe("v0.10.6\n")
  expect(result.stderr.toString()).toContain("--json tagName,isPrerelease")
  expect(result.stderr.toString().includes(".isPrerelease == false")).toBe(stable)
  expect(result.stderr.toString().includes(".prerelease == false")).toBe(stable)
})

test("the packaged isolated-browser smoke waits for the native builds on the approved host", () => {
  const acceptance = workflow.split("\n  isolated-browser-acceptance:")[1]?.split("\n  package:")[0] ?? ""
  expect(acceptance).toContain("needs: build")
  expect(acceptance).toContain("runs-on: macos-26")
  expect(acceptance).toContain("uses: ./.github/actions/verify-browser-host")
  expect(acceptance).toContain("isolated-browser-smoke.ts")
  expect(acceptance).not.toContain("test:integration:browser")
})

test("obsolete Pages publishing is replaced by the web asset publisher", async () => {
  expect(await Bun.file(path.join(import.meta.dir, "../.github/workflows/pages.yml")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "pages.ts")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "pages.test.ts")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "build-pages.ts")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "build-web-assets.ts")).exists()).toBe(true)
  expect(workflow).toContain("script/build-web-assets.test.ts")
  expect(workflow).not.toContain("script/pages.test.ts")
})

const setupBun = await Bun.file(path.join(import.meta.dir, "../.github/actions/setup-bun/action.yml")).text()

test("setup installs the latest Bun on baseline and native runners without a version pin", () => {
  expect(setupBun).toContain("https://github.com/oven-sh/bun/releases/latest/download/bun-${OS}-x64-baseline.zip")
  expect(setupBun).toContain("bun-download-url: ${{ steps.bun-url.outputs.url }}")
  expect(setupBun).toMatch(/\n {8}bun-version: latest\n/)
  expect(setupBun).not.toContain("bun-version-file")
  expect(setupBun).not.toContain("packageManager")
})

test("setup installs Bun dependencies cold, without an Actions dependency cache or cache-warming workflow", async () => {
  expect(setupBun).not.toContain("actions/cache")
  expect(setupBun).toContain("bun install ${{ inputs.install-flags }}")
  expect(await Bun.file(path.join(import.meta.dir, "../.github/workflows/bun-cache.yml")).exists()).toBe(false)
})

test("Windows keeps the Bun cache on the runner's workspace disk before installing dependencies", () => {
  const beforeInstall = setupBun.split("- name: Install dependencies")[0] ?? ""
  expect(beforeInstall).toContain("if: runner.os == 'Windows'")
  expect(beforeInstall).toContain("BUN_INSTALL_CACHE_DIR=$RUNNER_TEMP/bun-install-cache")
})
