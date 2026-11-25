import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const helper = path.join(import.meta.dir, "runtime-receipt.sh")
const commit = "0123456789abcdef0123456789abcdef01234567"

const shims: Record<string, string> = {
  uname: '#!/bin/sh\ncase "$1" in -s) echo "$SHIM_OS" ;; -m) echo "$SHIM_ARCH" ;; *) exit 64 ;; esac\n',
  rustc: '#!/bin/sh\nprintf "rustc %s\\nhost: synthetic\\n" "$SHIM_RUSTC"\n',
  cargo: '#!/bin/sh\necho "cargo 1.98.1 (synthetic)"\n',
  cc: '#!/bin/sh\nprintf "cc (synthetic) %s\\nsecond line\\n" "$SHIM_CC"\n',
  "c++": '#!/bin/sh\nprintf "c++ (synthetic) %s\\n" "$SHIM_CC"\n',
  clang: '#!/bin/sh\nprintf "Apple clang %s\\nTarget: arm64\\n" "$SHIM_CC"\n',
  "clang++": '#!/bin/sh\nprintf "Apple clang++ %s\\n" "$SHIM_CC"\n',
  xcrun: '#!/bin/sh\ncase "$1" in --show-sdk-version) echo "$SHIM_SDK" ;; --show-sdk-build-version) echo 25A100 ;; *) exit 64 ;; esac\n',
  protoc: '#!/bin/sh\necho "libprotoc 36.2"\n',
  powershell: '#!/bin/sh\nprintf "14.44.35207\\r\\n"\n',
}

type Host = "linux" | "darwin"

async function fixture(root: string) {
  const bin = path.join(root, "shims")
  for (const [name, source] of Object.entries(shims)) {
    await Bun.write(path.join(bin, name), source)
    await fs.chmod(path.join(bin, name), 0o755)
  }
  await Bun.write(path.join(root, "rust/Cargo.lock"), "# synthetic lock\n")
  await Bun.write(path.join(root, "packages/cli/script/models-dev.snapshot.json"), '{"synthetic":true}\n')
  await Bun.write(path.join(root, "built/ycoding-runtime"), "#!/bin/sh\necho synthetic runtime\n")
  await fs.chmod(path.join(root, "built/ycoding-runtime"), 0o755)
}

function environment(root: string, host: Host, overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    PATH: [path.join(root, "shims"), path.dirname(Bun.which("jq")!), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    SHIM_OS: host === "darwin" ? "Darwin" : "Linux",
    SHIM_ARCH: host === "darwin" ? "arm64" : "x86_64",
    SHIM_RUSTC: "1.98.1",
    SHIM_CC: "17.0",
    SHIM_SDK: "26.0",
    ImageOS: host === "darwin" ? "macos26" : "ubuntu24",
    ImageVersion: "20261013.1",
    GITHUB_SHA: commit,
    RELEASE_VERSION: "0.11.0-beta.2",
    YCODING_CHANNEL: "beta",
    RECEIPT_TARGET: host === "darwin" ? "darwin-arm64" : "linux-x64",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    RUSTUP_TOOLCHAIN: "1.98.1",
    PROTOC: path.join(root, "shims/protoc"),
    ...overrides,
  }
  return Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function run(root: string, args: string[], env: Record<string, string>) {
  const result = Bun.spawnSync(["/bin/bash", helper, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

function prepared<T>(host: Host, use: (root: string, artifact: string, destination: string) => Promise<T>) {
  return (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-receipt-"))
    try {
      await fixture(root)
      const artifact = path.join(root, "artifact")
      const written = run(root, ["write", "built/ycoding-runtime", artifact], environment(root, host))
      expect(written.code, written.stderr).toBe(0)
      return await use(root, artifact, path.join(root, "rust/target/debug/ycoding-runtime"))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })()
}

const receiptKeys = ["binary", "catalog", "channel", "command", "lock_sha256", "profile", "schema", "source", "target", "toolchain", "version"]

test.each(["linux", "darwin"] as const)("a %s receipt round-trips and installs the exact executable bytes", (host) =>
  prepared(host, async (root, artifact, destination) => {
    expect((await fs.readdir(artifact)).sort()).toEqual(["receipt.json", "ycoding-runtime"])
    const receipt = await Bun.file(path.join(artifact, "receipt.json")).json()
    expect(Object.keys(receipt).sort()).toEqual(receiptKeys)
    expect(receipt).toMatchObject({
      schema: "ycoding.debug-runtime.receipt/1",
      source: { commit },
      version: "0.11.0-beta.2",
      channel: "beta",
      target: host === "darwin" ? "darwin-arm64" : "linux-x64",
      profile: "dev",
      command: "cargo build --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --bin ycoding-runtime",
      catalog: { bundled_models_path: null },
      binary: { name: "ycoding-runtime", bytes: (await fs.stat(path.join(root, "built/ycoding-runtime"))).size },
    })
    expect(receipt.toolchain.environment).toMatchObject({ CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0", RUSTFLAGS: null, CC: null })
    expect(receipt.toolchain.compilers).toEqual(
      host === "darwin"
        ? { sdk: "26.0", sdk_build: "25A100", cc: "Apple clang 17.0", cxx: "Apple clang++ 17.0" }
        : { cc: "cc (synthetic) 17.0", cxx: "c++ (synthetic) 17.0" },
    )
    expect(receipt.toolchain.image).toEqual({ os: host === "darwin" ? "macos26" : "ubuntu24", version: "20261013.1" })
    expect(receipt.toolchain.protoc).toBe("libprotoc 36.2")
    expect(JSON.stringify(receipt)).not.toContain(root)
    const verified = run(root, ["verify", artifact, destination], environment(root, host))
    expect(verified.code, verified.stderr).toBe(0)
    expect(verified.stdout.trim()).toBe(destination)
    expect((await fs.stat(destination)).mode & 0o111).toBe(0o111)
    expect(await Bun.file(destination).text()).toBe(await Bun.file(path.join(root, "built/ycoding-runtime")).text())
    expect(verified.stderr).toContain(`verified debug runtime target=${receipt.target} bytes=${receipt.binary.bytes} sha256=${receipt.binary.sha256}`)
  }),
)

test("the receipt records a bundled model catalog by content digest only", () =>
  prepared("linux", async (root) => {
    const catalog = path.join(root, "private-catalog/models.json")
    await Bun.write(catalog, '{"bundled":true}\n')
    const artifact = path.join(root, "bundled-artifact")
    const env = environment(root, "linux", { YCODING_BUNDLED_MODELS_PATH: catalog })
    expect(run(root, ["write", "built/ycoding-runtime", artifact], env).code).toBe(0)
    const text = await Bun.file(path.join(artifact, "receipt.json")).text()
    expect(JSON.parse(text).catalog.bundled_models_path.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(text).not.toContain("private-catalog")
    expect(run(root, ["verify", artifact, path.join(root, "out/ycoding-runtime")], env).code).toBe(0)
    const unset = run(root, ["verify", artifact, path.join(root, "unset/ycoding-runtime")], environment(root, "linux"))
    expect(unset.code).not.toBe(0)
    expect(unset.stderr).toContain("receipt fields differ")
  }),
)

test("a Windows release receipt binds the MSVC host and exact exe bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-windows-receipt-"))
  try {
    await fixture(root)
    const binary = path.join(root, "built/ycoding-runtime.exe")
    await Bun.write(binary, new Uint8Array([77, 90, 1, 2, 3, 4]))
    await fs.chmod(binary, 0o755)
    await Bun.write(path.join(root, "shims/rustc"), '#!/bin/sh\nprintf "rustc 1.98.1\\r\\nhost: x86_64-pc-windows-msvc\\r\\n"\n')
    const checksum = path.join(root, "shims/sha256sum")
    await Bun.write(
      checksum,
      '#!/bin/sh\nset -e\nif [ "$1" = -b ]; then shift; fi\nif [ "$#" -eq 0 ]; then exec shasum -a 256 -b; fi\nresult=$(shasum -a 256 -b <"$1")\nprintf "\\\\%s *C:\\\\\\\\build\\\\\\\\binary\\n" "${result%% *}"\n',
    )
    await fs.chmod(checksum, 0o755)
    const artifact = path.join(root, "receipt")
    const dest = path.join(root, "verified/ycoding-runtime.exe")
    const env = environment(root, "linux", { SHIM_OS: "MINGW64_NT-10.0-26100", RECEIPT_TARGET: "windows-x64", RECEIPT_PROFILE: "release",
      ImageOS: "win25", YCODING_BUNDLED_MODELS_PATH: path.join(root, "packages/cli/script/models-dev.snapshot.json") })
    const written = run(root, ["write", binary, artifact], env)
    expect(written.code, written.stderr).toBe(0)
    expect((await fs.readdir(artifact)).sort()).toEqual(["receipt.json", "ycoding-runtime.exe"])
    const receipt = await Bun.file(path.join(artifact, "receipt.json")).json()
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(binary).bytes()).digest("hex")
    expect(receipt).toMatchObject({
      schema: "ycoding.release-runtime.receipt/1", source: { commit }, target: "windows-x64", profile: "release",
      binary: { name: "ycoding-runtime.exe", bytes: 6, sha256: digest },
      command: "cargo build --message-format=json-render-diagnostics --timings --locked --manifest-path rust/Cargo.toml --release -p ycoding-runtime --bin ycoding-runtime",
      toolchain: { rustc: "rustc 1.98.1\nhost: x86_64-pc-windows-msvc", compilers: { msvc: "14.44.35207" }, image: { os: "win25" } },
    })
    expect(receipt.catalog.bundled_models_path.sha256).toMatch(/^[0-9a-f]{64}$/)
    const checked = run(root, ["verify", artifact, dest], env)
    expect(checked.code, checked.stderr).toBe(0)
    expect(await Bun.file(dest).bytes()).toEqual(await Bun.file(binary).bytes())
    await Bun.write(path.join(artifact, "ycoding-runtime.exe"), new Uint8Array([77, 90, 4, 3, 2, 1]))
    const rejected = run(root, ["verify", artifact, dest], env)
    expect(rejected.code).not.toBe(0)
    expect(rejected.stderr).toContain("binary does not match")
    expect(await Bun.file(dest).bytes()).toEqual(await Bun.file(binary).bytes())
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each(["workflow_dispatch", "push"] as const)("both Apple Silicon release packagers verify the local producer receipt and inputs without Cargo on %s", async (event) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-darwin-release-receipt-"))
  try {
    await fixture(root)
    for (const [name, source] of Object.entries({
      git: [
        "#!/bin/sh",
        'case "$*" in',
        `  'rev-parse HEAD') printf '%s\\n' "\${SHIM_CHECKOUT_SHA:-${commit}}" ;;`,
        `  "rev-parse --verify $GITHUB_REF^{commit}") printf '%s\\n' "\${SHIM_TAG_SHA:-${commit}}" ;;`,
        '  "merge-base --is-ancestor $GITHUB_SHA refs/remotes/origin/main") test "${SHIM_ON_MAIN:-true}" = true ;;',
        '  "check-ref-format $GITHUB_REF") exec /usr/bin/git "$@" ;;',
        '  *) exit 64 ;;',
        'esac',
      ].join("\n"),
      bun: `#!/bin/sh\nprintf '%s\\n80\\n' "\${SHIM_RECIPE}"\n`,
    })) {
      const file = path.join(root, "shims", name)
      await Bun.write(file, source)
      await fs.chmod(file, 0o755)
    }
    const staged = path.join(root, "runner-temp/release-runtime")
    const destination = path.join(root, "tui/ycoding-runtime")
    const binary = path.join(root, "built/ycoding-runtime")
    const version = event === "push" ? "0.13.5" : "0.11.0-beta.2"
    const channel = event === "push" ? "latest" : "beta"
    const ref = event === "push" ? `refs/tags/v${version}` : "refs/heads/main"
    const workflow = `example/ycoding/.github/workflows/release.yml@${ref}`
    await Bun.write(path.join(root, `docs/releases/v${version}.md`), "Synthetic release notes\n")
    const env = environment(root, "darwin", {
      RECEIPT_PROFILE: "release",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_SHA: commit,
      GITHUB_REPOSITORY: "example/ycoding",
      GITHUB_WORKFLOW_REF: workflow,
      GITHUB_WORKFLOW_SHA: commit,
      GITHUB_RUN_ID: "90212",
      GITHUB_RUN_ATTEMPT: "1",
      RELEASE_VERSION: version,
      YCODING_CHANNEL: channel,
      SHIM_RECIPE: "1".repeat(64),
      YCODING_BUNDLED_MODELS_PATH: path.join(root, "packages/cli/script/models-dev.snapshot.json"),
    })
    const written = run(root, ["write", binary, staged], env)
    expect(written.code, written.stderr).toBe(0)
    const receiptFile = path.join(staged, "receipt.json")
    const receiptBytes = await Bun.file(receiptFile).bytes()
    const pin = new Bun.CryptoHasher("sha256").update(receiptBytes).digest("hex")
    expect(JSON.parse(new TextDecoder().decode(receiptBytes))).toMatchObject({
      schema: "ycoding.release-runtime.receipt/1", target: "darwin-arm64", source: { commit }, version,
      run: { workflow, id: "90212", attempt: "1" },
    })
    for (const tool of ["cargo", "rustc"]) {
      await Bun.write(path.join(root, "shims", tool), '#!/bin/sh\necho "Unexpected compiler invocation" >&2\nexit 99\n')
    }
    const consumer = { ...env, RECEIPT_SHA256: pin }
    const original = await Bun.file(binary).bytes()
    for (const output of [destination, path.join(root, "desktop/ycoding-runtime")]) {
      const verified = run(root, ["verify", staged, output], consumer)
      expect(verified.code, verified.stderr).toBe(0)
      expect(await Bun.file(output).bytes()).toEqual(original)
      expect(verified.stderr).not.toContain("Unexpected compiler invocation")
    }

    const otherCommit = "f".repeat(40)
    for (const [change, diagnostic] of [
      [{ RECEIPT_SHA256: "" }, "the producer receipt digest is required"],
      [{ RECEIPT_SHA256: "f".repeat(64) }, "the receipt digest does not match the producer"],
      [{ GITHUB_RUN_ID: "90213" }, "receipt run does not match this run"],
      [{ GITHUB_RUN_ATTEMPT: "2" }, "receipt run does not match this run"],
      [{ GITHUB_RUN_ID: "90212\nunexpected" }, "a run ID and attempt are required"],
      [{ GITHUB_REPOSITORY: "another/ycoding" }, "the release workflow is required"],
      [{ GITHUB_WORKFLOW_REF: "example/ycoding/.github/workflows/release.yml@refs/heads/another" }, "the release workflow is required"],
      [{ GITHUB_WORKFLOW_REF: `example/ycoding/.github/workflows/other.yml@${ref}` }, "the release workflow is required"],
      [{ GITHUB_WORKFLOW_SHA: otherCommit }, "the workflow does not match the release commit"],
      [{ GITHUB_SHA: otherCommit, GITHUB_WORKFLOW_SHA: otherCommit }, "the checkout does not match the release commit"],
      [{ GITHUB_SHA: otherCommit, GITHUB_WORKFLOW_SHA: otherCommit, SHIM_CHECKOUT_SHA: otherCommit, SHIM_TAG_SHA: otherCommit }, "receipt source does not match this run"],
      [{ YCODING_CHANNEL: channel === "latest" ? "beta" : "latest" }, "receipt channel does not match this run"],
      [{ RELEASE_VERSION: "0.11.0" }, event === "push" ? "Release version does not match the pushed tag" : "receipt version does not match this run"],
      [{ SHIM_RECIPE: "2".repeat(64) }, "receipt regex_recipe does not match this run"],
    ] as const) {
      const result = run(root, ["verify", staged, destination], { ...consumer, ...change })
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(diagnostic)
      expect(result.stderr).not.toContain("Unexpected compiler invocation")
      expect(await Bun.file(destination).bytes()).toEqual(original)
    }
    if (event === "push") {
      const branch = "refs/heads/main"
      const invalid = "refs/tags/v0.013.5"
      for (const [change, diagnostic] of [
        [{ GITHUB_ACTIONS: "false" }, "requires GitHub Actions"],
        [{ GITHUB_EVENT_NAME: "pull_request" }, "requires a version tag push or manual dispatch"],
        [{ GITHUB_REF: branch, GITHUB_WORKFLOW_REF: `example/ycoding/.github/workflows/release.yml@${branch}` }, "Release version does not match the pushed tag"],
        [{ GITHUB_REF: invalid, GITHUB_WORKFLOW_REF: `example/ycoding/.github/workflows/release.yml@${invalid}`, RELEASE_VERSION: "0.013.5" }, "Invalid release version"],
        [{ SHIM_TAG_SHA: otherCommit }, "tag does not point to the release commit"],
        [{ SHIM_ON_MAIN: "false" }, "Release commit is not reachable from origin/main"],
      ] as const) {
        const rejected = path.join(root, "rejected")
        const reject = run(root, ["write", binary, rejected], { ...env, ...change })
        expect(reject.stderr).toContain(diagnostic)
        expect(reject.code).toBe(1)
        expect(await fs.stat(rejected).then(() => true, () => false)).toBe(false)
        const verify = run(root, ["verify", staged, destination], { ...consumer, ...change })
        expect(verify.stderr).toContain(diagnostic)
        expect(verify.code).toBe(1)
        expect(await Bun.file(destination).bytes()).toEqual(original)
      }
    }
    await Bun.write(receiptFile, `${await Bun.file(receiptFile).text()}\n`)
    const fresh = path.join(root, "unverified/ycoding-runtime")
    const repacked = run(root, ["verify", staged, fresh], consumer)
    expect(repacked.code).not.toBe(0)
    expect(repacked.stderr).toContain("the receipt digest does not match the producer")
    expect(await Bun.file(fresh).exists()).toBe(false)
    await Bun.write(receiptFile, receiptBytes)
    await Bun.write(path.join(staged, "ycoding-runtime"), "tampered executable")
    const corrupted = run(root, ["verify", staged, destination], consumer)
    expect(corrupted.code).not.toBe(0)
    expect(corrupted.stderr).toContain("binary does not match")
    expect(await Bun.file(destination).bytes()).toEqual(original)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 15_000)

test.each([
  ["a non-executable binary", async (root: string) => fs.chmod(path.join(root, "built/ycoding-runtime"), 0o644), {}, "not an executable regular file"],
  ["an abbreviated commit", async () => {}, { GITHUB_SHA: "0123456" }, "full commit SHA"],
  ["a target for another host", async () => {}, { RECEIPT_TARGET: "darwin-arm64" }, "does not match host"],
  ["an unsupported host", async () => {}, { SHIM_ARCH: "aarch64", RECEIPT_TARGET: "linux-x64" }, "unsupported host"],
  ["an unknown channel", async () => {}, { YCODING_CHANNEL: "nightly" }, "beta or latest"],
  ["a failing compiler probe", async (root: string) => Bun.write(path.join(root, "shims/cc"), "#!/bin/sh\nexit 3\n"), {}, ""],
] as const)("writing rejects %s", async (_, mutate, overrides, message) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-write-"))
  try {
    await fixture(root)
    await mutate(root)
    const result = run(root, ["write", "built/ycoding-runtime", path.join(root, "artifact")], environment(root, "linux", overrides))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(message)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

const receipt = (artifact: string) => path.join(artifact, "receipt.json")
const edit = (change: (value: Record<string, unknown>) => void) => async (_: string, artifact: string) => {
  const value = await Bun.file(receipt(artifact)).json()
  change(value)
  await Bun.write(receipt(artifact), JSON.stringify(value))
}

test.each([
  ["a modified binary", async (_: string, artifact: string) => Bun.write(path.join(artifact, "ycoding-runtime"), "#!/bin/sh\necho tampered runtime\n"), {}, "binary does not match"],
  ["an extra artifact file", async (_: string, artifact: string) => Bun.write(path.join(artifact, "extra"), "x"), {}, "exactly receipt.json and ycoding-runtime"],
  ["a missing receipt", async (_: string, artifact: string) => fs.rm(receipt(artifact)), {}, "exactly receipt.json and ycoding-runtime"],
  [
    "a symlinked binary",
    async (root: string, artifact: string) => {
      await fs.rm(path.join(artifact, "ycoding-runtime"))
      await fs.symlink(path.join(root, "built/ycoding-runtime"), path.join(artifact, "ycoding-runtime"))
    },
    {},
    "not a regular file",
  ],
  ["malformed JSON", async (_: string, artifact: string) => Bun.write(receipt(artifact), "{"), {}, "not a JSON object"],
  ["a non-object receipt", async (_: string, artifact: string) => Bun.write(receipt(artifact), "[]"), {}, "not a JSON object"],
  ["an extra field", edit((value) => (value.extra = true)), {}, "receipt fields differ"],
  ["a missing field", edit((value) => delete value.catalog), {}, "receipt fields differ"],
  ["another schema version", edit((value) => (value.schema = "ycoding.debug-runtime.receipt/2")), {}, "receipt schema does not match"],
  ["a changed byte count", edit((value) => ((value.binary as { bytes: number }).bytes = 1)), {}, "receipt binary does not match"],
  ["another source commit", async () => {}, { GITHUB_SHA: "f".repeat(40) }, "receipt source does not match"],
  ["another version", async () => {}, { RELEASE_VERSION: "0.11.0-beta.3" }, "receipt version does not match"],
  ["another channel", async () => {}, { YCODING_CHANNEL: "latest" }, "receipt channel does not match"],
  ["another debug info policy", async () => {}, { CARGO_PROFILE_DEV_DEBUG: "2" }, "receipt toolchain does not match"],
  ["consumer RUSTFLAGS", async () => {}, { RUSTFLAGS: "-Cdebuginfo=2" }, "receipt toolchain does not match"],
  ["another Rust compiler", async () => {}, { SHIM_RUSTC: "1.99.0" }, "receipt toolchain does not match"],
  ["another C compiler", async () => {}, { SHIM_CC: "18.0" }, "receipt toolchain does not match"],
  ["another runner image", async () => {}, { ImageVersion: "20261020.1" }, "receipt toolchain does not match"],
  ["another catalog snapshot", async (root: string) => Bun.write(path.join(root, "packages/cli/script/models-dev.snapshot.json"), "{}\n"), {}, "receipt catalog does not match"],
  ["another lockfile", async (root: string) => Bun.write(path.join(root, "rust/Cargo.lock"), "# other\n"), {}, "receipt lock_sha256 does not match"],
] as const)("verification fails closed on %s without installing", (_, mutate, overrides, message) =>
  prepared("linux", async (root, artifact, destination) => {
    await mutate(root, artifact)
    const result = run(root, ["verify", artifact, destination], environment(root, "linux", overrides))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(message)
    expect(await Bun.file(destination).exists()).toBe(false)
  }),
)

test("verification rejects a darwin SDK change", () =>
  prepared("darwin", async (root, artifact, destination) => {
    const result = run(root, ["verify", artifact, destination], environment(root, "darwin", { SHIM_SDK: "26.1" }))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("receipt toolchain does not match")
  }),
)

test("the identity names the toolchain and build policy without the environment or private paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-identity-"))
  try {
    await fixture(root)
    const result = run(root, ["identity"], environment(root, "linux", { SECRET_TOKEN: "synthetic-secret-value" }))
    expect(result.code, result.stderr).toBe(0)
    const identity = JSON.parse(result.stdout)
    expect(Object.keys(identity).sort()).toEqual(["cargo", "compilers", "environment", "image", "protoc", "rustc", "target"])
    expect(Object.keys(identity.environment).sort()).toEqual(
      ["CARGO_BUILD_RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_INCREMENTAL", "CARGO_PROFILE_DEV_DEBUG", "CARGO_PROFILE_TEST_DEBUG", "CARGO_TARGET_DIR", "CC", "CFLAGS", "CXX", "CXXFLAGS", "RUSTFLAGS", "RUSTUP_TOOLCHAIN"].sort(),
    )
    expect(result.stdout).not.toContain("synthetic-secret-value")
    expect(result.stdout).not.toContain(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
