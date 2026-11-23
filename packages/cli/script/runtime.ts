import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { brotliCompressSync, constants } from "node:zlib"
import { REGEX_PROCESS_MARKER, regexProcessSource } from "../../codemode/src/internal/regex-process"
import { platformBinary } from "../src/binary"
import { modelsSource } from "./generate"
import { metadata } from "./regex-worker-metadata"

const root = path.resolve(import.meta.dirname, "../../..")

function runtimeEnvironment() {
  return { ...process.env, YCODING_BUNDLED_MODELS_PATH: path.resolve(modelsSource) }
}

async function compileRuntime(env: NodeJS.ProcessEnv) {
  const args = ["--manifest-path", path.join(root, "rust/Cargo.toml"), "--no-deps", "--format-version", "1"]
  const cargoMetadata = spawnSync("cargo", ["metadata", "--locked", ...args], { cwd: root, encoding: "utf8", env })
  if (cargoMetadata.error) throw cargoMetadata.error
  if (cargoMetadata.status !== 0) throw new Error(`Rust payload metadata failed (${cargoMetadata.status ?? cargoMetadata.signal})`)
  const workspace = JSON.parse(cargoMetadata.stdout) as { target_directory: string; packages: Array<{ name: string; id: string }> }
  const targetDirectory = workspace.target_directory
  const runtime = workspace.packages.find((item) => item.name === "ycoding-runtime")
  if (!runtime) throw new Error("Cargo metadata omitted the native runtime package")
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--message-format=json-render-diagnostics",
      "--locked",
      "--manifest-path",
      path.join(root, "rust/Cargo.toml"),
      "--release",
      "-p",
      "ycoding-runtime",
      "--bin",
      "ycoding-runtime",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env },
  )
  if (result.error) throw result.error
  const messages = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    reason: string; package_id?: string; out_dir?: string; message?: { rendered?: string }
  })
  for (const message of messages)
    if (message.reason === "compiler-message" && message.message?.rendered) process.stderr.write(message.message.rendered)
  if (result.status !== 0) throw new Error(`Rust payload build failed (${result.status ?? result.signal})`)
  const receipts = messages.filter((message) => message.reason === "build-script-executed" && message.package_id === runtime.id)
  if (receipts.length !== 1 || !receipts[0].out_dir || !path.isAbsolute(receipts[0].out_dir))
    throw new Error("Cargo did not identify the native runtime build-script receipt directory")
  const recipe = metadata()
  if (await readFile(path.join(receipts[0].out_dir, "regex_worker.metadata"), "utf8") !== `${recipe.sha256}\n${recipe.byteLength}\n`)
    throw new Error("Native regex worker metadata does not match the configured producer")
  return path.join(
    targetDirectory,
    "release",
    platformBinary("ycoding-runtime", process.platform),
  )
}

function runtimeReceipt(operation: "write" | "verify", args: string[], target: "darwin-arm64" | "windows-x64", env: NodeJS.ProcessEnv) {
  const receipt = spawnSync("bash", ["script/runtime-receipt.sh", operation, ...args], {
    cwd: root, stdio: "inherit",
    env: { ...env, RECEIPT_PROFILE: "release", RECEIPT_TARGET: target },
  })
  if (receipt.error) throw receipt.error
  if (receipt.status !== 0) throw new Error(
    `${operation === "verify" ? "Verifying the Apple Silicon release runtime" : "Writing the native runtime receipt"} failed (${receipt.status ?? receipt.signal})`,
  )
}

export async function buildRuntime(target: { os: string; arch: string; abi?: string }, receiptDirectory?: string) {
  if (target.os !== process.platform || target.arch !== process.arch || target.abi === "musl")
    throw new Error("Rust payload builds require a matching native host")
  const env = runtimeEnvironment()
  const staged = process.env.YCODING_RELEASE_RUNTIME_DIR
  const name = platformBinary("ycoding-runtime", process.platform)
  const appleSilicon = target.os === "darwin" && target.arch === "arm64"
  if (appleSilicon && staged === undefined && process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    process.env.GITHUB_WORKFLOW_REF?.startsWith(`${process.env.GITHUB_REPOSITORY}/.github/workflows/release.yml@`))
    throw new Error("Apple Silicon release packaging requires the staged runtime")
  if (staged !== undefined) {
    if (!path.isAbsolute(staged) || !appleSilicon || receiptDirectory !== undefined)
      throw new Error("A staged release runtime requires an absolute artifact path and a native Apple Silicon target")
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-verified-runtime-"))
    try {
      const verified = path.join(directory, name)
      runtimeReceipt("verify", [staged, verified], "darwin-arm64", env)
      return await packRuntime(await Bun.file(verified).bytes(), name)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  const executable = await compileRuntime(env)
  const bytes = await Bun.file(executable).bytes()
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (receiptDirectory !== undefined) {
    runtimeReceipt("write", [executable, receiptDirectory], "windows-x64", env)
    const written = await Bun.file(path.join(receiptDirectory, "receipt.json")).json()
    if (written.binary?.sha256 !== sha256 || written.binary?.bytes !== bytes.length)
      throw new Error("The runtime used for embedding does not match the release receipt")
  }
  return packRuntime(bytes, name, sha256)
}

async function packRuntime(bytes: Uint8Array, name: string, sha256 = createHash("sha256").update(bytes).digest("hex")) {
  const payload = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 6,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  })
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-asset-"))
  const asset = path.join(directory, name)
  await writeFile(asset, payload, { mode: 0o600 })
  return {
    path: asset,
    sha256,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

async function verifyEmbedded(frontend: string, receiptFile: string) {
  const receipt = await Bun.file(receiptFile).json()
  if (receipt === null || typeof receipt !== "object" || process.platform !== "win32" || process.arch !== "x64" || path.basename(frontend) !== "ycoding.exe" ||
    receipt.schema !== "ycoding.release-runtime.receipt/1" || receipt.target !== "windows-x64" || receipt.profile !== "release" ||
    !/^[0-9a-f]{40}$/.test(receipt.source?.commit) || receipt.source.commit !== process.env.GITHUB_SHA ||
    typeof receipt.version !== "string" || receipt.version !== process.env.RELEASE_VERSION ||
    (receipt.channel !== "beta" && receipt.channel !== "latest") ||
    receipt.channel !== process.env.YCODING_CHANNEL || receipt.binary?.name !== "ycoding-runtime.exe" ||
    !/^[0-9a-f]{64}$/.test(receipt.binary.sha256) || !Number.isSafeInteger(receipt.binary.bytes) || receipt.binary.bytes <= 0)
    throw new Error("Embedded runtime verification requires a Windows x64 release receipt for this build")
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-verify-embedded-"))
  try {
    const result = Bun.spawnSync([path.resolve(frontend), "-e", regexProcessSource, "--", REGEX_PROCESS_MARKER], {
      cwd: root, env: { ...process.env, XDG_CACHE_HOME: root },
      stdin: Buffer.from(JSON.stringify({ method: "test", pattern: "^native$", flags: "", input: "native", lastIndex: 0 }) + "\n"),
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    })
    if (result.exitCode !== 0 || result.stderr.length)
      throw new Error(`The packaged frontend did not complete the native regex worker request (exit ${result.exitCode})`)
    const frames = result.stdout.toString().trim().split(/\r?\n/)
    if (frames.length !== 2 || JSON.parse(frames[0]).ready !== true) throw new Error("The packaged native regex worker did not report readiness")
    const reply = JSON.parse(frames[1])
    if (reply.result !== true || reply.lastIndex !== 0) throw new Error("The packaged native regex worker returned an unexpected result")
    const extracted = path.join(root, receipt.channel === "beta" ? "ycoding-beta" : "ycoding", "bin", "runtime",
      encodeURIComponent(receipt.version), receipt.binary.sha256, receipt.binary.name)
    const bytes = await readFile(extracted)
    if (bytes.length !== receipt.binary.bytes || createHash("sha256").update(bytes).digest("hex") !== receipt.binary.sha256)
      throw new Error("The executable extracted by the packaged frontend does not match the Rust build receipt")
    console.log(`Verified Windows runtime bytes=${bytes.length} sha256=${receipt.binary.sha256}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [command, frontend, receipt, ...extra] = process.argv.slice(2)
  if (command === "stage-release" && frontend && receipt === undefined) {
    if (process.platform !== "darwin" || process.arch !== "arm64" || !path.isAbsolute(frontend))
      throw new Error("Staging a release runtime requires an absolute output path and a native Apple Silicon host")
    const env = runtimeEnvironment()
    runtimeReceipt("write", [await compileRuntime(env), frontend], "darwin-arm64", env)
  } else if (command === "verify-embedded" && frontend && receipt && !extra.length) {
    await verifyEmbedded(frontend, receipt)
  } else {
    throw new Error("Use stage-release <directory> or verify-embedded <ycoding.exe> <receipt.json>")
  }
}
