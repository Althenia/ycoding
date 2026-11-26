import { expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { copyCommand, materializeClipboardImage, readMacOSClipboard, writeMacOSClipboard } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

test.skipIf(process.platform !== "darwin")("copies large Unicode exports to the macOS clipboard via stdin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-native-copy-"))
  const target = path.join(root, "pasteboard")
  const sample = 'Résumé "ready" \\ path\n👋\n'
  try {
    const file = path.join(root, "osascript")
    await Bun.write(file, '#!/bin/sh\n/bin/cat > "$YCODING_TEST_PASTEBOARD"\n')
    await chmod(file, 0o700)
    const child = Bun.spawn([process.execPath, "-e", `
      import { write } from ${JSON.stringify(path.join(import.meta.dir, "../src/clipboard.ts"))};
      await write(${JSON.stringify(sample)}.repeat(50_000));
    `], { env: { ...process.env, PATH: root, YCODING_TEST_PASTEBOARD: target }, stderr: "pipe", stdout: "ignore" })
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    expect(await Bun.file(target).exists()).toBe(true)
    const bytes = await Bun.file(target).bytes()
    expect(bytes.length).toBe(Buffer.byteLength(sample) * 50_000)
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
      .toBe(new Bun.CryptoHasher("sha256").update(sample.repeat(50_000)).digest("hex"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "darwin")("writes OSC 52 with the active terminal's control envelope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-osc52-"))
  try {
    const helper = path.join(root, "osascript")
    await Bun.write(helper, "#!/bin/sh\n/bin/cat >/dev/null\n")
    await chmod(helper, 0o700)
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: root }
    delete env.TMUX
    delete env.STY
    const osc = "\x1b]52;c;Y2xpcA==\x07"
    for (const [multiplexer, expected] of [
      [undefined, osc],
      ["TMUX", `\x1bPtmux;\x1b${osc}\x1b\\`],
      ["STY", `\x1bP${osc}\x1b\\`],
    ] as const) {
      const result = Bun.spawnSync(["/usr/bin/script", "-q", "/dev/null", process.execPath, "-e", `
        import { write } from ${JSON.stringify(path.join(import.meta.dir, "../src/clipboard.ts"))};
        await write("clip");
      `], { env: { ...env, ...(multiplexer ? { [multiplexer]: "fixture" } : {}) }, stdin: "ignore", stderr: "pipe", stdout: "pipe", timeout: 10_000 })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString(), multiplexer ?? "plain terminal").toContain(expected)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test.skipIf(process.platform !== "darwin")("reads macOS copied files and TIFF images from an isolated pasteboard", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-pasteboard-test-"))
  const image = fileURLToPath(new URL("../../../assets/brand/ycoding-mark-256.png", import.meta.url))
  const pdf = path.join(root, "copied file.pdf")
  await Bun.write(pdf, "%PDF")
  const run = (script: string, ...args: string[]) => {
    const result = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", `ObjC.import('AppKit'); ${script}`, "--", ...args])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trimEnd()
  }
  const name = run("ObjC.unwrap($.NSPasteboard.pasteboardWithUniqueName.name)")
  try {
    run(`function run(args) {
      const board = $.NSPasteboard.pasteboardWithName(args[0]);
      board.clearContents;
      const files = $.NSMutableArray.array;
      for (const path of args.slice(1)) files.addObject($.NSURL.fileURLWithPath(path));
      if (!board.writeObjects(files)) throw Error('No files copied');
    }`, name, image, pdf)
    expect(await readMacOSClipboard(root, undefined, name)).toEqual({
      type: "text", mime: "text/plain", text: [image, pdf].map((path) => pathToFileURL(path).href).join("\n"),
    })
    run(`function run(args) {
      const board = $.NSPasteboard.pasteboardWithName(args[0]);
      board.clearContents;
      const image = $.NSImage.alloc.initWithContentsOfFile(args[1]);
      if (!board.setDataForType(image.TIFFRepresentation, $.NSPasteboardTypeTIFF)) throw Error('No TIFF copied');
    }`, name, image)
    const content = await readMacOSClipboard(root, undefined, name)
    expect(content?.type).toBe("file")
    if (content?.type !== "file") throw Error("Clipboard did not return an image")
    expect((await Bun.file(content.temporary.path).bytes()).subarray(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    expect((await stat(content.temporary.path)).mode & 0o777).toBe(0o600)
    await content.temporary.cleanup()
    const text = '{\\rtf1 "árvíz"\nこんにちは 👋\n'.repeat(40_000)
    await writeMacOSClipboard(text, name)
    const written = await readMacOSClipboard(root, undefined, name)
    expect(written?.type).toBe("text")
    if (written?.type !== "text") throw new Error("Clipboard did not return plain text")
    expect(written.text.length).toBe(text.length)
    expect(Bun.hash(written.text)).toBe(Bun.hash(text))
    expect(await readdir(root)).toEqual(["copied file.pdf"])
  } finally {
    run("function run(args) { $.NSPasteboard.pasteboardWithName(args[0]).releaseGlobally }", name)
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

test("CLP-001 materializes concurrent clipboard images in distinct mode-0600 files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-clipboard-test-"))
  const results = await Promise.all(
    ["first", "second"].map((content) =>
      materializeClipboardImage(root, async (file) => {
        await Bun.write(file, content)
      }),
    ),
  )

  try {
    const paths = results.map((result) => fileURLToPath(result.uri))
    expect(new Set(paths).size).toBe(2)
    expect(paths.every((file) => file.startsWith(path.join(root, "ycoding-clipboard-")))).toBe(true)
    expect(await Promise.all(paths.map((file) => Bun.file(file).text()))).toEqual(["first", "second"])
    expect(await Promise.all(paths.map(async (file) => (await stat(file)).mode & 0o777))).toEqual([0o600, 0o600])
    expect(results.every((result) => result.uri.startsWith("file://"))).toBe(true)
  } finally {
    await Promise.all(results.map((result) => result.temporary.cleanup()))
  }

  expect(await readdir(root)).toEqual([])
})

test("CLP-002 removes a partial clipboard file when acquisition fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-clipboard-failure-test-"))

  await expect(
    materializeClipboardImage(root, async (file) => {
      await Bun.write(file, "partial")
      throw new Error("clipboard read failed")
    }),
  ).rejects.toThrow("clipboard read failed")

  expect(await readdir(root)).toEqual([])
})

test("CLP-003 aborts clipboard materialization and releases its owned temporary file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-clipboard-abort-test-"))
  const controller = new AbortController()
  let started!: () => void
  const writing = new Promise<void>((resolve) => (started = resolve))

  const acquisition = materializeClipboardImage(
    root,
    async (file) => {
      await Bun.write(file, "partial")
      started()
      await new Promise<void>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
      )
    },
    { signal: controller.signal },
  )

  await writing
  controller.abort(new Error("cancel clipboard acquisition"))
  await expect(acquisition).rejects.toThrow("cancel clipboard acquisition")
  expect(await readdir(root)).toEqual([])
})

test.skipIf(process.platform !== "darwin")("rejects with a generic error when the native helper fails after OSC 52 is offered", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-copy-failure-"))
  try {
    const helper = path.join(root, "osascript")
    await Bun.write(helper, "#!/bin/sh\n/bin/cat >/dev/null\necho HELPER-SECRET-DETAIL >&2\nexit 3\n")
    await chmod(helper, 0o700)
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: root }
    delete env.TMUX
    delete env.STY
    const result = Bun.spawnSync(["/usr/bin/script", "-q", "/dev/null", process.execPath, "-e", `
      import { write } from ${JSON.stringify(path.join(import.meta.dir, "../src/clipboard.ts"))};
      const warnings = [];
      const outcome = await write("clip", (message) => warnings.push(message)).then(() => "resolved", (error) => error.message);
      console.log("OUTCOME:" + JSON.stringify({ outcome, warnings }));
    `], { env, stdin: "ignore", stderr: "pipe", stdout: "pipe", timeout: 10_000 })
    const output = result.stdout.toString()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(output).toContain("\x1b]52;c;Y2xpcA==\x07")
    expect(output).not.toContain("HELPER-SECRET-DETAIL")
    const outcome = JSON.parse(output.split("OUTCOME:")[1]!.split("\n")[0]!)
    expect(outcome.outcome).toStartWith("Could not copy to the system clipboard")
    expect(outcome.warnings).toEqual(["Native clipboard write failed: helper failed"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
