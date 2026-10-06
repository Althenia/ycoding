import { afterAll, beforeAll, expect, test } from "bun:test"
import { Server } from "node:http"
import type { ViteDevServer } from "vite"
import { launchBrowser } from "./cdp"
import { startRelayDouble, waitFor, type RelayDouble, type RelayHandlerOutcome } from "../test/relay-double"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chrome executable.")
let vite: ViteDevServer
let listener: Server
let browser: Awaited<ReturnType<typeof launchBrowser>>
let origin: string
let relay: RelayDouble
let hold = false
const pending = Promise.withResolvers<RelayHandlerOutcome>()

beforeAll(async () => {
  relay = await startRelayDouble({
    handler: (request) => (request.operation === "session.pending.list" && hold ? pending.promise : "default"),
  })
  const { createServer } = await import("vite")
  vite = await createServer({
    root: import.meta.dir.replace(/\/verify$/, ""),
    cacheDir: new URL("../../../.cache/tmp/web-reading/vite-pending-input", import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false, ws: false, proxy: { "/api": { target: relay.httpURL } } },
  })
  listener = new Server(vite.middlewares)
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing ephemeral Vite address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(executable, 1440, 900)
})

afterAll(async () => {
  pending.resolve("default")
  await browser?.close()
  await vite?.close()
  if (listener)
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  await relay?.stop()
})

test("an acknowledged prompt stays rendered and focused while an older pending read settles, then promotes once", async () => {
  const page = await browser.openPage()
  const wait = async (expression: string) => {
    for (let count = 0; count < 180; count++) {
      if (await page.evaluate<boolean>(expression)) return
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
    }
    throw new Error(`Prompt condition did not settle: ${expression}`)
  }
  try {
    await page.navigate(`${origin}/verify/upload-flow.html?relay=${encodeURIComponent(relay.httpURL)}`)
    await wait(
      `typeof window.uploadFlowSelect==='function' && !!document.querySelector('.composer__input:not([disabled])')`,
    )
    const before = relay.requests.filter((request) => request.operation === "session.pending.list").length
    hold = true
    await page.evaluate(`window.pendingSelection=window.uploadFlowSelect('ses_a');void 0`)
    await waitFor(
      () => relay.requests.filter((request) => request.operation === "session.pending.list").length > before,
    )
    await page.evaluate(
      `(() => {const input=document.querySelector('.composer__input');input.value='Keep the submitted bubble';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`,
    )
    await wait(
      `window.uploadFlowState().mutations.length===0 && document.body.textContent.includes('Keep the submitted bubble')`,
    )
    const id = await page.evaluate<string>(
      `window.uploadFlowState().view.messages.find(message=>message.text==='Keep the submitted bubble').id`,
    )
    await page.evaluate(
      `window.submittedBubble=document.querySelector('.transcript-message--user');window.bubbleRemoved=false;window.bubbleObserver=new MutationObserver(()=>{if(!window.submittedBubble.isConnected)window.bubbleRemoved=true});window.bubbleObserver.observe(document.querySelector('.conversation-pane'),{childList:true,subtree:true});void 0`,
    )
    pending.resolve({ ok: true, value: { data: [] } })
    await page.evaluate(`window.pendingSelection`)
    expect(await page.evaluate<boolean>(`document.body.textContent.includes('Keep the submitted bubble')`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.activeElement===document.querySelector('.composer__input')`)).toBe(
      true,
    )
    relay.pushEvent("ses_a", {
      type: "session.input.admitted",
      durable: { aggregateID: "ses_a", seq: 1, version: 1 },
      data: {
        inputID: id,
        input: { type: "user", delivery: "steer", data: { text: "Keep the submitted bubble" } },
      },
    })
    relay.pushEvent("ses_a", {
      type: "session.input.promoted",
      durable: { aggregateID: "ses_a", seq: 2, version: 1 },
      data: { inputID: id },
    })
    await wait(`window.uploadFlowState().view.watermark===2`)
    expect(
      await page.evaluate<number>(
        `[...document.querySelectorAll('.transcript-message--user')].filter(row=>row.textContent.includes('Keep the submitted bubble')).length`,
      ),
    ).toBe(1)
    expect(await page.evaluate<boolean>(`window.submittedBubble.isConnected && !window.bubbleRemoved`)).toBe(true)
    expect(
      relay.requests.filter((request) => request.operation === "session.prompt" && request.input?.id === id),
    ).toHaveLength(1)
  } finally {
    pending.resolve("default")
    await page.evaluate(`window.bubbleObserver?.disconnect()`)
    await page.close()
  }
})
