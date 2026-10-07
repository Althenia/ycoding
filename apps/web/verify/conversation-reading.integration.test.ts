import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ViteDevServer } from "vite"
import { Server } from "node:http"
import { launchBrowser } from "./cdp"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chrome executable.")
let server: ViteDevServer
let listener: Server
let browser: Awaited<ReturnType<typeof launchBrowser>>
let origin: string

beforeAll(async () => {
  process.env.YCODING_WEB_VERIFY = "1"
  const { createServer } = await import("vite")
  server = await createServer({ root: import.meta.dir.replace(/\/verify$/, ""), cacheDir: new URL("../../../.cache/tmp/web-reading/vite-reading", import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false } })
  listener = new Server(server.middlewares)
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve) })
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing ephemeral Vite address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); await server?.close(); if (listener) await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())) })

type Page = Awaited<ReturnType<typeof launchBrowser>> extends { openPage(): Promise<infer P> } ? P : never
const frames = (page: Page, count = 4) => page.evaluate(`new Promise(resolve => { let left=${count}; const tick=()=>--left ? requestAnimationFrame(tick) : resolve(true); requestAnimationFrame(tick) })`)
async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await page.evaluate<boolean>(expression)) return
    await frames(page, 1)
  }
  throw new Error(`Rendered condition did not settle: ${expression}`)
}
async function open(page: Page, params = "") {
  await page.navigate(`${origin}/verify/remote.html?view=chat&team=two&transcriptProbe=1&${params}`)
  await wait(page, `document.querySelector('[data-message-id="probe_tail"]') !== null`)
  await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden'; })()`)
  await frames(page)
}
const anchor = `(() => { const root=document.querySelector('.workspace__scroll'), bounds=root.getBoundingClientRect(); const row=[...document.querySelectorAll('[data-message-id]')].find(row=>row.getBoundingClientRect().top>=bounds.top && row.getBoundingClientRect().top<bounds.bottom); if(!row) throw Error('No visible transcript anchor'); window.readingAnchor=row; window.readingTop=row.getBoundingClientRect().top; })()`
const delta = `window.transcriptDelta('\\n'+'Streaming output grows live. '.repeat(100))`

test("manual scroll during streaming retains the visible row while latest-follow and Jump to latest stay live", async () => {
  const page = await browser.openPage()
  try {
    for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
      await page.setViewport(width, 900)
      await page.setReducedMotion(true)
      await open(page, `theme=${theme}`)
      await wait(page, `document.querySelector('.workspace__scroll').scrollTop>500`)
      await page.evaluate(`(() => { ${delta}; const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{deltaY:-600,bubbles:true})); root.scrollTop=400; root.dispatchEvent(new Event('scroll')); })()`)
      await frames(page)
      expect(await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)).toBeLessThan(500)
      await page.evaluate(anchor)
      await page.evaluate(delta)
      await frames(page, 8)
      const held = await page.evaluate<{ connected: boolean; shift: number; jump: boolean }>(`({ connected:window.readingAnchor.isConnected, shift:Math.abs(window.readingAnchor.getBoundingClientRect().top-window.readingTop), jump:!!document.querySelector('[aria-label="Jump to latest"]') })`)
      expect(held).toEqual({ connected: true, shift: 0, jump: true })
      await page.evaluate(`document.querySelector('[aria-label="Jump to latest"]').click()`)
      await frames(page, 8)
      await page.evaluate(delta)
      await frames(page, 8)
      expect(await page.evaluate<number>(`(() => { const root=document.querySelector('.workspace__scroll'); return root.scrollHeight-root.clientHeight-root.scrollTop })()`)).toBeLessThanOrEqual(1)
    }
  } finally { await page.close() }
}, 60_000)

test("all screen entries choose their position before paint without resetting same-screen state", async () => {
  const page = await browser.openPage()
  try {
    for (const width of [390, 1440]) {
    await page.setViewport(width, 900)
    await page.setReducedMotion(true)
    await open(page)
    for (const route of [
      { href: "/remote/usage", pathname: "/remote/usage", bottom: false },
      { href: "/remote/settings", pathname: "/remote/settings", bottom: false },
      { href: "/remote/sessions", pathname: "/remote/sessions", bottom: false },
      { href: "/remote", pathname: "/remote", bottom: false },
      { href: "/remote/session?session_id=ses_fixture&device_id=dev_studio", pathname: "/remote/session", bottom: true },
    ]) {
      await page.evaluate(`(() => { window.entryPositions=[]; window.entryRoute=${JSON.stringify(route.pathname)}; window.entryBottom=${route.bottom}; window.entrySampling=true; const tick=()=>{ if(!window.entrySampling) return; const panel=[...document.querySelectorAll('.workspace__scroll > .route-panel')].find(panel=>!panel.inert); if(location.pathname===window.entryRoute && panel && panel.children.length && getComputedStyle(panel).opacity!=='0') { const root=document.querySelector('.workspace__scroll'); window.entryPositions.push(window.entryBottom ? root.scrollHeight-root.clientHeight-root.scrollTop : root.scrollTop); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); document.querySelector('${width < 768 ? ".bottom-nav" : ".remote-nav"} a[href="${route.href}"]').click(); })()`)
      await wait(page, `window.entryPositions.length>=4`)
      const samples = await page.evaluate<number[]>(`(() => {window.entrySampling=false; return window.entryPositions})()`)
      expect(Math.max(...samples), route.pathname).toBeLessThanOrEqual(1)
      await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{deltaY:300,bubbles:true})); root.scrollTop=200; root.dispatchEvent(new Event('scroll')); })()`)
      await frames(page, 2)
      const top = await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)
      await frames(page, 8)
      expect(await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`), route.pathname).toBe(top)
    }
    }
  } finally { await page.close() }
}, 60_000)

test("a native wheel gesture interrupts latest-follow while output arrives every frame", async () => {
  const page = await browser.openPage()
  try {
    await open(page)
    await page.evaluate(`(() => { window.streaming=true; const tick=()=>{ if(!window.streaming) return; window.transcriptDelta(' live output '.repeat(10)); requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`)
    const bounds = await page.evaluate<{ x: number; y: number }>(`(() => {const rect=document.querySelector('.workspace__scroll').getBoundingClientRect(); return {x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2}})()`)
    await page.wheel(bounds.x, bounds.y, 0, -600)
    await frames(page, 8)
    await page.evaluate(`window.streaming=false`)
    expect(await page.evaluate<number>(`(() => {const root=document.querySelector('.workspace__scroll'); return root.scrollHeight-root.clientHeight-root.scrollTop})()`)).toBeGreaterThan(400)
  } finally { await page.close() }
}, 60_000)

test("a small deliberate wheel scroll does not resume following merely because the reader is near the bottom", async () => {
  const page = await browser.openPage()
  try {
    await page.setReducedMotion(true)
    await open(page)
    const bounds = await page.evaluate<{ x: number; y: number }>(`(() => {const rect=document.querySelector('.workspace__scroll').getBoundingClientRect(); return {x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2}})()`)
    await page.wheel(bounds.x, bounds.y, 0, -12)
    await frames(page, 8)
    await page.evaluate(anchor)
    const before = await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)
    await page.evaluate(delta)
    await frames(page, 8)
    expect(await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)).toBe(before)
    expect(await page.evaluate<number>(`Math.abs(window.readingAnchor.getBoundingClientRect().top-window.readingTop)`)).toBeLessThanOrEqual(1)
    expect(await page.evaluate<boolean>(`!!document.querySelector('[aria-label="Jump to latest"]')`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

test("a small native touch scroll keeps the reader's visible message while output grows", async () => {
  const page = await browser.openPage()
  try {
    await page.setMobileViewport(390, 900)
    await page.setReducedMotion(true)
    await open(page)
    const bounds = await page.evaluate<{ x: number; y: number }>(`(() => {const rect=document.querySelector('.workspace__scroll').getBoundingClientRect(); return {x:rect.left+6,y:(rect.top+rect.bottom)/2}})()`)
    await page.touch("touchStart", bounds.x, bounds.y)
    await page.touch("touchMove", bounds.x, bounds.y + 40)
    await frames(page, 8)
    await page.evaluate(anchor)
    await page.evaluate(delta)
    await frames(page, 8)
    expect(await page.evaluate<number>(`Math.abs(window.readingAnchor.getBoundingClientRect().top-window.readingTop)`)).toBeLessThanOrEqual(1)
    await page.touch("touchEnd")
  } finally { await page.close() }
}, 60_000)

test("trusted scroll-away survives tool progress, footer settlement, todo and decision resizing, snapshots and a fresh stream epoch", async () => {
  const page = await browser.openPage()
  try {
    for (const width of [390, 820, 1440]) {
      await page.setViewport(width, 900)
      await page.setReducedMotion(true)
      await open(page)
      const bounds = await page.evaluate<{ x: number; y: number }>(`(() => {const rect=document.querySelector('.workspace__scroll').getBoundingClientRect(); return {x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2}})()`)
      await page.wheel(bounds.x, bounds.y, 0, -700)
      await frames(page, 8)
      await page.evaluate(anchor)
      await page.evaluate(`(() => { window.geometrySamples=[]; window.samplingReading=true; const tick=()=>{if(!window.samplingReading)return; window.geometrySamples.push(Math.abs(window.readingAnchor.getBoundingClientRect().top-window.readingTop)); requestAnimationFrame(tick)}; requestAnimationFrame(tick) })()`)
      await page.evaluate(delta)
      for (const kind of ["progress", "decisions", "settle", "epoch"]) {
        await page.evaluate(`window.remoteReadingTail(${JSON.stringify(kind)})`)
        await frames(page, 8)
        if (kind === "progress") expect(await page.evaluate<string>(`document.querySelector('[data-message-id="probe_tail"] .transcript-tool__status')?.innerText`)).toContain("Running")
        if (kind === "decisions") {
          expect(await page.evaluate<number>(`document.querySelectorAll('.todo-panel__item').length`)).toBe(4)
          expect(await page.evaluate<boolean>(`!!document.querySelector('#pending-requests')`)).toBe(true)
        }
        if (kind === "settle") expect(await page.evaluate<string>(`document.querySelector('[data-message-id="probe_tail"] .transcript-tool__status')?.innerText`)).toContain("Completed")
      }
      await page.evaluate(`window.transcriptRefresh()`)
      await page.evaluate(delta)
      await frames(page, 8)
      const result = await page.evaluate<{ shift: number; connected: boolean; focus: string; tool: boolean; decision: boolean }>(`(() => {window.samplingReading=false; return {shift:Math.max(...window.geometrySamples), connected:window.readingAnchor.isConnected,focus:document.activeElement?.getAttribute('aria-label')??document.activeElement?.tagName, tool:!!document.querySelector('.transcript-tool'), decision:!!document.querySelector('#pending-requests')} })()`)
      expect(result.shift, `${width}, focus ${result.focus}`).toBeLessThanOrEqual(1)
      expect(result.connected).toBe(true)
      expect(result.decision).toBe(true)
    }
  } finally { await page.close() }
}, 60_000)

test("sidebar collapse and reopen retain the actual virtual row and transcript anchors", async () => {
  const page = await browser.openPage()
  try {
    for (const width of [820, 1440]) {
    await page.setViewport(width, 900)
    await page.setReducedMotion(true)
    await open(page, "inventoryCount=150&pageRows=150")
    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true})); root.scrollTop=400; root.dispatchEvent(new Event('scroll')); const rail=document.querySelector('.workspace__rail'); rail.scrollTop=500; rail.dispatchEvent(new Event('scroll')); })()`)
    await frames(page, 8)
    await page.evaluate(`${anchor}; (() => {const rail=document.querySelector('.workspace__rail'), bounds=rail.getBoundingClientRect(); const row=[...rail.querySelectorAll('.session-list__row')].find(row=>row.getBoundingClientRect().top>=bounds.top); window.railAnchor=row; window.railTop=row.getBoundingClientRect().top; })()`)
    await page.evaluate(`document.querySelector('[aria-label="Hide sessions sidebar"]').click()`)
    await frames(page, 8)
    const held = await page.evaluate<{ shift: number; focus: string }>(`({shift:Math.abs(window.readingAnchor.getBoundingClientRect().top-window.readingTop),focus:document.activeElement?.getAttribute('aria-label')??document.activeElement?.tagName})`)
    expect(held.shift, `focused ${held.focus}`).toBeLessThanOrEqual(1)
    await page.evaluate(`document.querySelector('[aria-label="Show sessions sidebar"]').click()`)
    await frames(page, 8)
    expect(await page.evaluate<boolean>(`window.railAnchor.isConnected`)).toBe(true)
    expect(await page.evaluate<number>(`Math.abs(window.railAnchor.getBoundingClientRect().top-window.railTop)`)).toBeLessThanOrEqual(1)
    expect(await page.evaluate<number>(`Math.abs(window.readingAnchor.getBoundingClientRect().top-window.readingTop)`)).toBeLessThanOrEqual(1)
    }
  } finally { await page.close() }
}, 60_000)

test("reading the last message above pending decisions does not enable virtual-list tail following", async () => {
  const page = await browser.openPage()
  try {
    await page.setReducedMotion(true)
    await open(page)
    await page.evaluate(`window.remoteReadingTail('decisions')`)
    await frames(page, 8)
    const bounds = await page.evaluate<{ x: number; y: number }>(`(() => {const rect=document.querySelector('.workspace__scroll').getBoundingClientRect(); return {x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2}})()`)
    await page.wheel(bounds.x, bounds.y, 0, -160)
    await frames(page, 8)
    await page.evaluate(anchor)
    await page.evaluate(`window.remoteReadingTail('progress')`)
    await frames(page, 8)
    expect(await page.evaluate<number>(`Math.abs(window.readingAnchor.getBoundingClientRect().top-window.readingTop)`)).toBeLessThanOrEqual(1)
  } finally { await page.close() }
}, 60_000)

test("Conversation opens the new-session landing while selected Session and landing drafts remain resident", async () => {
  const page = await browser.openPage()
  try {
    for (const width of [320, 390, 820, 1440]) {
    await page.setViewport(width, 900)
    await page.setCoarsePointer(width < 768)
    await open(page)
    await page.evaluate(`(() => { const field=document.querySelector('.composer-resident textarea'); field.value='Keep my unsent draft'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb [aria-label="New conversation"]') === null`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth`)).toBe(false)
    await page.evaluate(`[...document.querySelectorAll('a[href="/remote"]')].find(link => link.getBoundingClientRect().width > 0)?.click()`)
    await wait(page, `!!document.querySelector('.route-panel:not([inert]) .new-session-composer__brand')`)
    expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote")
    expect(await page.evaluate<number>(`window.requestLog.filter(row=>row.operation==='session.create').length`)).toBe(0)
    await page.evaluate(`(() => { const field=document.querySelector('.new-session-composer textarea'); window.newConversationDraft=field; field.value='Keep the new-conversation draft too'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await page.evaluate(`document.querySelector('${width < 768 ? ".bottom-nav" : ".remote-nav"} a[href^="/remote/session?"]').click()`)
    await wait(page, `location.pathname === '/remote/session' && !!document.querySelector('.remote-conversation-view:not([inert]) .conversation-pane')`)
    expect(await page.evaluate<string>(`document.querySelector('.composer-resident textarea').value`)).toBe("Keep my unsent draft")
    await wait(page, `!document.querySelector('.workspace__scroll > .route-panel--exiting')`)
    expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer').closest('.route-panel').getClientRects().length===0`)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('a[href="/remote"]')].find(link => link.getBoundingClientRect().width > 0)?.click()`)
    await wait(page, `!!document.querySelector('.route-panel:not([inert]) .new-session-composer textarea')`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session-composer textarea').value`)).toBe("Keep the new-conversation draft too")
    expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer textarea')===window.newConversationDraft`)).toBe(true)
    await wait(page, `!document.querySelector('.workspace__scroll > .route-panel--exiting')`)
    if (width === 390 || width === 1440) await Bun.write(new URL(`../../../.cache/tmp/web-reading/start-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    }
  } finally { await page.close() }
}, 60_000)

test("returning to a resident Session restores its reader anchor once and leaves later keyboard scrolling free", async () => {
  const page = await browser.openPage()
  try {
    await page.setReducedMotion(true)
    await open(page, "latency=20")
    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true})); root.scrollTop=400; root.dispatchEvent(new Event('scroll')); })()`)
    await frames(page, 8)
    await page.evaluate(anchor)
    const before = await page.evaluate<{ id: string; top: number }>(`({id:window.readingAnchor.dataset.messageId,top:window.readingTop})`)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    await wait(page, `!!document.querySelector('.team-view [data-action="open"]')`)
    await page.evaluate(`document.querySelector('.team-view [data-action="open"]').click()`)
    await wait(page, `!!document.querySelector('[aria-label="Main session"]')`)
    await page.evaluate(`document.querySelector('[aria-label="Main session"]').click()`)
    await wait(page, `!!document.querySelector('.conversation-pane [data-message-id="${before.id}"]')`)
    await frames(page, 2)
    expect(await page.evaluate<number>(`Math.abs(document.querySelector('[data-message-id="${before.id}"]').getBoundingClientRect().top-${before.top})`)).toBeLessThanOrEqual(1)
    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); root.focus({preventScroll:true}); root.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true})); root.scrollTop-=100; root.dispatchEvent(new Event('scroll')); })()`)
    const moved = await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)
    await frames(page, 8)
    expect(await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)).toBe(moved)
  } finally { await page.close() }
}, 60_000)

test("a new-conversation attachment draft survives an uncertain creation outcome", async () => {
  const page = await browser.openPage()
  try {
    await open(page, "creation=unknown")
    await page.evaluate(`[...document.querySelectorAll('a[href="/remote"]')].find(link => link.getBoundingClientRect().width > 0)?.click()`)
    await wait(page, `location.pathname === '/remote' && !!document.querySelector('.new-session-composer [aria-label="Create session"]:not([disabled])')`)
    await wait(page, `!!document.querySelector('.new-session-composer [aria-label="Create session"]:not([disabled])')`)
    await page.evaluate(`(() => {const transfer=new DataTransfer(); transfer.items.add(new File(['A scoped draft'], 'scope.txt', {type:'text/plain'})); document.querySelector('.new-session-composer .composer__row').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    await wait(page, `!!document.querySelector('.new-session-composer .composer__attachment-name')`)
    await page.evaluate(`document.querySelector('.new-session-composer [aria-label="Create session"]').click()`)
    await wait(page, `!!document.querySelector('.new-session__outcome--unknown')`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session-composer .composer__attachment-name')?.textContent??''`)).toBe("scope.txt")
  } finally { await page.close() }
}, 60_000)

test("a completed two-step response leaves the visible composer able to admit two fresh drafts without refresh", async () => {
  const page = await browser.openPage()
  try {
    await open(page, "promptOutcome=hold")
    await page.evaluate(`window.responseSnapshot([{id:'msg_completed_one',type:'assistant',agent:'GSD',model:{providerID:'openai',modelID:'gpt-6'},content:[{type:'text',text:'First completed step'}],time:{created:1,completed:2}},{id:'msg_completed_two',type:'assistant',agent:'GSD',model:{providerID:'openai',modelID:'gpt-6'},content:[{type:'text',text:'Second completed step'}],time:{created:3,completed:4}}],[],false)`)
    await wait(page, `window.responseStatus()==='idle'`)
    await page.evaluate(`(() => {const input=document.querySelector('.composer-resident .composer__input'); input.value='Scoped next prompt';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.composer-resident [aria-label="Send prompt"]').click()})()`)
    await wait(page, `window.remoteOperationReport().operations['session.prompt']===1`)
    expect(await page.evaluate<string>(`document.querySelector('.composer-resident .composer__input').value`)).toBe("")
    await page.evaluate(`(() => {const input=document.querySelector('.composer-resident .composer__input'); input.value='Independent next draft';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.composer-resident [aria-label="Send prompt"]').click()})()`)
    await wait(page, `window.remoteOperationReport().operations['session.prompt']===2`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-message__receipt[aria-label="Sending prompt"]').length`)).toBe(2)
    await page.evaluate(`window.remoteReleasePrompt('unknown');window.remoteReleasePrompt('ok')`)
    await wait(page, `!!document.querySelector('.transcript-message__receipt[aria-label="Outcome unknown"]')`)
    expect(await page.evaluate<boolean>(`document.querySelector('.composer-resident .composer__input').disabled`)).toBe(false)
    expect(await page.evaluate<number>(`window.remoteOperationReport().operations['session.prompt']`)).toBe(2)
  } finally { await page.close() }
}, 60_000)

test("completed output and snapshot refresh leave trusted typing, agent/model controls and navigation interactive", async () => {
  const page = await browser.openPage()
  const click = async (selector: string) => {
    const point = await page.evaluate<{ x: number; y: number; hit: boolean }>(`(() => {const target=document.querySelector(${JSON.stringify(selector)});const box=target.getBoundingClientRect();const x=box.x+box.width/2,y=box.y+box.height/2;return{x,y,hit:target.contains(document.elementFromPoint(x,y))}})()`)
    expect(point.hit).toBe(true)
    await page.mouse("mousePressed", point.x, point.y)
    await page.mouse("mouseReleased", point.x, point.y)
  }
  try {
    await page.setViewport(1440, 900)
    await open(page, "promptOutcome=hold")
    await page.evaluate(`window.remoteReadingTail('settle')`)
    await page.evaluate(`window.responseSnapshot([{id:'msg_completed_one',type:'assistant',agent:'GSD',content:[{type:'text',text:'First completed step'}],time:{created:1,completed:2}},{id:'msg_completed_two',type:'assistant',agent:'GSD',content:[{type:'text',text:'Second completed step'}],time:{created:3,completed:4}}],[],false)`)
    await wait(page, `window.responseStatus()==='idle'`)
    expect(await page.evaluate<number>(`document.querySelectorAll('dialog[open],.mini-picker__scrim').length`)).toBe(0)
    expect(await page.evaluate<boolean>(`document.querySelector('.composer-resident .composer__input').closest('[inert]')===null`)).toBe(true)
    await page.setViewport(390, 900)
    await frames(page, 2)
    await click('[aria-label="Open Team"]')
    await wait(page, `!!document.querySelector('dialog[open][aria-label="Team"]')`)
    await page.evaluate(`window.transcriptRefresh()`)
    await click('[aria-label="Close Team"]')
    await wait(page, `document.querySelector('dialog[aria-label="Team"]')===null`)
    await page.setViewport(1440, 900)
    await frames(page, 2)
    await click('.composer-resident .composer__input')
    await page.pressKey("x", "KeyX", 88, "x")
    expect(await page.evaluate<string>(`document.querySelector('.composer-resident .composer__input').value`)).toBe("x")
    await click('.composer-resident [aria-label="Agent"]')
    await wait(page, `!!document.querySelector('[role="listbox"][aria-label="Agent"]')`)
    await page.pressEscape()
    await wait(page, `document.querySelector('[role="listbox"][aria-label="Agent"]')===null`)
    await click('.composer-resident [aria-label="Model"]')
    await wait(page, `!!document.querySelector('[role="dialog"][aria-label="Reasoning effort"]')`)
    await click('[aria-label="Close model picker"]')
    await click('.remote-nav [href="/remote/sessions"]')
    await wait(page, `!!document.querySelector('.route-panel--active .sessions-page')`)
    await click('.remote-nav [href^="/remote/session?"]')
    await wait(page, `!!document.querySelector('.remote-conversation-view.route-panel--active')`)
    expect(await page.evaluate<string>(`document.querySelector('.composer-resident .composer__input').value`)).toBe("x")
  } finally { await page.close() }
}, 60_000)

test("Connected Sessions paints named loading content in the carousel and workspace rail until inventory settles", async () => {
  const page = await browser.openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(`${origin}/verify/remote.html?view=sessions&inventoryGate=1`)
    await wait(page, `document.querySelector('.sessions-page')!==null && document.querySelector('.workspace-nav')!==null`)
    expect(await page.evaluate<string>(`document.querySelector('.app-header__connection')?.textContent??document.querySelector('.connection-label')?.textContent??document.querySelector('.app-header').textContent`)).toContain("Connected")
    expect(await page.evaluate<number>(`document.querySelectorAll('.running-sessions [role="status"]').length`)).toBe(1)
    expect(await page.evaluate<number>(`document.querySelectorAll('.workspace-nav [role="status"]').length`)).toBe(1)
    await wait(page, `(() => {const node=document.querySelector('.running-sessions .loading-placeholder');return node!==null&&getComputedStyle(node).visibility==='visible'})()`)
    const before = await page.evaluate<number>(`document.querySelector('.sessions-page__content').getBoundingClientRect().top`)
    await page.evaluate(`window.remoteReleaseInventory()`)
    await wait(page, `document.querySelectorAll('.workspace-nav__item').length>0 && document.querySelectorAll('.running-sessions__item').length>0`)
    expect(await page.evaluate<number>(`Math.abs(document.querySelector('.sessions-page__content').getBoundingClientRect().top-${before})`)).toBeLessThanOrEqual(1)
    expect(await page.evaluate<number>(`document.querySelectorAll('.workspace-nav .loading-placeholder,.running-sessions .loading-placeholder').length`)).toBe(0)
  } finally { await page.close() }
}, 60_000)
