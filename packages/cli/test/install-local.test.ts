import { expect, spyOn, test } from "bun:test"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { COMPUTER_HELPER_APPLICATION, COMPUTER_HELPER_BINARY } from "../script/computer-use"
import { computerHelperSigningNotice, installLocalBuild, signingNotice } from "../script/install-local"

const fs = await import("node:fs/promises")

async function build(root: string, label: string, platform: NodeJS.Platform) {
  const source = path.join(root, `source-${label}`)
  await mkdir(path.join(source, BrowserExtension.directory), { recursive: true })
  await writeFile(path.join(source, "ycoding"), `binary-${label}`, { mode: 0o755 })
  await writeFile(path.join(source, BrowserExtension.directory, "manifest.json"), `manifest-${label}`)
  if (platform === "darwin") {
    const executable = path.join(source, COMPUTER_HELPER_APPLICATION, "Contents", "MacOS")
    await mkdir(executable, { recursive: true })
    await writeFile(
      path.join(source, COMPUTER_HELPER_APPLICATION, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>helper</string><key>CFBundleIdentifier</key><string>test.ycoding.helper</string></dict></plist>`,
    )
    await Bun.write(path.join(executable, "helper"), Bun.file("/usr/bin/true"))
    const signed = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", path.join(source, COMPUTER_HELPER_APPLICATION)])
    if (signed.exitCode !== 0) throw new Error(signed.stderr.toString())
  }
  return source
}

test("installs the executable and Chrome extension together and replaces a previous install", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "first", "linux"), destination, platform: "linux" })
    const running = await stat(path.join(destination, "ycoding"))
    await writeFile(path.join(destination, BrowserExtension.directory, "stale.js"), "stale")

    await installLocalBuild({ source: await build(root, "second", "linux"), destination, platform: "linux" })

    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-second")
    // A simulated Linux build still uses the host filesystem; Windows has no POSIX executable bits.
    if (process.platform !== "win32") expect((await stat(path.join(destination, "ycoding"))).mode & 0o111).not.toBe(0)
    expect((await stat(path.join(destination, "ycoding"))).ino).not.toBe(running.ino)
    expect(await readdir(path.join(destination, BrowserExtension.directory))).toEqual(["manifest.json"])
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe(
      "manifest-second",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects Windows installation without changing existing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "first", "linux"), destination, platform: "linux" })
    const executable = path.join(destination, "ycoding")
    const before = await stat(executable)
    const source = await build(root, "second", "linux")

    const result = await installLocalBuild({ source, destination, platform: "win32" }).then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error.message : undefined,
    )
    expect(result).toBe("install:local supports macOS and Linux")

    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(executable, "utf8")).toBe("binary-first")
    expect((await stat(executable)).ino).toBe(before.ino)
    expect(await readdir(path.join(destination, BrowserExtension.directory))).toEqual(["manifest.json"])
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe(
      "manifest-first",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("leaves the previous install untouched when the build is incomplete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "first", "linux"), destination, platform: "linux" })
    const incomplete = await build(root, "second", "linux")
    await rm(path.join(incomplete, BrowserExtension.directory), { recursive: true })

    await expect(installLocalBuild({ source: incomplete, destination, platform: "linux" })).rejects.toThrow(
      "bun run build:tui",
    )

    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-first")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "darwin")("installs the signed computer helper app beside the executable on macOS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "mac", "darwin"), destination, platform: "darwin" })
    expect((await readdir(destination)).sort()).toEqual(
      ["ycoding", COMPUTER_HELPER_APPLICATION, BrowserExtension.directory].sort(),
    )
    const verified = Bun.spawnSync([
      "/usr/bin/codesign",
      "--verify",
      "--deep",
      "--strict",
      path.join(destination, COMPUTER_HELPER_APPLICATION),
    ])
    expect(verified.exitCode).toBe(0)

    const tampered = await build(root, "tampered", "darwin")
    await Bun.write(path.join(tampered, COMPUTER_HELPER_APPLICATION, "Contents", "MacOS", "helper"), "altered")
    await expect(installLocalBuild({ source: tampered, destination, platform: "darwin" })).rejects.toThrow(
      "signature verification failed",
    )
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-mac")
    expect((await readdir(destination)).sort()).toEqual(
      ["ycoding", COMPUTER_HELPER_APPLICATION, BrowserExtension.directory].sort(),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("describes an ad-hoc signature as a per-build requirement that needs new authorization", () => {
  const notice = signingNotice("Identifier=app.ycoding.computer-use\nSignature=adhoc\nTeamIdentifier=not set\n")
  expect(notice).toContain("ad-hoc signed")
  expect(notice).toContain("remove old YCoding Computer Use entries in Privacy & Security")
  expect(notice).not.toContain("signed by")
})

async function installedHelper(destination: string) {
  const application = path.join(destination, COMPUTER_HELPER_APPLICATION)
  await mkdir(path.join(application, "Contents", "MacOS"), { recursive: true })
  await mkdir(path.join(application, "Contents", "Resources"), { recursive: true })
  await writeFile(path.join(application, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${COMPUTER_HELPER_BINARY}</string><key>CFBundleIdentifier</key><string>test.ycoding.retained</string><key>CFBundleDisplayName</key><string>YCoding Computer Use</string><key>CFBundleIconFile</key><string>YCoding.icns</string></dict></plist>`,
  )
  await writeFile(path.join(application, "Contents", "Resources", "YCoding.icns"), "synthetic-icon")
  const executable = path.join(application, "Contents", "MacOS", COMPUTER_HELPER_BINARY)
  await Bun.write(executable, Bun.file("/usr/bin/true"))
  await fs.chmod(executable, 0o755)
  const signed = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", application])
  if (signed.exitCode !== 0) throw new Error(signed.stderr.toString())
  return { application, executable }
}

async function snapshot(directory: string): Promise<unknown[]> {
  const metadata = await fs.lstat(directory)
  const row = { path: directory, ino: metadata.ino, mode: metadata.mode, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs }
  if (!metadata.isDirectory()) return [{ ...row, sha256: Bun.CryptoHasher.hash("sha256", await readFile(directory), "hex") }]
  return [row, ...(await Promise.all((await readdir(directory)).sort().map((entry) => snapshot(path.join(directory, entry))))).flat()]
}

function helperService(executable: string, version = 1) {
  const spawn = Bun.spawn
  return spyOn(Bun, "spawn").mockImplementation(<
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(
    command: string[] | (Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }),
    options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
  ) => {
    const args = Array.isArray(command) ? command : command.cmd
    const settings = Array.isArray(command) ? options : command
    if (args[0] !== executable) return spawn(args, settings)
    const launch = args[1]
    const service = `
      import { createServer } from "node:net";
      const launch = await Bun.file(process.argv[1]).json();
      const server = createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
            const size = buffer.readUInt32LE(0);
            const command = JSON.parse(buffer.subarray(4, size + 4).toString());
            buffer = buffer.subarray(size + 4);
            const result = command.method === "ping" ? { serverApiVersion: ${version} } : command.method === "request" ? { status: "error", code: "invalid_request", outcome: "not_started" } : {};
            const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: command.id, result }));
            const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
            socket.write(Buffer.concat([header, body]));
            if (command.method === "shutdown") socket.end(() => server.close());
          }
        });
      });
      server.listen(launch.controlDirectory + "/computer-use.sock");
    `
    return spawn([process.execPath, "-e", service, String(launch)], settings)
  })
}

test.skipIf(process.platform !== "darwin")("retains the installed helper exactly while replacing only the CLI and required extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yc-retain-"))
  try {
    const destination = path.join(root, "bin")
    const helper = await installedHelper(destination)
    await writeFile(path.join(destination, "unrelated"), "preserved")
    const before = await snapshot(helper.application)
    const source = await build(root, "next", "linux")
    const service = helperService(helper.executable)
    const copied = spyOn(fs, "cp")
    const renamed = spyOn(fs, "rename")
    const removed = spyOn(fs, "rm")
    try {
      const installed = await installLocalBuild({ source, destination, platform: "darwin", preserveComputerHelper: true })
      expect(installed).toEqual([path.join(destination, "ycoding"), path.join(destination, BrowserExtension.directory)])
      expect(service).toHaveBeenCalledTimes(1)
      expect(copied.mock.calls.map(([from]) => from)).toEqual([path.join(source, "ycoding"), path.join(source, BrowserExtension.directory)])
      expect(renamed.mock.calls.flat().every((value) => !String(value).includes(COMPUTER_HELPER_APPLICATION))).toBe(true)
      expect(removed.mock.calls.every(([file]) => !String(file).includes(COMPUTER_HELPER_APPLICATION))).toBe(true)
    } finally { copied.mockRestore(); renamed.mockRestore(); removed.mockRestore(); service.mockRestore() }
    expect(await snapshot(helper.application)).toEqual(before)
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-next")
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe("manifest-next")
    expect(await readFile(path.join(destination, "unrelated"), "utf8")).toBe("preserved")
    expect((await readdir(destination)).sort()).toEqual([COMPUTER_HELPER_APPLICATION, BrowserExtension.directory, "unrelated", "ycoding"].sort())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== "darwin")("retained helper validation rejects missing, invalid and incompatible helpers before destination changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yc-retain-"))
  try {
    for (const kind of ["missing", "invalid", "incompatible"] as const) {
      const destination = path.join(root, kind)
      await mkdir(destination)
      await writeFile(path.join(destination, "ycoding"), "previous")
      const helper = kind === "missing" ? undefined : await installedHelper(destination)
      if (kind === "invalid") await writeFile(helper!.executable, "tampered")
      const before = await snapshot(destination)
      const source = await build(root, kind, "linux")
      const service = helper ? helperService(helper.executable, 2) : undefined
      try {
        await expect(installLocalBuild({ source, destination, platform: "darwin", preserveComputerHelper: true })).rejects.toThrow(
          kind === "missing" ? "Computer helper application missing" : kind === "invalid" ? "/usr/bin/codesign exited with 1" : "invalid smoke response",
        )
        if (kind === "invalid") expect(service).not.toHaveBeenCalled()
      } finally { service?.mockRestore() }
      expect(await snapshot(destination)).toEqual(before)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== "darwin")("retained helper install rollback restores both changed components without touching the helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yc-retain-"))
  try {
    const destination = path.join(root, "bin")
    const helper = await installedHelper(destination)
    await writeFile(path.join(destination, "ycoding"), "previous-cli")
    await mkdir(path.join(destination, BrowserExtension.directory))
    await writeFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "previous-extension")
    const before = await snapshot(helper.application)
    const source = await build(root, "rollback", "linux")
    const service = helperService(helper.executable)
    const rename = fs.rename
    const failed = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".install-") && !String(from).endsWith(".previous") && String(to) === path.join(destination, BrowserExtension.directory))
        throw new Error("synthetic extension commit failure")
      return rename(from, to)
    })
    try {
      await expect(installLocalBuild({ source, destination, platform: "darwin", preserveComputerHelper: true })).rejects.toThrow("synthetic extension commit failure")
    } finally { failed.mockRestore(); service.mockRestore() }
    expect(await snapshot(helper.application)).toEqual(before)
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("previous-cli")
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe("previous-extension")
    expect((await readdir(destination)).sort()).toEqual([COMPUTER_HELPER_APPLICATION, BrowserExtension.directory, "ycoding"].sort())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("retaining the helper is rejected outside macOS without creating the destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yc-retain-"))
  try {
    const destination = path.join(root, "bin")
    await expect(installLocalBuild({ source: await build(root, "linux", "linux"), destination, platform: "linux", preserveComputerHelper: true })).rejects.toThrow("requires macOS")
    expect(await Bun.file(path.join(destination, "ycoding")).exists()).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("names the signing certificate without promising that existing grants survive", () => {
  const notice = signingNotice("Identifier=app.ycoding.computer-use\nAuthority=YCoding Code Signing\nTeamIdentifier=not set\n")
  expect(notice).toContain("signed by YCoding Code Signing")
  expect(notice).toContain("macOS decides whether existing YCoding Computer Use grants")
  expect(notice).not.toContain("ad-hoc")
  expect(notice).not.toContain("remove old")
})

test.skipIf(process.platform !== "darwin")("reports the signature of the installed app rather than the environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "mac", "darwin"), destination, platform: "darwin" })
    const previous = process.env.YCODING_MACOS_SIGNING_IDENTITY
    process.env.YCODING_MACOS_SIGNING_IDENTITY = "Identity Absent From The Keychain"
    try {
      expect(computerHelperSigningNotice(path.join(destination, COMPUTER_HELPER_APPLICATION))).toContain("ad-hoc signed")
    } finally {
      if (previous === undefined) delete process.env.YCODING_MACOS_SIGNING_IDENTITY
      else process.env.YCODING_MACOS_SIGNING_IDENTITY = previous
    }
    expect(() => computerHelperSigningNotice(path.join(root, "missing.app"))).toThrow("Failed to read the signature")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
