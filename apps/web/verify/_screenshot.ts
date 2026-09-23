import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BASE = "http://127.0.0.1:4321"
const out = process.argv[2] ?? "/tmp/web-captures"

type DevtoolsResults = {
  "Target.createTarget": { targetId: string }
  "Target.attachToTarget": { sessionId: string }
  "Page.captureScreenshot": { data: string }
}

function devtoolsEndpoint(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = ""
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) resolve(match[1]!)
    })
    child.once("error", (e) => reject(new Error(`Chrome did not start: ${e.message}`)))
    child.once("exit", (code) => reject(new Error(`Chrome exited before ready (${code})`)))
  })
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "ycoding-shot-"))
  const child = spawn(CHROME, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] })
  const endpoint = await devtoolsEndpoint(child)
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve) => { socket.addEventListener("open", () => resolve(), { once: true }) })
  let next = 0
  const pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  socket.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data))
    if (m.id === undefined) return
    const w = pending.get(m.id)
    if (!w) return
    pending.delete(m.id)
    if (m.error) w.reject(new Error(`${m.error.message}`))
    else w.resolve(m.result)
  })
  const send = <Method extends string>(method: Method, params: Record<string, unknown> = {}, sid?: string) =>
    new Promise<Method extends keyof DevtoolsResults ? DevtoolsResults[Method] : unknown>((resolve, reject) => { const id = ++next; pending.set(id, { method, resolve: (value) => resolve(value as Method extends keyof DevtoolsResults ? DevtoolsResults[Method] : unknown), reject }); socket.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })) })

  const pages = [
    { path: "/", label: "landing", widths: [1440, 1024, 390] },
    { path: "/docs", label: "docs", widths: [1440, 390] },
    { path: "/docs/configuration", label: "config", widths: [1440, 390] },
    { path: "/changelog", label: "changelog", widths: [1440, 390] },
  ]
  const themes = ["light", "dark"]

  for (const p of pages) {
    for (const w of p.widths) {
      for (const theme of themes) {
        const target = await send("Target.createTarget", { url: "about:blank" })
        const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
        const sid = attached.sessionId
        const call = <Method extends string>(method: Method, params: Record<string, unknown> = {}) => send(method, params, sid)
        await call("Page.enable")
        await call("Runtime.enable")
        await call("Network.enable")
        await call("Network.setBlockedURLs", { urls: ["*sw.js*"] })
        await call("Emulation.setDeviceMetricsOverride", { width: w, height: 1600, deviceScaleFactor: 1, mobile: false })
        await call("Emulation.setEmulatedMedia", { features: [{ name: "theme", value: theme === "dark" ? "dark" : "light" }] })
        await call("Page.navigate", { url: `${BASE}${p.path}` })
        await new Promise((r) => setTimeout(r, 700))
        const { data } = await call("Page.captureScreenshot", { format: "png" })
        const key = `${p.label}-${w}-${theme}`
        const p2 = join(out, `${key}.png`)
        await Bun.write(p2, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
        await call("Target.closeTarget", { targetId: target.targetId })
        console.log("shot", key)
      }
    }
  }
  await new Promise((r) => setTimeout(r, 500))
  socket.close()
  child.kill("SIGKILL")
  rmSync(profile, { recursive: true, force: true })
  console.log("done")
}
main()
