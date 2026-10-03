import { afterAll, beforeAll, expect, test } from "bun:test"
import { Server } from "node:http"
import type { ViteDevServer } from "vite"
import { launchBrowser } from "./cdp"
import { startRelayDouble, type RelayDouble, type RelayHandlerOutcome, type RelayRequestHandler } from "../test/relay-double"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chrome executable.")
let vite: ViteDevServer
let listener: Server
let browser: Awaited<ReturnType<typeof launchBrowser>>
let origin: string
let relay: RelayDouble
let uploadResponse = Promise.withResolvers<RelayHandlerOutcome>()
let uploadHandler: RelayRequestHandler = () => uploadResponse.promise
beforeAll(async () => {
  relay = await startRelayDouble({ handler: (request) => request.operation === "session.attachment.upload" ? uploadHandler(request) : "default" })
  const { createServer } = await import("vite")
  vite = await createServer({ root: import.meta.dir.replace(/\/verify$/, ""), cacheDir: new URL("../../../.cache/tmp/web-reading/vite-upload", import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false, proxy: { "/api": { target: relay.httpURL } } } })
  listener = new Server(vite.middlewares)
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing ephemeral Vite address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); await vite?.close(); if (listener) await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); await relay?.stop() })

test("an accepted attachment displays submitted upload before the first chunk acknowledgement and reports failure without taking the new draft", async () => {
  const first = Promise.withResolvers<RelayHandlerOutcome>()
  uploadResponse = first
  const page = await browser.openPage()
  const wait = async (expression: string) => {
    for (let count = 0; count < 180; count++) {
      if (await page.evaluate<boolean>(expression)) return
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
    }
    throw new Error(`Upload condition did not settle: ${expression}`)
  }
  try {
    await page.navigate(`${origin}/verify/upload-flow.html?relay=${encodeURIComponent(relay.httpURL)}`)
    await wait(`!!document.querySelector('.composer__input:not([disabled])')`)
    await page.evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(30_000)],'submitted.bin',{type:'application/octet-stream'}));document.querySelector('.composer__row').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    await wait(`!!document.querySelector('.composer__attachment')`)
    await page.evaluate(`document.querySelector('[aria-label="Send prompt"]').click()`)
    await wait(`window.uploadFlowState().upload?.percent===0 && document.querySelector('.composer__attachment')===null`)
    const id = await page.evaluate<string>(`window.uploadFlowState().mutations[0].id`)
    await page.evaluate(`(() => {const input=document.querySelector('.composer__input');input.value='A newer unsent draft';input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await page.evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File(['new draft'],'newer.txt',{type:'text/plain'}));document.querySelector('.composer__row').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    await wait(`document.querySelector('.composer__attachment-name')?.textContent==='newer.txt'`)
    expect(await page.evaluate<string>(`document.querySelector('.composer__upload')?.textContent??''`)).toContain("submitted.bin · 0%")
    first.resolve({ ok: false, code: "internal_error", message: "Controlled upload failure" })
    await wait(`window.uploadFlowState().mutations[0]?.state==='failed'`)
    expect(await page.evaluate<string>(`document.querySelector('.transcript-message__send-error')?.textContent??''`)).toContain("Controlled upload failure")
    expect(await page.evaluate<string>(`document.querySelector('.composer__input').value`)).toBe("A newer unsent draft")
    expect(await page.evaluate<string>(`window.uploadFlowState().mutations[0].id`)).toBe(id)
    expect(await page.evaluate<string>(`window.uploadFlowState().mutations[0].input.files[0].name`)).toBe("submitted.bin")
    expect(await page.evaluate<string>(`document.querySelector('.composer__attachment-name').textContent`)).toBe("newer.txt")
    expect(await page.evaluate<number>(`document.querySelectorAll('.composer__attachment-error').length`)).toBe(0)
    expect(relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(0)
    uploadHandler = (request) => {
      if (typeof request.input?.uploadID !== "string") throw new Error("Missing upload ID")
      return { ok: true, value: request.input.last ? { uri: `ycoding-upload://${request.input.uploadID}` } : {} }
    }
    await page.evaluate(`document.querySelector('.transcript-message__send-error button').click()`)
    await wait(`window.uploadFlowState().mutations.length===0`)
    expect(relay.requests.filter((request) => request.operation === "session.prompt").map((request) => request.input?.id)).toEqual([id])
    expect(await page.evaluate<string>(`document.querySelector('.composer__input').value`)).toBe("A newer unsent draft")
    expect(await page.evaluate<string>(`document.querySelector('.composer__attachment-name').textContent`)).toBe("newer.txt")
  } finally { first.resolve("default"); await page.close() }
}, 60_000)

test("a locally rejected oversized attachment prompt explains the failure without releasing its draft", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`${origin}/verify/upload-flow.html?relay=${encodeURIComponent(relay.httpURL)}`)
    for (let count = 0; count < 180 && !await page.evaluate<boolean>(`!!document.querySelector('.composer__input:not([disabled])')`); count++)
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
    await page.evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File(['kept'],'kept.txt',{type:'text/plain'}));document.querySelector('.composer__row').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    for (let count = 0; count < 180 && !await page.evaluate<boolean>(`!!document.querySelector('.composer__attachment')`); count++)
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
    await page.evaluate(`(() => {const input=document.querySelector('.composer__input');input.value='x'.repeat(32_768);input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[aria-label="Send prompt"]').click()})()`)
    expect(await page.evaluate<string>(`document.querySelector('.composer__attachment-error[role="alert"]')?.textContent??''`)).toContain("32,768")
    expect(await page.evaluate<number>(`document.querySelectorAll('.composer__attachment').length`)).toBe(1)
    expect(await page.evaluate<number>(`document.querySelector('.composer__input').value.length`)).toBe(32_768)
    expect(await page.evaluate<number>(`window.uploadFlowState().mutations.length`)).toBe(0)
  } finally { await page.close() }
}, 60_000)

test("chunk progress remains cancellable after submission and never leaks into a different Session", async () => {
  const second = Promise.withResolvers<RelayHandlerOutcome>()
  uploadHandler = (request) => request.input?.index === 0 ? { ok: true, value: {} } : second.promise
  const page = await browser.openPage()
  const wait = async (expression: string) => {
    for (let count = 0; count < 180; count++) {
      if (await page.evaluate<boolean>(expression)) return
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
    }
    throw new Error(`Upload condition did not settle: ${expression}`)
  }
  try {
    await page.navigate(`${origin}/verify/upload-flow.html?relay=${encodeURIComponent(relay.httpURL)}`)
    await wait(`!!document.querySelector('.composer__input:not([disabled])')`)
    await page.evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(30_000)],'progress.bin',{type:'application/octet-stream'}));document.querySelector('.composer__row').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    await wait(`!!document.querySelector('.composer__attachment')`)
    await page.evaluate(`document.querySelector('[aria-label="Send prompt"]').click()`)
    await wait(`window.uploadFlowState().upload?.percent>0 && window.uploadFlowState().upload?.percent<100`)
    expect(await page.evaluate<string>(`document.querySelector('.composer__upload')?.textContent??''`)).toContain("progress.bin")
    expect(await page.evaluate<number>(`document.querySelector('progress[aria-label="Uploading progress.bin"]').value`)).toBeGreaterThan(0)
    await page.evaluate(`document.querySelector('.composer__upload button').click()`)
    second.resolve({ ok: false, code: "internal_error", message: "Cancelled held chunk" })
    await wait(`window.uploadFlowState().mutations[0]?.state==='failed'`)
    expect(await page.evaluate<string>(`document.querySelector('.transcript-message__send-error').textContent`)).toContain("cancelled")
    expect(await page.evaluate<string>(`window.uploadFlowState().mutations[0].input.files[0].name`)).toBe("progress.bin")
    await page.evaluate(`window.uploadFlowSelect('ses_b')`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.composer__upload').length`)).toBe(0)
  } finally { second.resolve("default"); await page.close() }
}, 60_000)

for (const boundary of ["selection", "connection"] as const) test(`a submitted upload survives ${boundary} loss as a retained failed receipt without admitting a prompt elsewhere`, async () => {
  const held = Promise.withResolvers<RelayHandlerOutcome>()
  uploadHandler = () => held.promise
  const before = relay.requests.filter((request) => request.operation === "session.prompt").length
  const page = await browser.openPage()
  const wait = async (expression: string) => {
    for (let count = 0; count < 180; count++) {
      if (await page.evaluate<boolean>(expression)) return
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
    }
    throw new Error(`Upload condition did not settle: ${expression}`)
  }
  try {
    await page.navigate(`${origin}/verify/upload-flow.html?relay=${encodeURIComponent(relay.httpURL)}`)
    await wait(`!!document.querySelector('.composer__input:not([disabled])')`)
    await page.evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File(['retained'],'retained.txt',{type:'text/plain'}));document.querySelector('.composer__row').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    await wait(`!!document.querySelector('.composer__attachment')`)
    await page.evaluate(`document.querySelector('[aria-label="Send prompt"]').click()`)
    await wait(`window.uploadFlowState().upload?.percent===0`)
    const id = await page.evaluate<string>(`window.uploadFlowState().mutations[0].id`)
    if (boundary === "selection") {
      await page.evaluate(`window.uploadFlowSelect('ses_b')`)
      held.resolve({ ok: true, value: { uri: "ycoding-upload://late" } })
    }
    if (boundary === "connection") held.resolve("close")
    await wait(`window.uploadFlowState().mutations.find(row=>row.id===${JSON.stringify(id)})?.state==='failed'`)
    expect(await page.evaluate<string>(`window.uploadFlowState().mutations.find(row=>row.id===${JSON.stringify(id)}).input.files[0].name`)).toBe("retained.txt")
    expect(await page.evaluate<number>(`document.querySelectorAll('.composer__upload').length`)).toBe(0)
    expect(relay.requests.filter((request) => request.operation === "session.prompt").length).toBe(before)
    if (boundary === "selection") expect(await page.evaluate<string>(`window.uploadFlowState().activeSessionID`)).toBe("ses_b")
  } finally { held.resolve("default"); await page.close() }
}, 60_000)
