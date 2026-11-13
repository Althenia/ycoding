import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildDesktop, fileDigest, fingerprint, freshOutput, parseArguments, type BuildBoundary } from "../script/build-preflight"

type Payload = { manifest?: string; metadata?: string | null; archive?: "corrupt" | "missing" | "outside-root" | "parent-escape"; icon?: "missing" | "outer-only" }
const hash = "synthetic1hash"
const identity = "9dd524184b0db949ffac7f0ada0ae860ac7f5f85"
const requirement = (sha1: string, name = "app.ycoding.desktop", anchor = "leaf") => `Executable=/synthetic/YCoding Desktop.app/Contents/MacOS/launcher\ndesignated => identifier "${name}" and certificate ${anchor} = H"${sha1}"\n`

async function writeStableApp(contents: string, payload: Payload) {
  await fs.mkdir(path.join(contents, "MacOS"), { recursive: true })
  await fs.mkdir(path.join(contents, "Resources"), { recursive: true })
  await fs.writeFile(path.join(contents, "MacOS/launcher"), "synthetic-executable", { mode: 0o755 })
  if (payload.icon !== "missing") await fs.writeFile(path.join(contents, "Resources/AppIcon.icns"), "icns-synthetic-outer")
  const metadata = payload.metadata === undefined ? JSON.stringify({ identifier: "app.ycoding.desktop", name: "YCoding Desktop", channel: "stable", hash }) : payload.metadata
  if (metadata !== null) await fs.writeFile(path.join(contents, "Resources/metadata.json"), metadata)
  if (payload.archive === "missing") return
  const archive = path.join(contents, "Resources", `${hash}.tar.zst`)
  if (payload.archive === "corrupt") { await fs.writeFile(archive, "not-an-archive"); return }
  const stage = path.join(path.dirname(contents), "stage")
  const inner = path.join(stage, "YCoding Desktop.app/Contents")
  await fs.mkdir(path.join(inner, "MacOS"), { recursive: true })
  await fs.mkdir(path.join(inner, "Resources/app/runtime"), { recursive: true })
  await fs.writeFile(path.join(inner, "MacOS/launcher"), "synthetic-inner-executable", { mode: 0o755 })
  await fs.writeFile(path.join(inner, "Resources/app/runtime/backend.json"), payload.manifest ?? "synthetic-manifest")
  if (payload.icon === undefined) await fs.writeFile(path.join(inner, "Resources/AppIcon.icns"), "icns-synthetic-inner")
  const rename = payload.archive === "outside-root" ? ["-s", "|^YCoding Desktop.app|Other.app|"] : payload.archive === "parent-escape" ? ["-s", "|^YCoding Desktop.app|../escaped|"] : []
  execFileSync("/usr/bin/tar", ["--zstd", "-cf", archive, ...rename, "-C", stage, "YCoding Desktop.app"])
  await fs.rm(stage, { recursive: true })
}

async function fixture(payload: Payload = {}) {
  const tasks = path.join(os.homedir(), ".local/share/ycoding/tasks")
  await fs.mkdir(tasks, { recursive: true })
  const root = await fs.mkdtemp(path.join(tasks, "desktop-build-contract-"))
  const desktop = path.join(root, "repo/packages/desktop")
  const output = path.join(root, "output")
  await fs.mkdir(desktop, { recursive: true })
  await fs.writeFile(path.join(root, "repo/bun.lock"), "synthetic-lock")
  const events: string[] = []
  const envs: (Record<string, string> | undefined)[] = []
  const boundary: BuildBoundary = {
    assertSigning: async () => { events.push("signing") },
    assertToolchain: async () => { events.push("toolchain") },
    prepare: async () => {
      events.push("prepare")
      await fs.mkdir(path.join(desktop, "runtime"))
      await fs.writeFile(path.join(desktop, "runtime/backend.json"), "synthetic-manifest")
      return { version: "1.2.3" }
    },
    codesign: async (args) => {
      events.push(`codesign ${args.join(" ")}`)
      return { status: 0, output: args[0] === "-d" ? requirement(identity) : "" }
    },
    run: async (args, env) => {
      events.push(args.join(" "))
      envs.push(env)
      if (args.includes("build:frontend")) { await fs.mkdir(path.join(desktop, "dist")); return 0 }
      await writeStableApp(path.join(desktop, "build/stable-macos-arm64/YCoding Desktop.app/Contents"), payload)
      return 0
    },
  }
  const run = (overrides: Partial<BuildBoundary> = {}, argv = [`--outdir=${output}`]) => buildDesktop({ ...boundary, ...overrides }, { argv, desktop, bun: "/bun", arch: "arm64" })
  return { root, desktop, output, events, envs, run }
}

test("arguments require one fresh output and reject isolated smoke", () => {
  expect(parseArguments(["--outdir=/tmp/result"])).toEqual({ outdir: "/tmp/result", signIdentity: undefined })
  for (const args of [[], ["--outdir="], ["--outdir=/x", "--other"], ["--outdir=/x", "--outdir=/y"]]) expect(() => parseArguments(args)).toThrow()
  expect(() => parseArguments(["--outdir=/x", "--smoke"])).toThrow("persist:default")
})

test("smoke, signing and missing toolchain refusals happen before any output", async () => {
  const f = await fixture()
  try {
    await expect(f.run({}, [`--outdir=${f.output}`, "--smoke"])).rejects.toThrow("persist:default")
    expect(f.events).toEqual([])
    await expect(f.run({ assertSigning: async () => { throw new Error("signing refused") } })).rejects.toThrow("signing refused")
    await expect(f.run({ assertToolchain: async () => { throw new Error("toolchain missing") } })).rejects.toThrow("toolchain missing")
    expect(await fs.stat(f.output).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("existing outputs and overlapping receipt destinations are never modified", async () => {
  for (const name of ["runtime", "dist", "build", "artifacts"]) {
    const f = await fixture()
    try {
      await fs.mkdir(path.join(f.desktop, name))
      await fs.writeFile(path.join(f.desktop, name, "keep"), "original")
      await expect(f.run()).rejects.toThrow("already exists")
      expect(await fs.readFile(path.join(f.desktop, name, "keep"), "utf8")).toBe("original")
      expect(f.events).toEqual(["signing", "toolchain"])
    } finally { await fs.rm(f.root, { recursive: true, force: true }) }
  }
  const f = await fixture()
  try {
    await expect(freshOutput(path.join(f.desktop, "new"), [path.join(f.root, "repo")])).rejects.toThrow("overlap")
    await fs.mkdir(f.output)
    await expect(f.run()).rejects.toThrow("already exists")
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("standalone build copies the verified app and writes a digest-bound receipt", async () => {
  const f = await fixture()
  try {
    const receipt = await f.run()
    expect(f.events).toEqual(["signing", "toolchain", "prepare", "/bun run build:frontend", "/bun run electrobun build --env=stable"])
    expect(receipt.version).toBe("1.2.3")
    expect(receipt.executable.sha256).toBe(await fileDigest(receipt.executable.path))
    expect(receipt.manifest.sha256).toBe(createHash("sha256").update("synthetic-manifest").digest("hex"))
    expect(await fs.readFile(path.join(receipt.validation, "YCoding Desktop.app/Contents/Resources/app/runtime/backend.json"), "utf8")).toBe("synthetic-manifest")
    expect((await fs.readdir(path.join(receipt.application, "Contents/Resources"))).sort()).toEqual(["AppIcon.icns", "metadata.json", `${hash}.tar.zst`])
    expect(await fs.readFile(receipt.executable.path, "utf8")).toBe("synthetic-executable")
    expect(receipt.bundle.sha256).toBe((await fingerprint(receipt.application)).digest)
    expect(receipt.lock.sha256).toBe(await fileDigest(path.join(f.root, "repo/bun.lock")))
    expect(JSON.parse(await fs.readFile(path.join(f.output, "build-receipt.json"), "utf8"))).toEqual(receipt)
    expect(await fs.stat(path.join(f.desktop, ".ycoding-desktop-build.lock")).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("desktop result destination is not passed to the backend producer", async () => {
  const f = await fixture()
  try {
    const receipt = await f.run({ prepare: async (...args: unknown[]) => {
      expect(args).toEqual([])
      await fs.mkdir(path.join(f.desktop, "runtime"))
      await fs.writeFile(path.join(f.desktop, "runtime/backend.json"), "synthetic-manifest")
      return { version: "1.2.3" }
    } })
    expect(receipt.application).toBe(path.join(f.output, "YCoding Desktop.app"))
    expect(JSON.parse(await fs.readFile(path.join(f.output, "build-receipt.json"), "utf8"))).toEqual(receipt)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("a failed command writes no receipt and releases only its own lock", async () => {
  const f = await fixture()
  try {
    await expect(f.run({ run: async () => 1 })).rejects.toThrow("frontend build failed")
    expect(await fs.stat(path.join(f.output, "build-receipt.json")).then(() => true, () => false)).toBe(false)
    expect(await fs.stat(path.join(f.desktop, ".ycoding-desktop-build.lock")).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("a failed backend producer writes no receipt and releases its lock", async () => {
  const f = await fixture()
  try {
    await expect(f.run({ prepare: async () => { throw new Error("producer failed") } })).rejects.toThrow("producer failed")
    expect(await fs.stat(path.join(f.output, "build-receipt.json")).then(() => true, () => false)).toBe(false)
    expect(await fs.stat(path.join(f.desktop, ".ycoding-desktop-build.lock")).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("an existing lock and a changed runtime manifest stop the build without a receipt", async () => {
  const locked = await fixture()
  try {
    const lock = path.join(locked.desktop, ".ycoding-desktop-build.lock")
    await fs.writeFile(lock, "another-owner")
    await expect(locked.run()).rejects.toThrow()
    expect(await fs.readFile(lock, "utf8")).toBe("another-owner")
    expect(locked.events).toEqual(["signing", "toolchain"])
  } finally { await fs.rm(locked.root, { recursive: true, force: true }) }

  const changed = await fixture()
  try {
    let calls = 0
    await expect(changed.run({ run: async () => {
      calls++
      if (calls === 2) await fs.writeFile(path.join(changed.desktop, "runtime/backend.json"), "changed")
      return 0
    } })).rejects.toThrow("manifest changed")
    expect(await fs.stat(path.join(changed.output, "build-receipt.json")).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(changed.root, { recursive: true, force: true }) }
})

test("lockfile changes during a failed command are reported without restoration", async () => {
  const f = await fixture()
  const lockfile = path.join(f.root, "repo/bun.lock")
  try {
    await expect(f.run({ run: async () => { await fs.writeFile(lockfile, "changed"); return 1 } })).rejects.toThrow("bun.lock changed")
    expect(await fs.readFile(lockfile, "utf8")).toBe("changed")
    expect(await fs.stat(path.join(f.output, "build-receipt.json")).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("a stable bundle with a missing, corrupt, mismatched or unsafe payload fails closed without a receipt", async () => {
  const cases: [Payload, string][] = [
    [{ archive: "missing" }, "payload"],
    [{ archive: "corrupt" }, "payload"],
    [{ metadata: null }, "metadata"],
    [{ metadata: "{" }, "metadata"],
    [{ metadata: JSON.stringify({ channel: "canary", hash }) }, "metadata"],
    [{ metadata: JSON.stringify({ channel: "stable", hash: "../x" }) }, "metadata"],
    [{ manifest: "other-manifest" }, "differs"],
    [{ archive: "outside-root" }, "unsafe"],
    [{ archive: "parent-escape" }, "unsafe"],
  ]
  for (const [payload, message] of cases) {
    const f = await fixture(payload)
    try {
      await expect(f.run()).rejects.toThrow(message)
      expect(await fs.stat(path.join(f.output, "build-receipt.json")).then(() => true, () => false)).toBe(false)
      expect(await fs.stat(path.join(f.root, "escaped")).then(() => true, () => false)).toBe(false)
      expect(await fs.stat(path.join(f.desktop, ".ycoding-desktop-build.lock")).then(() => true, () => false)).toBe(false)
      expect(await fs.readFile(path.join(f.root, "repo/bun.lock"), "utf8")).toBe("synthetic-lock")
    } finally { await fs.rm(f.root, { recursive: true, force: true }) }
  }
})

test("a bundle without its app icon is refused", async () => {
  for (const icon of ["missing", "outer-only"] as const) {
    const f = await fixture({ icon })
    try { await expect(f.run()).rejects.toThrow("AppIcon.icns") }
    finally { await fs.rm(f.root, { recursive: true, force: true }) }
  }
})

test("the real iconset ships every required entry at its exact pixel size", async () => {
  const config = await fs.readFile(path.join(import.meta.dir, "../electrobun.config.ts"), "utf8")
  expect(config).toContain('icons: "icon.iconset"')
  const expected: [string, number][] = [["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64], ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512], ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024]]
  for (const [name, size] of expected) {
    const bytes = await fs.readFile(path.join(import.meta.dir, "../icon.iconset", name))
    expect(bytes.subarray(1, 4).toString()).toBe("PNG")
    expect(bytes.readUInt32BE(16)).toBe(size)
    expect(bytes.readUInt32BE(20)).toBe(size)
  }
})

const signedArgv = (output: string) => [`--outdir=${output}`, `--sign-identity=${identity}`]

test("arguments accept an optional 40-hex signing identity in either order and reject malformed, empty or duplicate values", () => {
  expect(parseArguments(["--outdir=/x", `--sign-identity=${identity}`])).toEqual({ outdir: "/x", signIdentity: identity })
  expect(parseArguments([`--sign-identity=${identity}`, "--outdir=/x"])).toEqual({ outdir: "/x", signIdentity: identity })
  expect(parseArguments(["--outdir=/x", `--sign-identity=${identity.toUpperCase()}`])).toEqual({ outdir: "/x", signIdentity: identity.toUpperCase() })
  expect(parseArguments(["--outdir=/x"]).signIdentity).toBeUndefined()
  for (const value of ["", "YCoding Code Signing", identity.slice(1), identity + "0", "z".repeat(40), ` ${identity}`, `${identity}\n`])
    expect(() => parseArguments(["--outdir=/x", `--sign-identity=${value}`])).toThrow()
  expect(() => parseArguments(["--outdir=/x", `--sign-identity=${identity}`, `--sign-identity=${identity}`])).toThrow()
  expect(() => parseArguments([`--sign-identity=${identity}`])).toThrow()
  expect(() => parseArguments(["--outdir=/x", `--sign-identity=${identity}`, "--outdir=/y"])).toThrow()
})

test("a signed build passes the identity only to the Electrobun build", async () => {
  const f = await fixture()
  try {
    await f.run({}, signedArgv(f.output))
    expect(f.envs).toEqual([undefined, { ELECTROBUN_DEVELOPER_ID: identity }])
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("an unsigned build passes no environment to any command and never runs codesign", async () => {
  const f = await fixture()
  try {
    const receipt = await f.run()
    expect(f.envs).toEqual([undefined, undefined])
    expect(f.events.some((event) => event.startsWith("codesign"))).toBe(false)
    expect(receipt.signing).toBeNull()
    expect(JSON.parse(await fs.readFile(path.join(f.output, "build-receipt.json"), "utf8")).signing).toBeNull()
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("a signed build verifies and pins the designated requirement of the outer and extracted apps and records the identity", async () => {
  const f = await fixture()
  try {
    const receipt = await f.run({}, signedArgv(f.output))
    const outer = path.join(f.output, "YCoding Desktop.app")
    const inner = path.join(f.output, "validation/YCoding Desktop.app")
    expect(f.events.filter((event) => event.startsWith("codesign"))).toEqual([
      `codesign --verify --deep --strict ${outer}`, `codesign -d -r- ${outer}`,
      `codesign --verify --deep --strict ${inner}`, `codesign -d -r- ${inner}`,
    ])
    expect(receipt.signing).toEqual({ sha1: identity })
    expect(JSON.parse(await fs.readFile(path.join(f.output, "build-receipt.json"), "utf8")).signing).toEqual({ sha1: identity })
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("a signed build accepts an uppercase identity, a root anchor and the codesign lowercase hash", async () => {
  const f = await fixture()
  try {
    const receipt = await f.run({ codesign: async (args) => ({ status: 0, output: args[0] === "-d" ? requirement(identity, "app.ycoding.desktop", "root") : "" }) }, [`--outdir=${f.output}`, `--sign-identity=${identity.toUpperCase()}`])
    expect(receipt.signing).toEqual({ sha1: identity })
    expect(f.envs[1]).toEqual({ ELECTROBUN_DEVELOPER_ID: identity.toUpperCase() })
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("a failed signature check, wrong certificate, wrong identifier or missing requirement writes no receipt", async () => {
  const other = "0".repeat(40)
  const cases: [string, (args: readonly string[], index: number) => { status: number; output: string }][] = [
    ["verification of the outer app", (args, index) => ({ status: index === 0 ? 1 : 0, output: args[0] === "-d" ? requirement(identity) : "" })],
    ["verification of the extracted app", (args, index) => ({ status: index === 2 ? 1 : 0, output: args[0] === "-d" ? requirement(identity) : "" })],
    ["a wrong certificate on the outer app", (args, index) => ({ status: 0, output: args[0] === "-d" ? requirement(index === 1 ? other : identity) : "" })],
    ["a wrong certificate on the extracted app", (args, index) => ({ status: 0, output: args[0] === "-d" ? requirement(index === 3 ? other : identity) : "" })],
    ["a wrong identifier", (args) => ({ status: 0, output: args[0] === "-d" ? requirement(identity, "app.example.other") : "" })],
    ["a failed requirement read", (args) => ({ status: args[0] === "-d" ? 1 : 0, output: requirement(identity) })],
    ["an ad hoc requirement", (args) => ({ status: 0, output: args[0] === "-d" ? 'designated => cdhash H"1593f00c9269224608bcfc16986b4c7b1b09a2d5"\n' : "" })],
    ["an unanchored identifier", (args) => ({ status: 0, output: args[0] === "-d" ? 'designated => identifier "app.ycoding.desktop"\n' : "" })],
    ["no requirement output", () => ({ status: 0, output: "" })],
  ]
  for (const [name, respond] of cases) {
    const f = await fixture()
    try {
      let index = 0
      await expect(f.run({ codesign: async (args) => respond(args, index++) }, signedArgv(f.output)), name).rejects.toThrow("signature")
      expect(await fs.stat(path.join(f.output, "build-receipt.json")).then(() => true, () => false), name).toBe(false)
      expect(await fs.stat(path.join(f.desktop, ".ycoding-desktop-build.lock")).then(() => true, () => false), name).toBe(false)
    } finally { await fs.rm(f.root, { recursive: true, force: true }) }
  }
})
