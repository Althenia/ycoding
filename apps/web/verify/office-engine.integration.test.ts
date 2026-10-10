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

test("shared-floor crossings paint walk and yield frames without overlap and settle at 20 and 30 FPS", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.navigate(url("tool", "&freeCamera=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===1")
    for (const fps of [20, 30]) for (const corridor of ["central", "widened"]) {
      const evidence = await page.evaluate<{ readonly minimum: number; readonly aligned: boolean; readonly walking: boolean; readonly yielding: boolean; readonly frameChanges: boolean; readonly arrived: boolean; readonly speech: boolean; readonly reducedDirect: boolean }>(`(async () => {
        const {OfficeDirector}=await import('/src/remote/office/director.ts');
        const {officeLayout}=await import('/src/remote/office/map.ts');
        const {actor,snapshot}=await import('/src/remote/office/layout.test-helper.ts');
        const game=window.__officeGame,scene=game.scene.getScene('office');game.loop.stop();
        const cells=${JSON.stringify(corridor === "central" ? [{ x: 25, y: 17 }, { x: 24, y: 17 }] : [{ x: 9, y: 13 }, { x: 9, y: 12 }])};
        const layout={...officeLayout,lounge:cells.map(cell=>({cell,facing:'up',pose:'play',leisure:'table'}))};
        scene.director=new OfficeDirector(layout);
        const workers=Array.from({length:14},(_,index)=>index===0||index===13?actor(index===0?'a':'b',{status:'idle'}):actor('stationary-'+index,{source:'unavailable'}));
        const input={...scene.mailbox.read(),preferences:{...scene.mailbox.read().preferences,motion:'system'}};
        scene.mailbox.update({...input,snapshot:snapshot(workers)});scene.update(0,0);
        scene.mailbox.update({...input,snapshot:snapshot(workers.map(worker=>({...worker,status:'working',activity:'research'})))});
        let minimum=Infinity,aligned=true,walking=false,yielding=false,speech=false;
        const painted=new Map();
        for(let tick=0;tick<${fps * 30};tick++){
          scene.update(tick*${1_000 / fps},${1_000 / fps});
          const frames=scene.latestFrames.filter(frame=>frame.actor.source==='projection');
          const sprites=frames.map(frame=>scene.objects.get(frame.actor.id).sprite);
          minimum=Math.min(minimum,Math.hypot(sprites[0].x-sprites[1].x,sprites[0].y-sprites[1].y));
          frames.forEach((frame,index)=>{
            const sprite=sprites[index];sprite.preUpdate(tick*${1_000 / fps},${1_000 / fps});
            aligned&&=sprite.x===Math.round(frame.position.x)&&sprite.y===Math.round(frame.position.y);
            walking||=frame.moving&&sprite.anims.currentAnim?.key.endsWith('-walk');
            yielding||=!frame.moving&&frame.pose==='stand'&&sprite.anims.currentAnim?.key.endsWith('-stand');
            speech||=frame.speech!==undefined;
            const names=painted.get(frame.actor.id)??new Set();names.add(String(sprite.frame.name));painted.set(frame.actor.id,names);
          });
        }
        const frames=scene.latestFrames.filter(frame=>frame.actor.source==='projection');
        const arrived=frames.every((frame,index)=>!frame.moving&&frame.pose==='read'&&frame.direction===officeLayout.pods[index===0?0:13].spots.research.facing&&Math.floor(frame.position.x/32)===officeLayout.pods[index===0?0:13].spots.research.cell.x&&Math.floor(frame.position.y/32)===officeLayout.pods[index===0?0:13].spots.research.cell.y);
        scene.director=new OfficeDirector(layout);
        scene.mailbox.update({...input,snapshot:snapshot(workers)});scene.update(0,0);
        scene.mailbox.update({...input,snapshot:snapshot(workers.map(worker=>({...worker,status:'working',activity:'research'})))});scene.update(50,50);
        scene.mailbox.update({...scene.mailbox.read(),preferences:{...input.preferences,motion:'reduced'}});scene.update(100,50);
        const still=scene.latestFrames.filter(frame=>frame.actor.source==='projection').map(frame=>({...frame.position,frame:String(scene.objects.get(frame.actor.id).sprite.frame.name)}));
        for(let tick=0;tick<20;tick++)scene.update(150+tick*50,50);
        const reducedDirect=scene.latestFrames.filter(frame=>frame.actor.source==='projection').every((frame,index)=>!frame.moving&&frame.pose==='read'&&frame.position.x===still[index].x&&frame.position.y===still[index].y&&Math.floor(frame.position.x/32)===officeLayout.pods[index===0?0:13].spots.research.cell.x&&Math.floor(frame.position.y/32)===officeLayout.pods[index===0?0:13].spots.research.cell.y&&String(scene.objects.get(frame.actor.id).sprite.frame.name)===still[index].frame&&!scene.objects.get(frame.actor.id).sprite.anims.isPlaying);
        return {minimum,aligned,walking,yielding,speech,reducedDirect,frameChanges:[...painted.values()].every(names=>names.size>1),arrived};
      })()`)
      expect(evidence.minimum).toBeGreaterThanOrEqual(31)
      expect(evidence.aligned).toBe(true)
      expect(evidence.walking).toBe(true)
      expect(evidence.yielding).toBe(true)
      expect(evidence.frameChanges).toBe(true)
      expect(evidence.arrived).toBe(true)
      expect(evidence.speech).toBe(false)
      expect(evidence.reducedDirect).toBe(true)
    }
  } finally { await page.close() }
}, 45_000)

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
    await page.evaluate<void>(`(() => {document.querySelector('.app > div')?.classList.add('status-strip');document.querySelector('.workspace__main').style.gridArea='workspace'})()`)
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
    await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.every(frame=>!frame.moving)")
    const initial = await page.evaluate<readonly { readonly x: number; readonly y: number; readonly direction: string }[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>({...frame.position,direction:frame.direction}))")
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
    await waitFor(page, `window.__officeGame.scene.getScene('office').latestFrames.some(frame=>frame.speech==='${kind}')`)
    const spoken = await page.evaluate<readonly (string | undefined)[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.speech)")
    expect(spoken).toContain(kind === "delegate" ? "delegate" : "report")
    const current = await page.evaluate<readonly { readonly x: number; readonly y: number; readonly direction: string }[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>({...frame.position,direction:frame.direction}))")
    expect(current.map(({ x, y }) => ({ x, y }))).toEqual(initial.map(({ x, y }) => ({ x, y })))
    const from = current[kind === "delegate" ? 0 : 1]!
    const to = current[kind === "delegate" ? 1 : 0]!
    expect(from.direction).toBe(from.x === to.x ? from.y < to.y ? "down" : "up" : from.x < to.x ? "right" : "left")
    expect(to.direction).toBe(to.x === from.x ? to.y < from.y ? "down" : "up" : to.x < from.x ? "right" : "left")
    expect(await page.evaluate<boolean>(`(() => {const scene=window.__officeGame.scene.getScene('office'),target=scene.latestFrames.find(frame=>frame.actor.sessionID===${JSON.stringify(kind === "delegate" ? "session-b" : "session-a")}),objects=scene.objects.get(target.actor.id);return scene.badge.visible&&scene.badge.text===${JSON.stringify(kind === "delegate" ? "Delegated" : "Reported")}&&scene.badge.y<objects.bubble.y-objects.bubble.displayHeight})()`)).toBe(true)
    expect(await page.evaluate<boolean>("(() => {const scene=window.__officeGame.scene.getScene('office'),ids=new Set(scene.latestFrames.map(frame=>frame.actor.id));return scene.latestFrames.every(frame=>ids.has(frame.actor.id))})()")).toBe(true)
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

const frameSummary = `window.__officeGame.scene.getScene('office').latestFrames.map(frame=>({id:frame.actor.sessionID,pose:frame.pose,direction:frame.direction,room:frame.room,moving:frame.moving,cell:{x:Math.floor(frame.position.x/32),y:Math.floor(frame.position.y/32)}}))`

test("Office mouse cursors follow shared floor/action/panning roles and restore after release, exit and disposal", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.navigate(url("tool", "&team=1"))
    await page.evaluate(`import('/src/styles/base.css')`)
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===2")
    await page.evaluate(`(() => { const scene=window.__officeGame.scene.getScene('office'); const sprite=[...scene.objects.values()][1].sprite; scene.followSuspended=true; scene.cameras.main.centerOn(sprite.x,sprite.y); })()`)
    await Bun.sleep(60)
    const points = await page.evaluate<{ readonly actor: { readonly x: number; readonly y: number }; readonly floor: { readonly x: number; readonly y: number }; readonly outside: { readonly x: number; readonly y: number } }>(`(() => { const scene=window.__officeGame.scene.getScene('office'); const sprite=[...scene.objects.values()][1].sprite; const canvas=document.querySelector('.office-canvas-host canvas'); const r=canvas.getBoundingClientRect(); const p=scene.cameras.main.matrixCombined.transformPoint(sprite.x,sprite.y-14); return {actor:{x:r.left+p.x*r.width/canvas.width,y:r.top+p.y*r.height/canvas.height},floor:{x:r.left+10,y:r.bottom-10},outside:{x:r.left+10,y:r.top-10}}; })()`)
    await page.mouse("mouseMoved", points.floor.x, points.floor.y)
    await Bun.sleep(60)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.office-canvas-host canvas')).cursor`)).toBe("grab")
    await page.mouse("mouseMoved", points.actor.x, points.actor.y)
    await waitFor(page, `getComputedStyle(document.querySelector('.office-canvas-host canvas')).cursor === 'pointer'`)
    await page.mouse("mousePressed", points.actor.x, points.actor.y)
    await waitFor(page, `getComputedStyle(document.querySelector('.office-canvas-host canvas')).cursor === 'grabbing'`)
    expect(await page.evaluate<string>(`document.querySelector('canvas').style.cursor`)).toBe("var(--yc-cursor-action)")
    await page.mouse("mouseMoved", points.actor.x + 30, points.actor.y + 15, true)
    await waitFor(page, `getComputedStyle(document.querySelector('.office-canvas-host canvas')).cursor === 'grabbing'`)
    await page.mouse("mouseReleased", points.actor.x + 30, points.actor.y + 15)
    await waitFor(page, `document.querySelector('canvas').dataset.cursor === undefined`)
    expect(await page.evaluate<string>(`document.querySelector('#selected-session').textContent`)).toBe("session-a")
    const actor = await page.evaluate<{ readonly x: number; readonly y: number }>(`(() => { const scene=window.__officeGame.scene.getScene('office'); const sprite=[...scene.objects.values()][1].sprite; const canvas=document.querySelector('canvas'),r=canvas.getBoundingClientRect(),p=scene.cameras.main.matrixCombined.transformPoint(sprite.x,sprite.y-14); return {x:r.left+p.x*r.width/canvas.width,y:r.top+p.y*r.height/canvas.height}; })()`)
    await page.mouse("mouseMoved", actor.x, actor.y)
    await waitFor(page, `getComputedStyle(document.querySelector('canvas')).cursor === 'pointer'`)
    await page.mouse("mousePressed", actor.x, actor.y)
    await page.mouse("mouseReleased", actor.x, actor.y)
    await waitFor(page, `document.querySelector('#selected-session').textContent === 'session-b' && document.querySelector('canvas').dataset.cursor === undefined`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('canvas')).cursor`)).toBe("pointer")
    await page.mouse("mouseMoved", points.floor.x, points.floor.y)
    await waitFor(page, `getComputedStyle(document.querySelector('canvas')).cursor === 'grab'`)
    await page.mouse("mousePressed", points.floor.x, points.floor.y)
    await page.mouse("mouseMoved", points.outside.x, points.outside.y, true)
    await waitFor(page, `document.querySelector('canvas').dataset.cursor === undefined`)
    await page.mouse("mouseReleased", points.outside.x, points.outside.y)
    await page.mouse("mouseMoved", points.floor.x, points.floor.y)
    await waitFor(page, `getComputedStyle(document.querySelector('canvas')).cursor === 'grab'`)
    await page.mouse("mousePressed", points.floor.x, points.floor.y)
    await page.evaluate(`window.cursorCanvas=document.querySelector('canvas'); [...document.querySelectorAll('button')].find((button)=>button.textContent==='Unmount office').click()`)
    await waitFor(page, `document.querySelector('canvas') === null`)
    await waitFor(page, `window.cursorCanvas.dataset.cursor === undefined`)
    expect(await page.evaluate<string | null>(`window.cursorCanvas.dataset.cursor??null`)).toBeNull()
    await page.mouse("mouseReleased", points.floor.x, points.floor.y)
  } finally { await page.close() }
})

test("native touch cancellation clears Office panning without selecting or leaving a stuck role", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.setMobileViewport(390, 844)
    await page.navigate(url("tool"))
    await page.evaluate(`import('/src/styles/base.css')`)
    await waitFor(page, "window.__officeGame?.scene.getScene('office').objects.size>0")
    const point = await page.evaluate<{ readonly x: number; readonly y: number }>(`(() => {const r=document.querySelector('canvas').getBoundingClientRect();return{x:r.left+10,y:r.bottom-10}})()`)
    await page.touch("touchStart", point.x, point.y)
    await waitFor(page, `document.querySelector('canvas').dataset.cursor === 'panning'`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('canvas')).cursor`)).toBe("grabbing")
    await page.touch("touchCancel")
    await waitFor(page, `document.querySelector('canvas').dataset.cursor === undefined`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('canvas')).cursor`)).toBe("grab")
    expect(await page.evaluate<string>(`document.querySelector('#selected-session').textContent`)).toBe("session-a")
  } finally { await page.close() }
})
type FrameSummary = readonly { readonly id: string; readonly pose: string; readonly direction: string; readonly room: string | undefined; readonly moving: boolean; readonly cell: { readonly x: number; readonly y: number } }[]

async function openIdlePair(reduced = false) {
  const page = await requireBrowser().openPage()
  await page.setViewport(1440, 900)
  await page.navigate(url("idle", "&team=1&teamIdle=1&workspace=1&freeCamera=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===2")
  if (reduced) await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
  return page
}

test("idle agents play table tennis with a moving ball and visibly changing frames", async () => {
  const page = await openIdlePair()
  try {
    const frames = await page.evaluate<FrameSummary>(frameSummary)
    expect(frames.map((frame) => frame.cell)).toEqual([{ x: 14, y: 26 }, { x: 19, y: 26 }])
    expect(frames.map((frame) => frame.direction)).toEqual(["right", "left"])
    expect(frames.every((frame) => frame.pose === "play" && frame.room === "lounge" && !frame.moving)).toBe(true)
    const samples: { readonly frames: readonly string[]; readonly ball: number; readonly visible: boolean; readonly animation: readonly string[] }[] = []
    for (let step = 0; step < 18; step++) {
      samples.push(await page.evaluate<(typeof samples)[number]>(`(()=>{const scene=window.__officeGame.scene.getScene('office');return {frames:scene.latestFrames.map(frame=>String(scene.objects.get(frame.actor.id).sprite.frame.name)),ball:scene.ball.x,visible:scene.ball.visible,animation:scene.latestFrames.map(frame=>scene.objects.get(frame.actor.id).sprite.anims.currentAnim?.key??'')}})()`))
      await Bun.sleep(100)
    }
    expect(samples.every((sample) => sample.visible)).toBe(true)
    expect(new Set(samples.map((sample) => Math.round(sample.ball))).size).toBeGreaterThanOrEqual(8)
    expect(new Set(samples.map((sample) => sample.frames[0])).size).toBeGreaterThanOrEqual(2)
    expect(new Set(samples.map((sample) => sample.frames[1])).size).toBeGreaterThanOrEqual(2)
    expect(samples.every((sample) => sample.animation.every((key) => key.endsWith("-play")))).toBe(true)
    await page.evaluate<void>(`(()=>{const scene=window.__officeGame.scene.getScene('office');scene.followSuspended=true;scene.fitting=false;scene.desiredZoom=scene.resolution*3.2;scene.cameras.main.setZoom(scene.desiredZoom);scene.cameras.main.centerOn(544,858)})()`)
    await advance(page, 4)
    await Bun.sleep(300)
    const capture = join(captures, "table-tennis-play.png")
    await Bun.write(capture, Buffer.from(await page.screenshot(), "base64"))
    expect((await Bun.file(capture).arrayBuffer()).byteLength).toBeGreaterThan(12_000)
  } finally { await page.close() }
}, 30_000)

test("idle schedule paints coffee-facing and seated poses from existing frames", async () => {
  const page = await openIdlePair()
  try {
    const evidence = await page.evaluate<{ readonly coffee: boolean; readonly seated: boolean; readonly coffeeFrame: boolean; readonly seatedFrame: boolean; readonly labels: readonly string[] }>(`(() => {
      const scene=window.__officeGame.scene.getScene('office'),coffee=new Set(),seated=new Set(),labels=new Set();
      let coffeeFrame=false,seatedFrame=false;
      for(let tick=0;tick<10000;tick++){
        scene.update(tick*50,50);
        for(const frame of scene.latestFrames){
          const phase=scene.director.leisurePhase(frame.actor.id),cell={x:Math.floor(frame.position.x/32),y:Math.floor(frame.position.y/32)};
          if(phase?.kind==='pantry'&&frame.direction==='up'){coffee.add(cell.x+','+cell.y+':'+frame.pose);const sprite=scene.objects.get(frame.actor.id).sprite;coffeeFrame=sprite.texture.key==='characters'&&sprite.anims.currentAnim?.key.endsWith('-stand');}
          if(phase?.kind==='rest'&&frame.pose==='sit'){seated.add(cell.x+','+cell.y);const sprite=scene.objects.get(frame.actor.id).sprite;seatedFrame=sprite.texture.key==='characters'&&!sprite.anims.isPlaying;}
          if(frame.actor.bubble)labels.add(frame.actor.bubble);
        }
      }
      return {coffee:coffee.size>0,seated:seated.size>0,coffeeFrame,seatedFrame,labels:[...labels]};
    })()`)
    expect(evidence.coffee).toBe(true)
    expect(evidence.seated).toBe(true)
    expect(evidence.coffeeFrame).toBe(true)
    expect(evidence.seatedFrame).toBe(true)
    expect(evidence.labels).toEqual([])
  } finally { await page.close() }
}, 45_000)

test("idle gathering renders inward existing poses without a speech plate and disperses on work", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.navigate(url("idle", "&gathering=1&team=1&teamIdle=1&workspace=1&freeCamera=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===2")
    const result = await page.evaluate<{ readonly frames: readonly { readonly pose: string; readonly direction: string; readonly moving: boolean; readonly cell: { readonly x: number; readonly y: number } }[]; readonly bubbles: number; readonly animations: readonly string[] }>(`(() => {
      const scene=window.__officeGame.scene.getScene('office');
      for(let tick=0;tick<5000;tick++){scene.update(tick*50,50);if(scene.latestFrames.some(frame=>scene.director.gatheringPhase(frame.actor.id)?.stage==='talk'))break;}
      return {frames:scene.latestFrames.map(frame=>({pose:frame.pose,direction:frame.direction,moving:frame.moving,cell:{x:Math.floor(frame.position.x/32),y:Math.floor(frame.position.y/32)}})),
        bubbles:[...scene.objects.values()].filter(object=>object.bubble.visible).length,
        animations:scene.latestFrames.map(frame=>scene.objects.get(frame.actor.id).sprite.anims.currentAnim?.key??'')};
    })()`)
    expect(result.frames).toHaveLength(2)
    expect(result.frames.map((frame) => frame.cell)).toEqual([{ x: 28, y: 21 }, { x: 31, y: 21 }])
    expect(result.frames.map((frame) => frame.direction)).toEqual(["down", "down"])
    expect(result.frames.every((frame) => ["talk", "stand"].includes(frame.pose) && !frame.moving)).toBe(true)
    expect(new Set(result.frames.map((frame) => frame.pose))).toEqual(new Set(["talk", "stand"]))
    expect(result.animations.every((animation) => animation.endsWith("-talk") || animation.endsWith("-stand"))).toBe(true)
    expect(result.bubbles).toBe(0)
    await page.evaluate<void>(`(()=>{const select=document.querySelector('select[aria-label="Office state"]');select.value='tool';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.find(frame=>frame.actor.sessionID==='session-a')?.actor.status==='tool'")
    await advance(page, 1)
    const after = await page.evaluate<{ readonly stages: readonly string[]; readonly rootMoving: boolean; readonly rootStatus: string }>(`(() => {const scene=window.__officeGame.scene.getScene('office');return {
      stages:scene.latestFrames.map(frame=>scene.director.gatheringPhase(frame.actor.id)?.stage).filter(Boolean),
      rootMoving:scene.latestFrames.find(frame=>frame.actor.sessionID==='session-a').moving,
      rootStatus:scene.latestFrames.find(frame=>frame.actor.sessionID==='session-a').actor.status}})()`)
    expect(after.rootStatus).toBe("tool")
    expect(after.rootMoving).toBe(true)
    expect(after.stages).toEqual([])
    expect(await page.evaluate<boolean>("(()=>{const frame=window.__officeGame.scene.getScene('office').latestFrames.find(frame=>frame.actor.sessionID==='session-a');return frame.actor.bubble===frame.actor.statusText})()")).toBe(true)
  } finally { await page.close() }
}, 45_000)

test("any working or attention state ends play at once and removes the ball", async () => {
  for (const state of ["tool", "attention", "thinking"] as const) {
    const page = await openIdlePair()
    try {
      expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').ball.visible")).toBe(true)
      await page.evaluate<void>(`(()=>{const select=document.querySelector('select[aria-label="Office state"]');select.value='${state}';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await advance(page, 1)
      const frames = await page.evaluate<FrameSummary>(frameSummary)
      const root = frames.find((frame) => frame.id === "session-a")!
      expect(root.pose, state).not.toBe("play")
      expect(root.moving, state).toBe(true)
      expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').ball.visible"), state).toBe(false)
      expect(frames.find((frame) => frame.id === "session-b")!.pose, state).toBe("play")
    } finally { await page.close() }
  }
}, 45_000)

test("reduced motion shows fixed desk poses without leisure travel or ball", async () => {
  const page = await openIdlePair(true)
  try {
    await advance(page, 2)
    const frames = await page.evaluate<FrameSummary>(frameSummary)
    expect(frames.map((frame) => frame.pose)).toEqual(["sit", "sit"])
    expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').ball.visible")).toBe(false)
    const frameIDs = await page.evaluate<readonly string[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>String(window.__officeGame.scene.getScene('office').objects.get(frame.actor.id).sprite.frame.name))")
    const before = await page.evaluate<readonly number[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.position.x)")
    await advance(page, 40)
    expect(await page.evaluate<readonly number[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>frame.position.x)")).toEqual(before)
    expect(await page.evaluate<readonly string[]>("window.__officeGame.scene.getScene('office').latestFrames.map(frame=>String(window.__officeGame.scene.getScene('office').objects.get(frame.actor.id).sprite.frame.name))")).toEqual(frameIDs)
    expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').latestFrames.every(frame=>!window.__officeGame.scene.getScene('office').objects.get(frame.actor.id).sprite.anims.isPlaying)")).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("reduced motion holds the active type frame while the engine advances", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.navigate(url("tool", "&freeCamera=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===1")
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
    const before = await page.evaluate<string>("String(window.__officeGame.scene.getScene('office').objects.values().next().value.sprite.frame.name)")
    await advance(page, 40)
    expect(await page.evaluate<string>("String(window.__officeGame.scene.getScene('office').objects.values().next().value.sprite.frame.name)")).toBe(before)
    expect(await page.evaluate<boolean>("[...window.__officeGame.scene.getScene('office').objects.values()].every(objects=>!objects.sprite.anims.isPlaying)")).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("reduced-motion preference switches freeze and resume the current sprite pose", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.navigate(url("tool", "&freeCamera=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').latestFrames.length===1")
    const frameName = "String(window.__officeGame.scene.getScene('office').objects.values().next().value.sprite.frame.name)"
    await Bun.sleep(600)
    const animated = await page.evaluate<string>(frameName)
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
    await waitFor(page, "document.querySelector('#office-motion').textContent==='reduced'&&![...window.__officeGame.scene.getScene('office').objects.values()].some(objects=>objects.sprite.anims.isPlaying)")
    const fixed = await page.evaluate<string>(frameName)
    await page.evaluate<void>("(()=>{const scene=window.__officeGame.scene.getScene('office');for(let step=0;step<20;step++)scene.update(performance.now()+step*50,50)})()")
    expect(await page.evaluate<string>(frameName)).toBe(fixed)
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
    await waitFor(page, `(document.querySelector('#office-motion').textContent==='system'&&${frameName}!==${JSON.stringify(fixed)})`)
    expect(animated).not.toBe("")
  } finally { await page.close() }
}, 30_000)

const entranceSampler = `(()=>{window.__entrances=[];const tick=()=>{const scene=window.__officeGame?.scene.getScene('office');for(const frame of scene?.latestFrames??[]){const x=Math.floor(frame.position.x/32),y=Math.floor(frame.position.y/32);if(frame.moving||y>=37)window.__entrances.push({id:frame.actor.id,moving:frame.moving,x,y})}requestAnimationFrame(tick)};tick()})()`

test("initial loading is named over reserved geometry, then known members appear in place and reloads keep them", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(url("tool", "&team=multi&cue=0&hydrate=1&workspace=1&freeCamera=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').ready===true")
    await page.evaluate<void>(entranceSampler)
    const rect = `(()=>{const box=(selector)=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.left,r.top,r.width,r.height]};return {host:box('.office-canvas-host'),stage:box('.office-stage')}})()`
    await waitFor(page, "document.querySelector('.office-notice[role=status]')?.textContent==='Loading the office…' && getComputedStyle(document.querySelector('.loading-placeholder--office')).visibility==='visible'")
    const loading = await page.evaluate<{ readonly host: readonly number[]; readonly stage: readonly number[]; readonly frames: number; readonly placeholder: readonly number[] }>(`({...${rect},frames:window.__officeGame.scene.getScene('office').latestFrames.length,placeholder:(()=>{const r=document.querySelector('.loading-placeholder--office').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()})`)
    expect(loading.frames).toBe(0)
    expect(loading.placeholder[2]! * loading.placeholder[3]!).toBeGreaterThan(loading.host[2]! * loading.host[3]! * 0.8)
    expect(loading.placeholder[0]!).toBeGreaterThanOrEqual(loading.stage[0]!)
    expect(loading.placeholder[0]! + loading.placeholder[2]!).toBeLessThanOrEqual(loading.stage[0]! + loading.stage[2]! + 1)
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Settle inputs')?.click()")
    await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.length===3 && !document.querySelector('.office-notice[role=status]')")
    expect((await page.evaluate<typeof loading>(`({...${rect},frames:3,placeholder:[]})`)).host).toEqual(loading.host)
    const placed = await page.evaluate<FrameSummary>(frameSummary)
    expect(placed.every((frame) => !frame.moving)).toBe(true)
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Reload inputs')?.click()")
    await advance(page, 20)
    await Bun.sleep(400)
    expect(await page.evaluate<FrameSummary>(frameSummary)).toEqual(placed)
    expect(await page.evaluate<boolean>("!document.querySelector('.office-notice[role=status]') && window.__officeGame.scene.getScene('office').latestFrames.every(frame=>!frame.leaving)")).toBe(true)
    expect(await page.evaluate<readonly unknown[]>("window.__entrances")).toEqual([])
  } finally { await page.close() }
}, 45_000)

test("switching scope and returning shows the same members in place without an entrance", async () => {
  const page = await requireBrowser().openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(url("tool", "&team=multi&cue=0&workspace=1&freeCamera=1&hydrate=1"))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').ready===true")
    await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Settle inputs')?.click()")
    await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.length===3")
    await page.evaluate<void>(entranceSampler)
    const original = await page.evaluate<FrameSummary>(frameSummary)
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Switch scope')?.click()")
      await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.length===0 && document.querySelector('.office-notice[role=status]')?.textContent==='Loading the office…'")
      await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Settle inputs')?.click()")
      await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.length===3 && !document.querySelector('.office-notice[role=status]')")
      const other = await page.evaluate<FrameSummary>(frameSummary)
      expect(other.map((frame) => frame.cell)).toEqual(original.map((frame) => frame.cell))
      expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').latestFrames.every(frame=>frame.actor.id.includes('other-device'))")).toBe(true)
      await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Switch scope')?.click()")
      await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Settle inputs')?.click()")
      await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.length===3 && window.__officeGame.scene.getScene('office').latestFrames.every(frame=>frame.actor.id.includes('fixture-device'))")
      expect(await page.evaluate<FrameSummary>(frameSummary)).toEqual(original)
    }
    expect(await page.evaluate<readonly unknown[]>("window.__entrances")).toEqual([])
  } finally { await page.close() }
}, 45_000)

test("inputs that settle within a beat never flash the loading notice", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument("(()=>{window.__notices=[];new MutationObserver(()=>{const notice=document.querySelector('.office-notice[role=status]');if(notice)window.__notices.push(notice.textContent)}).observe(document,{subtree:true,childList:true,characterData:true});const settle=new MutationObserver(()=>{if(!document.querySelector('.office-canvas-host canvas'))return;settle.disconnect();[...document.querySelectorAll('button')].find(button=>button.textContent==='Settle inputs')?.click()});settle.observe(document,{subtree:true,childList:true})})()")
  try {
    await page.setViewport(1440, 900)
    await page.navigate(url("tool", "&team=multi&cue=0&hydrate=1&workspace=1&freeCamera=1"))
    await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.length===3")
    await Bun.sleep(400)
    const notices = await page.evaluate<readonly string[]>("window.__notices")
    expect(notices.filter((text) => text === "Loading the office…")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("work-category gestures animate truthfully and reduced motion fixes each category frame", async () => {
  const page = await requireBrowser().openPage()
  try {
    for (const [theme, activity, pose, bubble] of [["light", "research", "read", "Reading store.ts"], ["dark", "verify", "type", "Running bun test"], ["light", "coordinate", "point", "Dispatching a subagent"]] as const) {
      await page.navigate(url("tool", `&workspace=1&activity=${activity}&freeCamera=1`))
      await page.evaluate<void>(`document.documentElement.dataset.theme='${theme}'`)
      await waitFor(page, `window.__officeGame?.scene.getScene('office').latestFrames[0]?.pose==='${pose}'`)
      const sprite = "window.__officeGame.scene.getScene('office').objects.values().next().value.sprite"
      const animatedFrames = await page.evaluate<readonly number[]>(`(async()=>{const sprite=${sprite},frames=new Set([sprite.frame.name]);for(let index=0;index<120&&frames.size<2;index++)await new Promise(requestAnimationFrame).then(()=>frames.add(sprite.frame.name));return [...frames]})()`)
      expect(animatedFrames.length).toBeGreaterThan(1)
      expect(await page.evaluate<string>(`window.__officeGame.scene.getScene('office').latestFrames[0].actor.bubble`)).toBe(bubble)
      await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
      await waitFor(page, `!${sprite}.anims.isPlaying`)
      const fixedFrames = await page.evaluate<readonly number[]>(`(async()=>{const sprite=${sprite},frames=new Set([sprite.frame.name]);for(let index=0;index<12;index++)await new Promise(requestAnimationFrame).then(()=>frames.add(sprite.frame.name));return [...frames]})()`)
      expect(fixedFrames).toHaveLength(1)
      expect(await page.evaluate<string>("window.__officeGame.scene.getScene('office').latestFrames[0].pose")).toBe(pose)
    }
  } finally { await page.close() }
}, 60_000)
