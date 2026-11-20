import { afterAll, beforeAll, expect, test } from "bun:test"
import { startRelayDouble } from "../test/relay-double"
import { launchBrowser } from "./cdp"

const port = 4489
const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME")
let server: ReturnType<typeof Bun.spawn>
let browser: Awaited<ReturnType<typeof launchBrowser>>
beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${port}/verify/guardrail-family-fixture.html`).then((response) => response.ok).catch(() => false)) break; await Bun.sleep(100) }
  browser = await launchBrowser(chrome, 1280, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const dots = (delivery: "steer" | "queue") => ({ inputOrigin: "direct", dotsInput: { origin: "dots-native", delivery } })

test("a Dot-originated steer shows a Steer marker beside the Dot avatar while queued Dot input and ordinary sends stay unmarked", async () => {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], messages: { ses_a: [
    { id: "msg_human", type: "user", text: "Ordinary typed prompt", time: { created: 1 } },
    { id: "msg_dot_steer", type: "user", text: "Steer from the Dot", metadata: dots("steer"), time: { created: 2 } },
    { id: "msg_dot_queue", type: "user", text: "Queued from the Dot", metadata: dots("queue"), time: { created: 3 } },
    { id: "msg_dot_synthetic", type: "synthetic", description: "Dot steer", text: "Synthetic Dot steer text", time: { created: 4 } },
    { id: "msg_forged", type: "user", text: "Caller-supplied origin", metadata: { dotsInput: { origin: "remote", delivery: "steer" } }, time: { created: 5 } },
  ] } })
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/guardrail-family-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}&http=${encodeURIComponent(relay.httpURL)}`)
    for (let i = 0; i < 200 && !await page.evaluate(`document.querySelector('[data-message-id="msg_forged"] .transcript-message__bubble') !== null`); i++) await Bun.sleep(20)
    const rows = await page.evaluate(`Object.fromEntries(["msg_human", "msg_dot_steer", "msg_dot_queue", "msg_dot_synthetic", "msg_forged"].map(id => {
      const row = document.querySelector('[data-message-id="' + id + '"]')
      const avatar = row?.querySelector('.transcript-message__origin')
      const marker = row?.querySelector('.transcript-message__steer')
      const a = avatar?.getBoundingClientRect(), m = marker?.getBoundingClientRect()
      return [id, { avatar: avatar?.getAttribute('aria-label') ?? null, marker: marker?.textContent.trim() ?? null, beside: Boolean(a && m && m.left >= a.right && m.left - a.right <= 8 && Math.abs((m.top + m.bottom) / 2 - (a.top + a.bottom) / 2) <= 1) }]
    }))`)
    expect(rows).toEqual({
      msg_human: { avatar: null, marker: null, beside: false },
      msg_dot_steer: { avatar: "ChatGPT", marker: "Steer", beside: true },
      msg_dot_queue: { avatar: "ChatGPT", marker: null, beside: false },
      msg_dot_synthetic: { avatar: "ChatGPT", marker: "Steer", beside: true },
      msg_forged: { avatar: null, marker: null, beside: false },
    })
  } finally { await page.close(); await relay.stop() }
})
