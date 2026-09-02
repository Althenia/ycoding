import { execFile, spawn } from "node:child_process"
import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { platform, release, tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)

export type ClipboardTemporary = Readonly<{ path: string; cleanup(): Promise<void> }>
export type ClipboardFile = Readonly<{
  type: "file"
  uri: string
  mime: string
  name: string
  temporary: ClipboardTemporary
}>

function command(command: string, args: string[] = [], input?: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] })
    const output: Buffer[] = []
    child.on("error", reject)
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(output))
      reject(new Error(`${command} exited with code ${code}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function writeOsc52(text: string) {
  if (!process.stdout.isTTY) return
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  process.stdout.write(process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence)
}

export async function read() {
  if (platform() === "darwin") {
    // Use OS tmpdir (typically /var/folders/.../T) instead of hardcoded /private/tmp
    // to respect sandbox/TMPDIR and avoid intermittent ENOENT on restricted /private/tmp.
    try {
      return await materializeClipboardImage(tmpdir(), async (file) => {
        await exec("osascript", [
          "-e",
          'set imageData to the clipboard as "PNGf"',
          "-e",
          `set fileRef to open for access POSIX file "${file}" with write permission`,
          "-e",
          "set eof fileRef to 0",
          "-e",
          "write imageData to fileRef",
          "-e",
          "close access fileRef",
        ])
      })
    } catch {
      // Fall through to text clipboard.
    }
  }

  if (platform() === "win32" || release().includes("WSL")) {
    try {
      return await materializeClipboardImage(tmpdir(), async (file) => {
        const target = release().includes("WSL") ? (await command("wslpath", ["-w", file])).toString().trim() : file
        const escaped = target.replaceAll("'", "''")
        const script = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if (-not $img) { exit 1 }; $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`
        await command("powershell.exe", ["-NonInteractive", "-NoProfile", "-command", script])
      })
    } catch {
      // Fall through to text clipboard.
    }
  }

  if (platform() === "linux") {
    const image = await command("wl-paste", ["-t", "image/png"])
      .catch(() => command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]))
      .catch(() => Buffer.alloc(0))
    if (image.length) {
      return materializeClipboardImage(tmpdir(), (file) => writeFile(file, image))
    }
  }

  const { default: clipboardy } = await import("clipboardy")
  const text = await clipboardy.read().catch(() => undefined)
  if (text) return { type: "text" as const, text, mime: "text/plain" as const }
}

export async function materializeClipboardImage(root: string, write: (file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(root, "ycoding-clipboard-"))
  const file = path.join(directory, "clipboard.png")
  const handle = await open(file, "wx", 0o600).catch(async (error) => {
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  await handle.close()
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await write(file)
    return {
      type: "file" as const,
      uri: pathToFileURL(file).href,
      mime: "image/png" as const,
      name: "clipboard.png",
      temporary: { path: file, cleanup },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function copyCommand(
  os: NodeJS.Platform,
  wayland: boolean,
  has: (name: string) => boolean,
): string[] | undefined {
  if (os === "darwin" && has("osascript")) return ["osascript"]
  if (os === "linux" && wayland && has("wl-copy")) return ["wl-copy"]
  if (os === "linux" && has("xclip")) return ["xclip", "-selection", "clipboard"]
  if (os === "linux" && has("xsel")) return ["xsel", "--clipboard", "--input"]
  if (os === "win32" && has("powershell.exe")) {
    return [
      "powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]
  }
}

let copyMethod: Promise<(text: string) => Promise<void>> | undefined

function getCopyMethod() {
  return (copyMethod ??= (async () => {
    const { which } = await import("@ycoding-ai/core/util/which")
    const native = copyCommand(platform(), Boolean(process.env.WAYLAND_DISPLAY), (name) => Boolean(which(name)))
    if (native?.[0] === "osascript") {
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await command("osascript", ["-e", `set the clipboard to "${escaped}"`]).catch(() => undefined)
      }
    }
    if (native) {
      return async (text: string) => {
        await command(native[0], native.slice(1), text).catch(() => undefined)
      }
    }
    return async (text: string) => {
      const { default: clipboardy } = await import("clipboardy")
      await clipboardy.write(text).catch(() => undefined)
    }
  })())
}

export async function write(text: string) {
  writeOsc52(text)
  const method = await getCopyMethod()
  await method(text)
}
