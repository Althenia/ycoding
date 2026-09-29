import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { officeLayout, pods, tileSize, worldHeight, worldWidth } from "../src/remote/office/map"
import { launchBrowser } from "./cdp"

const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chrome executable")

const port = 45_000 + Math.floor(Math.random() * 10_000)
const captures = mkdtempSync(join(tmpdir(), "ycoding-office-engine-"))
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })
  probe.stop(true)
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""), stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/office-engine.html`).then((response) => response.ok).catch(() => false)) break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
  console.log(`Office engine captures: ${captures}`)
})

function requireBrowser() {
  if (!browser) throw new Error("Browser did not start")
  return browser
}

function url(state = "tool", suffix = "") {
  return `http://127.0.0.1:${port}/verify/office-engine.html?state=${state}&inspectEngine=1${suffix}`
}

async function waitFor(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Office fixture did not settle: ${expression}`)
}

async function advance(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>, steps: number) {
  await page.evaluate<void>(`(() => {const scene=window.__officeGame.scene.getScene('office');for(let step=0;step<${steps};step++)scene.update(performance.now()+step*50,50)})()`)
}

test("compact canvas names leave the role in the roster and characters lead their name plates", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(url("tool", "&workspace=1&team=multi&cue=0&freeCamera=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===3")
    const actors = await page.evaluate<readonly { readonly name: string; readonly label: string; readonly role: string; readonly roster: string; readonly characterHeight: number; readonly labelHeight: number }[]>(`(() => {
      const scene=window.__officeGame.scene.getScene('office'),zoom=scene.cameras.main.zoom/scene.resolution;
      return scene.latestFrames.map(frame=>{const objects=scene.objects.get(frame.actor.id);return {name:frame.actor.name,label:objects.label.text,role:frame.actor.role,roster:document.querySelector('.office-roster__row[data-session-id="'+frame.actor.sessionID+'"] .office-roster__name').textContent,characterHeight:objects.sprite.displayHeight*zoom,labelHeight:objects.label.displayHeight*zoom}})
    })()`)
    for (const actor of actors) {
      expect(actor.label).toBe(actor.name)
      expect(actor.roster).toContain(actor.role)
      expect(actor.characterHeight).toBeGreaterThanOrEqual(actor.labelHeight * 2)
    }
  } finally { await page.close() }
}, 30_000)

test("renders one open floor for three widths and two themes through a multi-agent activity sequence", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument("window.__officeErrors=[];window.addEventListener('error',event=>window.__officeErrors.push(event.message));window.addEventListener('unhandledrejection',event=>window.__officeErrors.push(String(event.reason)))")
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await page.setViewport(width, height)
    await page.navigate(url("tool", "&workspace=1&team=multi&cue=0&freeCamera=1&sequence=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===3 && !document.querySelector('.office-notice[role=status]')")
    await page.evaluate<void>("document.querySelector('[aria-label=\"Fit office\"]').click()")
    await waitFor(page, "(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return Math.abs(camera.worldView.width-camera.width/camera.zoom)<1&&Math.abs(camera.worldView.height-camera.height/camera.zoom)<1})()")
    const controls = await page.evaluate<readonly { readonly name: string; readonly width: number; readonly height: number }[]>("[...document.querySelectorAll('.office-camera-controls button')].map(button=>({name:button.getAttribute('aria-label'),width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))")
    expect(controls.map((button) => button.name)).toEqual(["Zoom in", "Zoom out", "Fit office", "Follow selected", "Back to conversation"])
    expect(controls.every((button) => button.width >= 44 && button.height >= 44)).toBe(true)
    expect(await page.evaluate<number>("document.querySelectorAll('.office-canvas-host canvas').length")).toBe(1)
    expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true)
    for (const [theme, activities] of [["light", ["research", "coordinate", "implement"]], ["dark", ["verify", "implement", "coordinate"]]] as const) {
      await page.evaluate<void>(`document.documentElement.dataset.theme='${theme}'`)
      await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Next activities')?.click()")
      await advance(page, 90)
      const state = await page.evaluate<{ readonly rooms: readonly string[]; readonly positions: readonly { readonly x: number; readonly y: number }[]; readonly zoom: number; readonly fit: number; readonly ratio: number; readonly labels: number; readonly bounds: readonly number[] }>(`(() => {const scene=window.__officeGame.scene.getScene('office'),camera=scene.cameras.main,canvas=document.querySelector('.office-canvas-host canvas');return {
        rooms:scene.latestFrames.map(frame=>frame.room),positions:scene.latestFrames.map(frame=>({x:Math.floor(frame.position.x/32),y:Math.floor(frame.position.y/32)})),zoom:camera.zoom,
        fit:Math.min(camera.width/${officeLayout.columns * tileSize},camera.height/${officeLayout.rows * tileSize}),ratio:canvas.width/canvas.getBoundingClientRect().width,
        labels:[...scene.objects.values()].filter(object=>object.label.visible&&object.label.text).length,
        bounds:[camera.worldView.left,camera.worldView.top,camera.worldView.right,camera.worldView.bottom]}})()`)
      expect(state.rooms.every((room) => room === "block")).toBe(true)
      expect(new Set(state.positions.map((point) => `${point.x},${point.y}`)).size).toBe(3)
      expect(state.positions.every((point, index) => point.x >= pods[index]!.left && point.x <= pods[index]!.right && point.y >= pods[index]!.top && point.y <= pods[index]!.bottom)).toBe(true)
      expect(state.positions).toEqual(activities.map((activity, index) => pods[index]!.spots[activity].cell))
      expect(state.zoom).toBeCloseTo(state.fit, 2)
      expect(state.bounds[0]!).toBeLessThanOrEqual(0.000001)
      expect(state.bounds[1]!).toBeLessThanOrEqual(0.000001)
      expect(state.bounds[2]!).toBeGreaterThanOrEqual(officeLayout.columns * tileSize - 0.000001)
      expect(state.bounds[3]!).toBeGreaterThanOrEqual(officeLayout.rows * tileSize - 0.000001)
      expect(state.ratio).toBeGreaterThanOrEqual(1)
      expect(state.labels).toBeGreaterThanOrEqual(3)
      const overlays = await page.evaluate<{ readonly bubbles: readonly { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }[]; readonly labels: readonly { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }[] }>(`(() => {const scene=window.__officeGame.scene.getScene('office'),scale=scene.resolution/scene.cameras.main.zoom;return {
        bubbles:[...scene.objects.values()].filter(object=>object.bubble.visible).map(object=>({left:object.bubble.x-(object.bubble.displayWidth+18*scale)/2,right:object.bubble.x+(object.bubble.displayWidth+18*scale)/2,top:object.bubble.y-object.bubble.displayHeight-10*scale,bottom:object.bubble.y})),
        labels:[...scene.objects.values()].filter(object=>object.label.visible).map(object=>({left:object.label.x-19*scale,right:object.label.x+object.label.displayWidth+9*scale,top:object.label.y-4*scale,bottom:object.label.y+object.label.displayHeight+4*scale}))}})()`)
      const disjoint = (first: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }, second: typeof first) =>
        first.right <= second.left || first.left >= second.right || first.bottom <= second.top || first.top >= second.bottom
      if (width >= 1024) {
        expect(overlays.bubbles.every((bubble, index) => overlays.bubbles.slice(index + 1).every((next) => disjoint(bubble, next)))).toBe(true)
        expect(overlays.labels.every((label) => overlays.bubbles.every((bubble) => disjoint(label, bubble)))).toBe(true)
      }
      await Bun.sleep(350)
      const capture = join(captures, `${width}x${height}-${theme}-team.png`)
      await Bun.write(capture, Buffer.from(await page.screenshot(), "base64"))
      expect((await Bun.file(capture).arrayBuffer()).byteLength).toBeGreaterThan(12_000)
    }
    expect(await page.evaluate<string[]>("window.__officeErrors")).toEqual([])
    expect(page.networkFailures()).toEqual([])
  }
  await page.close()
}, 120_000)

test("Office opens at a readable working scale and Fit shows the entire floor", async () => {
  const page = await requireBrowser().openPage()
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await page.setViewport(width, height)
    await page.navigate(url("tool", "&freeCamera=1&workspace=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===1")
    await waitFor(page, "window.__officeGame.scene.getScene('office').cameras.main.worldView.width>0")
    const opening = await page.evaluate<{ readonly zoom: number; readonly cover: number; readonly bounds: readonly number[] }>(`(() => {const scene=window.__officeGame.scene.getScene('office'),camera=scene.cameras.main;return {zoom:camera.zoom/scene.resolution,cover:Math.max(camera.width/${worldWidth},camera.height/${worldHeight})/scene.resolution,bounds:[camera.worldView.left,camera.worldView.top,camera.worldView.right,camera.worldView.bottom]}})()`)
    expect(opening.zoom).toBeGreaterThanOrEqual(0.65)
    expect(opening.zoom).toBeGreaterThanOrEqual(opening.cover)
    expect(opening.bounds[0]!).toBeGreaterThanOrEqual(-1)
    expect(opening.bounds[1]!).toBeGreaterThanOrEqual(-1)
    expect(opening.bounds[2]!).toBeLessThanOrEqual(worldWidth + 1)
    expect(opening.bounds[3]!).toBeLessThanOrEqual(worldHeight + 1)
    await page.evaluate<void>("document.querySelector('[aria-label=\"Fit office\"]').click()")
    const measure = `(()=>{const scene=window.__officeGame.scene.getScene('office'),camera=scene.cameras.main,host=document.querySelector('.office-engine-host').getBoundingClientRect(),stage=document.querySelector('.office-workspace').getBoundingClientRect();return {zoom:camera.zoom,fit:Math.min(camera.width/${worldWidth},camera.height/${worldHeight}),hostBottom:host.bottom,stageBottom:stage.bottom,stageHeight:stage.height,canvasWidth:document.querySelector('canvas').width,cssWidth:document.querySelector('canvas').getBoundingClientRect().width}})()`
    const before = await page.evaluate<{ readonly zoom: number; readonly fit: number; readonly hostBottom: number; readonly stageBottom: number; readonly stageHeight: number; readonly canvasWidth: number; readonly cssWidth: number }>(measure)
    expect(before.zoom).toBeCloseTo(before.fit, 2)
    if (width !== 390) expect(before.stageBottom).toBeCloseTo(before.hostBottom, 0)
    else expect(before.stageBottom).toBeGreaterThanOrEqual(before.hostBottom)
    expect(before.stageHeight).toBeGreaterThanOrEqual(width === 390 ? 280 : 320)
    expect(before.canvasWidth / before.cssWidth).toBeGreaterThanOrEqual(0.99)
    await page.evaluate<void>("document.querySelector('button[aria-label=\"Zoom in\"]')?.click()")
    expect((await page.evaluate<typeof before>(measure)).zoom).toBeGreaterThan(before.zoom)
    await page.evaluate<void>("document.querySelector('button[aria-label=\"Fit office\"]')?.click()")
    expect((await page.evaluate<typeof before>(measure)).zoom).toBeCloseTo(before.fit, 2)
  }
  await page.close()
}, 60_000)

test("tablet and desktop Office fill the shell below header and status with no page scroll", async () => {
  const page = await requireBrowser().openPage()
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180]] as const) {
    await page.setViewport(width, height)
    await page.navigate(url("tool", "&shell=1&team=multi&freeCamera=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===3")
    const geometry = await page.evaluate<{ readonly scroll: number; readonly viewport: number; readonly panelBottom: number; readonly stageBottom: number; readonly scrollBottom: number; readonly hostBottom: number; readonly canvasHeight: number }>(`(() => {const box=(selector)=>document.querySelector(selector).getBoundingClientRect();return {
      scroll:document.documentElement.scrollHeight,viewport:innerHeight,panelBottom:box('.route-panel').bottom,
      stageBottom:box('.office-workspace').bottom,scrollBottom:box('.workspace__scroll').bottom,hostBottom:box('.office-canvas-host').bottom,
      canvasHeight:box('.office-canvas-host').height}})()`)
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport + 1)
    expect(geometry.stageBottom).toBeCloseTo(geometry.scrollBottom - 32, 0)
    expect(geometry.panelBottom).toBeCloseTo(geometry.stageBottom, 0)
    expect(geometry.canvasHeight).toBeGreaterThan(200)
    expect(geometry.canvasHeight).toBeGreaterThan((geometry.scrollBottom - 96) * 0.4)
    if (width >= 1024) expect(Math.abs(geometry.hostBottom - geometry.stageBottom)).toBeLessThanOrEqual(1)
  }
  await page.close()
}, 60_000)

test("DPR two and a live resize preserve crisp canvas backing size and whole-floor fit", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument("Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:()=>2})")
  await page.setViewport(1024, 768)
  await page.navigate(url("tool", "&workspace=1&freeCamera=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===1")
  await page.evaluate<void>("document.querySelector('[aria-label=\"Fit office\"]').click()")
  const measure = `(()=>{const canvas=document.querySelector('canvas'),camera=window.__officeGame.scene.getScene('office').cameras.main;return {ratio:canvas.width/canvas.getBoundingClientRect().width,zoom:camera.zoom,fit:Math.min(camera.width/${worldWidth},camera.height/${worldHeight})}})()`
  const before = await page.evaluate<{ readonly ratio: number; readonly zoom: number; readonly fit: number }>(measure)
  expect(before.ratio).toBeGreaterThan(1.9)
  expect(before.ratio).toBeLessThanOrEqual(2.1)
  expect(before.zoom).toBeCloseTo(before.fit, 2)
  await page.setViewport(1440, 900)
  await waitFor(page, `Math.abs((${measure}).fit-${before.fit})>0.01`)
  const after = await page.evaluate<typeof before>(measure)
  expect(after.ratio).toBeGreaterThan(1.9)
  expect(after.ratio).toBeLessThanOrEqual(2.1)
  expect(after.zoom).toBeCloseTo(after.fit, 2)
  await page.setViewport(1024, 768)
  await waitFor(page, `Math.abs((${measure}).fit-${after.fit})>0.01`)
  const returned = await page.evaluate<typeof before>(measure)
  expect(returned.zoom).toBeCloseTo(returned.fit, 2)
  await page.close()
}, 30_000)

test("delegation and report bubbles occur inside each character's own block without travel", async () => {
  const page = await requireBrowser().openPage()
  for (const kind of ["delegate", "report"] as const) {
    await page.navigate(url("tool", `&team=1&cue=0&cueKind=${kind}&freeCamera=1`))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===2")
    const initial = await page.evaluate<readonly { readonly x: number; readonly y: number }[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.position)")
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
    await waitFor(page, `window.__officeGame.scene.getScene('office').latestFrames.some(frame=>frame.speech==='${kind}')`)
    const spoken = await page.evaluate<readonly string[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.speech)")
    expect(spoken).toContain(kind === "delegate" ? "delegate" : "report")
    expect(await page.evaluate<readonly { readonly x: number; readonly y: number }[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.position)")).toEqual(initial)
    await advance(page, 80)
    expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').latestFrames.every(frame=>frame.room==='block'&&!frame.moving)")).toBe(true)
  }
  await page.close()
}, 45_000)

test("roster preserves identity and selection across live activity updates", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&cue=0&workspace=1&snapshots=1"))
  await waitFor(page, "document.querySelectorAll('.office-roster__row').length===2&&window.__officeGame?.scene.getScene('office').objects.size===2")
  const result = await page.evaluate<{ readonly sameRows: boolean; readonly sameSprites: boolean; readonly names: readonly string[]; readonly locations: readonly string[] }>(`(async () => {
    const rows=[...document.querySelectorAll('.office-roster__row')],scene=window.__officeGame.scene.getScene('office');
    const sprites=new Map([...scene.objects].map(([id,objects])=>[id,objects.sprite]));
    for(let i=0;i<4;i++){[...document.querySelectorAll('button')].find(button=>button.textContent==='Refresh snapshot').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
    return {sameRows:rows.every(row=>document.querySelector('.office-roster__row[data-session-id="'+row.dataset.sessionId+'"]')===row),sameSprites:[...sprites].every(([id,sprite])=>scene.objects.get(id)?.sprite===sprite),
      names:rows.map(row=>row.querySelector('.office-roster__name').textContent),locations:rows.map(row=>row.querySelector('.office-roster__room').textContent)}})()`)
  expect(result.sameRows).toBe(true)
  expect(result.sameSprites).toBe(true)
  expect(new Set(result.names).size).toBe(2)
  expect(result.locations).toEqual(["Agent block", "Agent block"])
  await page.evaluate<void>("document.querySelector('.office-roster__row[data-session-id=\"session-b\"]')?.click()")
  await waitFor(page, "document.querySelector('#selected-session')?.textContent==='session-b'&&document.querySelector('.office-roster__row[data-session-id=\"session-b\"]')?.getAttribute('aria-current')==='true'")
  await page.close()
}, 45_000)

test("arrivals and departures use the perimeter, and reduced motion settles without travel", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&arrival=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===1")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle arriving session')?.click()")
  await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.length===2")
  const entrance = await page.evaluate<{ readonly x: number; readonly y: number }>("(()=>{const frame=window.__officeGame.scene.getScene('office').latestFrames.find(frame=>frame.actor.sessionID==='session-new');return {x:Math.floor(frame.position.x/32),y:Math.floor(frame.position.y/32)}})()")
  expect(entrance).toEqual(officeLayout.door)
  await advance(page, 500)
  expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').latestFrames.find(frame=>frame.actor.sessionID==='session-new')?.room==='block'")).toBe(true)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle arriving session')?.click()")
  await advance(page, 650)
  expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').latestFrames.some(frame=>frame.actor.sessionID==='session-new')")).toBe(false)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
  const still = await page.evaluate<readonly { readonly x: number; readonly y: number }[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.position)")
  await advance(page, 300)
  expect(await page.evaluate<readonly { readonly x: number; readonly y: number }[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.position)")).toEqual(still)
  await page.close()
}, 45_000)

test("graphics context loss reports recovery, and canvas fallback still renders", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument("(() => {const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(String(type).includes('webgl'))return null;return original.call(this,type,...args)}})()")
  await page.navigate(url("tool"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===1")
  expect(await page.evaluate<number>("document.querySelectorAll('.office-canvas-host canvas').length")).toBe(1)
  await page.evaluate<void>("document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost'))")
  await waitFor(page, "!!document.querySelector('.office-notice[role=alert]')")
  expect(await page.evaluate<string>("document.querySelector('.office-notice[role=alert]').textContent")).toContain("Return to the normal workspace")
  await page.close()
}, 30_000)

test("fifty mount cycles release canvases, observers, visibility and media listeners", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument(`(() => {
    window.__officeErrors=[];window.addEventListener('error',event=>window.__officeErrors.push(event.message));
    window.__officeResources={visibility:0,observers:0,media:0};
    const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
    document.addEventListener=function(type,...args){if(type==='visibilitychange')window.__officeResources.visibility++;return add(type,...args)};
    document.removeEventListener=function(type,...args){if(type==='visibilitychange')window.__officeResources.visibility--;return remove(type,...args)};
    const Original=window.ResizeObserver;
    window.ResizeObserver=class extends Original {constructor(callback){super(callback);window.__officeResources.observers++}disconnect(){super.disconnect();window.__officeResources.observers--}};
    const addMedia=MediaQueryList.prototype.addEventListener,removeMedia=MediaQueryList.prototype.removeEventListener;
    MediaQueryList.prototype.addEventListener=function(type,...args){if(type==='change')window.__officeResources.media++;return addMedia.call(this,type,...args)};
    MediaQueryList.prototype.removeEventListener=function(type,...args){if(type==='change')window.__officeResources.media--;return removeMedia.call(this,type,...args)};
  })()`)
  await page.navigate(url("tool", "&mounted=0"))
  await page.evaluate<void>(`(async()=>{for(let i=0;i<50;i++){
    [...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click();
    await new Promise(resolve=>setTimeout(resolve,5));
    [...document.querySelectorAll('button')].find(button=>button.textContent==='Unmount office')?.click();
    await new Promise(resolve=>setTimeout(resolve,5));
  }})()`)
  await Bun.sleep(500)
  expect(await page.evaluate<number>("document.querySelectorAll('canvas').length")).toBe(0)
  expect(await page.evaluate<{ readonly visibility: number; readonly observers: number; readonly media: number }>("window.__officeResources")).toEqual({ visibility: 0, observers: 0, media: 0 })
  expect(await page.evaluate<string[]>("window.__officeErrors")).toEqual([])
  await page.close()
}, 60_000)

test("the frame cap stays 30 or 20 at mount, and a zero-size host recovers without stealing keyboard input", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("attention", "&mounted=0"))
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Zero size')?.click()")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click()")
  await waitFor(page, "!!document.querySelector('canvas') && !document.querySelector('.office-notice[role=status]')")
  expect(await page.evaluate<number>("document.querySelector('canvas')?.height")).toBe(1)
  expect(await page.evaluate<string>("document.documentElement.dataset.officeFps")).toBe("30")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Restore size')?.click()")
  await waitFor(page, "document.querySelector('canvas')?.height>100")
  await page.evaluate<void>("(()=>{const input=document.querySelector('input[aria-label*=Typing]');input.value='agent';input.focus();input.setSelectionRange(0,0)})()")
  await page.pressKey("ArrowRight", "ArrowRight", 39)
  expect(await page.evaluate<number>("document.querySelector('input[aria-label*=Typing]')?.selectionStart")).toBe(1)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle quality')?.click()")
  expect(await page.evaluate<string>("document.documentElement.dataset.officeFps")).toBe("30")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Unmount office')?.click()")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click()")
  await waitFor(page, "document.documentElement.dataset.officeFps==='20'")
  await page.close()
}, 30_000)

test("missing assets or a lazy engine chunk report failure and offer a normal view", async () => {
  const assetPage = await requireBrowser().openPage()
  await assetPage.injectOnNewDocument(`(() => {window.__imageAttempts=0;const open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url,...rest){if(String(url).includes('characters.png')){window.__imageAttempts++;return open.call(this,method,'/missing-office-asset.png',...rest)}return open.call(this,method,url,...rest)};
  })()`)
  await assetPage.navigate(url("idle"))
  await waitFor(assetPage, "!!document.querySelector('.office-notice[role=alert]')")
  expect(await assetPage.evaluate<string>("document.querySelector('.office-notice[role=alert]').textContent")).toContain("asset failed to load")
  expect(await assetPage.evaluate<number>("window.__imageAttempts")).toBe(1)
  await Bun.sleep(300)
  expect(await assetPage.evaluate<number>("window.__imageAttempts")).toBe(1)
  await assetPage.evaluate<void>("document.querySelector('.office-notice[role=alert] button')?.click()")
  expect(await assetPage.evaluate<number>("document.querySelectorAll('canvas').length")).toBe(0)
  await assetPage.close()

  const chunkPage = await requireBrowser().openPage()
  await chunkPage.blockURLs(["*create-game*"])
  await chunkPage.navigate(url("idle", "&mounted=0"))
  await chunkPage.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click()")
  await waitFor(chunkPage, "!!document.querySelector('.office-notice[role=alert]')")
  expect(await chunkPage.evaluate<string>("document.querySelector('.office-notice[role=alert]').textContent")).toContain("could not start")
  await chunkPage.evaluate<void>("document.querySelector('.office-notice[role=alert] button')?.click()")
  expect(await chunkPage.evaluate<number>("document.querySelectorAll('canvas').length")).toBe(0)
  await chunkPage.close()
}, 60_000)

test("clicking a character selects its Session while camera dragging does not", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===2")
  await page.evaluate<void>("(()=>{const scene=window.__officeGame.scene.getScene('office'),sprite=scene.children.list.find(object=>object.type==='Sprite'&&object.name==='[\"fixture-device\",\"session-b\"]');scene.followSuspended=true;scene.cameras.main.centerOn(sprite.x,sprite.y)})()")
  const selected = await page.evaluate<string>(`(() => {
    const scene=window.__officeGame.scene.getScene('office'),sprite=scene.children.list.find(object=>object.type==='Sprite'&&object.name==='["fixture-device","session-b"]');
    const canvas=document.querySelector('canvas'),rect=canvas.getBoundingClientRect(),point=scene.cameras.main.matrixCombined.transformPoint(sprite.x,sprite.y-14);
    const x=rect.left+point.x*rect.width/canvas.width,y=rect.top+point.y*rect.height/canvas.height;
    for(const type of ['mousedown','mouseup'])canvas.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,buttons:type==='mousedown'?1:0}));
    return document.querySelector('#selected-session')?.textContent;
  })()`)
  expect(selected).toBe("session-b")
  for (let index = 0; index < 3; index++) await page.evaluate<void>("document.querySelector('[aria-label=\"Zoom in\"]')?.click()")
  const before = await page.evaluate<{ readonly x: number; readonly y: number }>("(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return{x:camera.scrollX,y:camera.scrollY}})()")
  await page.evaluate<void>(`(() => {const canvas=document.querySelector('canvas'),rect=canvas.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    canvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:x,clientY:y,button:0,buttons:1}));
    canvas.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x+120,clientY:y+45,button:0,buttons:1}));
    canvas.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:x+120,clientY:y+45,button:0,buttons:0}));})()`)
  expect(await page.evaluate<string>("document.querySelector('#selected-session')?.textContent")).toBe("session-b")
  const after = await page.evaluate<{ readonly x: number; readonly y: number }>("(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return{x:camera.scrollX,y:camera.scrollY}})()")
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(1)
  await page.close()
}, 30_000)
