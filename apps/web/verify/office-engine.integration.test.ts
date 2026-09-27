import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { officeLayout, rooms, tileSize } from "../src/remote/office/map"
import { launchBrowser } from "./cdp"

const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chrome executable")

const port = 45_000 + Math.floor(Math.random() * 10_000)
const captures = mkdtempSync(join(tmpdir(), "ycoding-office-engine-"))
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
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

function url(state = "idle", suffix = "") {
  return `http://127.0.0.1:${port}/verify/office-engine.html?state=${state}${suffix}`
}

async function waitFor(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Office fixture did not settle: ${expression}`)
}

async function actorPositions(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>) {
  return page.evaluate<readonly { readonly id: string; readonly x: number; readonly y: number }[]>("window.__officeGame.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').map(object=>({id:object.name,x:object.x,y:object.y})).sort((a,b)=>a.id.localeCompare(b.id))")
}

async function teamPositions(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>) {
  return (await actorPositions(page)).filter((actor) => actor.id === '["fixture-device","session-a"]' || actor.id === '["fixture-device","session-b"]')
}

async function advanceScene(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>, steps: number) {
  await page.evaluate<void>(`(() => {const scene=window.__officeGame.scene.getScene('office');for(let step=0;step<${steps};step++)scene.update(performance.now()+step*50,50)})()`)
}

test("renders original assets in one lazily mounted canvas and captures the requested states", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument("window.__officeErrors=[];window.addEventListener('error',event=>window.__officeErrors.push(event.message));window.addEventListener('unhandledrejection',event=>window.__officeErrors.push(String(event.reason)))")
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await page.setViewport(width, height)
    for (const state of ["idle", "tool", "attention", "offline"]) {
      await page.navigate(url(state))
      await waitFor(page, "!!document.querySelector('.office-canvas-host canvas') && !document.querySelector('.office-notice[role=status]')")
      expect(await page.evaluate<number>("document.querySelectorAll('.office-canvas-host canvas').length")).toBe(1)
      expect(await page.evaluate<string[]>("window.__officeErrors")).toEqual([])
      expect(page.networkFailures()).toEqual([])
      expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true)
      const controls = await page.evaluate<readonly { readonly name: string; readonly width: number; readonly height: number }[]>("[...document.querySelectorAll('.office-camera-controls button')].map(button=>({name:button.getAttribute('aria-label')||button.textContent,width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))")
      expect(controls.map((button) => button.name)).toEqual(["Zoom in", "Zoom out", "Fit office", "Follow selected", "Back to conversation"])
      expect(controls.every((button) => button.width >= 44 && button.height >= 44)).toBe(true)
      expect(await page.evaluate<boolean>("[...document.querySelectorAll('.office-camera-controls button')].every(button=>button.textContent.trim()===''&&button.querySelector('svg')&&button.dataset.tooltip===button.getAttribute('aria-label'))")).toBe(true)
      const capture = join(captures, `${width}x${height}-${state}.png`)
      await Bun.write(capture, Buffer.from(await page.screenshot(), "base64"))
      expect((await Bun.file(capture).arrayBuffer()).byteLength).toBeGreaterThan(12_000)
    }
  }
  await page.close()
}, 90_000)

test("DPR 2 renders every authored room at CSS zoom one, a full fit, and a phone", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument("Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:()=>2})")
  await page.setViewport(1024, 768)
  await page.navigate(url("tool", "&inspectEngine=1&freeCamera=1"))
  await waitFor(page, "!!document.querySelector('.office-canvas-host canvas') && !document.querySelector('.office-notice[role=status]')")
  const resolution = await page.evaluate<{ readonly ratio: number; readonly zoom: number }>(`(() => {
    const canvas=document.querySelector('canvas');
    return {ratio:canvas.width/canvas.getBoundingClientRect().width,zoom:window.__officeGame.scene.getScene('office').cameras.main.zoom};
  })()`)
  expect(resolution.ratio).toBeGreaterThan(1.9)
  expect(resolution.ratio).toBeLessThanOrEqual(2.1)
  expect(resolution.zoom).toBe(2)
  for (const room of rooms) {
    await page.evaluate<void>(`(() => {const camera=window.__officeGame.scene.getScene('office').cameras.main;camera.setZoom(2);camera.centerOn(${(room.center.x + 0.5) * tileSize},${(Math.min(room.center.y, room.label.y + 5) + 0.5) * tileSize})})()`)
    await Bun.sleep(90)
    await Bun.write(join(captures, `dpr2-${room.id}-1024x768.png`), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate<number>("window.__officeGame.scene.getScene('office').cameras.main.zoom")).toBe(2)
  }
  await page.setViewport(768, 1024)
  await page.navigate(url("tool", "&inspectEngine=1&freeCamera=1"))
  await waitFor(page, "!!document.querySelector('.office-canvas-host canvas') && !document.querySelector('.office-notice[role=status]')")
  for (const room of rooms) {
    await page.evaluate<void>(`(() => {const camera=window.__officeGame.scene.getScene('office').cameras.main;camera.setZoom(2);camera.centerOn(${(room.center.x + 0.5) * tileSize},${(room.center.y + 0.5) * tileSize})})()`)
    await Bun.sleep(90)
    await Bun.write(join(captures, `dpr2-${room.id}-768x1024.png`), Buffer.from(await page.screenshot(), "base64"))
  }
  await page.evaluate<void>(`(() => {const camera=window.__officeGame.scene.getScene('office').cameras.main;camera.centerOn(${(officeLayout.door.x + 0.5) * tileSize},${(officeLayout.door.y - 2) * tileSize})})()`)
  await Bun.sleep(90)
  await Bun.write(join(captures, "dpr2-entrance-768x1024.png"), Buffer.from(await page.screenshot(), "base64"))
  await page.setViewport(1440, 900)
  await page.navigate(url("tool", "&inspectEngine=1&freeCamera=1"))
  await waitFor(page, "!!document.querySelector('.office-canvas-host canvas') && !document.querySelector('.office-notice[role=status]')")
  await page.evaluate<void>("document.querySelector('button[aria-label=\"Fit office\"]')?.click()")
  await Bun.sleep(90)
  expect(await page.evaluate<number>("window.__officeGame.scene.getScene('office').cameras.main.zoom")).toBeLessThan(2)
  const labels = await page.evaluate<readonly { readonly title: string; readonly left: number; readonly right: number }[]>("window.__officeGame.scene.getScene('office').children.list.filter(object=>object.type==='Text'&&object.visible&&['CEO OFFICE','RESEARCH LAB','QA LAB','DEVELOPER STUDIO','MEETING ROOM','RELAX LOUNGE'].includes(object.text)).map(object=>({title:object.text,left:object.x-object.displayWidth/2,right:object.x+object.displayWidth/2}))")
  expect(labels.length).toBe(rooms.length)
  for (const room of rooms) {
    const label = labels.find((item) => item.title === room.title)!
    expect(label.left, room.id).toBeGreaterThanOrEqual(room.left * tileSize - 1)
    expect(label.right, room.id).toBeLessThanOrEqual((room.right + 1) * tileSize + 1)
  }
  await Bun.write(join(captures, "dpr2-full-office-1440x900.png"), Buffer.from(await page.screenshot(), "base64"))
  await page.setViewport(390, 844)
  await page.navigate(url("attention", "&inspectEngine=1"))
  await waitFor(page, "!!document.querySelector('.office-canvas-host canvas') && !document.querySelector('.office-notice[role=status]')")
  await Bun.write(join(captures, "dpr2-phone-390x844.png"), Buffer.from(await page.screenshot(), "base64"))
  await page.close()
}, 60_000)

test("phone camera toolbar sits above the canvas without covering actor bubbles", async () => {
  const page = await requireBrowser().openPage()
  await page.setViewport(390, 844)
  await page.navigate(url("attention"))
  await waitFor(page, "!!document.querySelector('.office-canvas-host canvas') && !document.querySelector('.office-notice[role=status]')")
  const layout = await page.evaluate<{ readonly toolbarBottom: number; readonly canvasTop: number; readonly canvasHeight: number; readonly targets: readonly { readonly width: number; readonly height: number }[] }>(`(() => {
    const toolbar=document.querySelector('.office-camera-controls').getBoundingClientRect();
    const canvas=document.querySelector('.office-canvas-host').getBoundingClientRect();
    return {toolbarBottom:toolbar.bottom,canvasTop:canvas.top,canvasHeight:canvas.height,
      targets:[...document.querySelectorAll('.office-camera-controls button')].map(button=>({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))};
  })()`)
  expect(layout.toolbarBottom).toBeLessThanOrEqual(layout.canvasTop)
  expect(layout.canvasHeight).toBeGreaterThan(200)
  expect(layout.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true)
  await page.close()
}, 30_000)

test("attention emotes and markers do not obscure the selected bubble", async () => {
  const page = await requireBrowser().openPage()
  await page.setViewport(390, 844)
  await page.navigate(url("attention", "&inspectEngine=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.some(object=>object.type==='Text'&&object.text==='Needs your reply'&&object.visible)")
  const layout = await page.evaluate<{ readonly bubble: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }; readonly decorations: readonly { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }[] }>(`(() => {
    const objects=window.__officeGame.scene.getScene('office').children.list;
    const box=object=>({left:object.x-object.displayWidth*object.originX,right:object.x+object.displayWidth*(1-object.originX),
      top:object.y-object.displayHeight*object.originY,bottom:object.y+object.displayHeight*(1-object.originY)});
    const bubble=objects.find(object=>object.type==='Text'&&object.text==='Needs your reply'&&object.visible);
    const decorations=objects.filter(object=>object.visible&&((object.type==='Text'&&object.text==='!')||(object.type==='Sprite'&&object.texture.key==='emotes')));
    return {bubble:box(bubble),decorations:decorations.map(box)};
  })()`)
  expect(layout.decorations.length).toBeGreaterThan(0)
  expect(layout.decorations.every((item) => item.right <= layout.bubble.left || item.left >= layout.bubble.right
    || item.bottom <= layout.bubble.top || item.top >= layout.bubble.bottom)).toBe(true)
  await page.close()
}, 30_000)

test("50 mounts and unmounts retain no canvases, visibility listeners, or resize observers", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument(`(() => {
    window.__officeErrors=[];window.addEventListener('error',e=>window.__officeErrors.push(e.message));
    window.__officeResources={visibility:0,observers:0,media:0};
    const add=document.addEventListener.bind(document), remove=document.removeEventListener.bind(document);
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

test("an immediate unmount cancels a pending lazy engine import", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument("window.__officeErrors=[];window.addEventListener('error',event=>window.__officeErrors.push(event.message));window.addEventListener('unhandledrejection',event=>window.__officeErrors.push(String(event.reason)))")
  await page.navigate(url("idle", "&mounted=0"))
  expect(await page.evaluate<boolean>("performance.getEntriesByType('resource').some(entry=>entry.name.includes('create-game')||entry.name.includes('phaser'))")).toBe(false)
  await page.evaluate<void>(`(() => {
    [...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click();
    [...document.querySelectorAll('button')].find(button=>button.textContent==='Unmount office')?.click();
  })()`)
  await Bun.sleep(500)
  expect(await page.evaluate<number>("document.querySelectorAll('canvas').length")).toBe(0)
  expect(await page.evaluate<string[]>("window.__officeErrors")).toEqual([])
  await page.close()
}, 30_000)

test("sprite click selects its real Session while a drag pans without selecting", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const selected = await page.evaluate<string>(`(() => {
    const scene=window.__officeGame.scene.getScene('office');
    const sprite=scene.children.list.find(object=>object.type==='Sprite'&&object.texture.key==='characters'&&object.name==='["fixture-device","session-b"]');
    if(!sprite)throw new Error('Task sprite missing');
    const canvas=document.querySelector('canvas'),rect=canvas.getBoundingClientRect();
    const point=scene.cameras.main.matrixCombined.transformPoint(sprite.x,sprite.y-14);
    const x=rect.left+point.x*rect.width/canvas.width,y=rect.top+point.y*rect.height/canvas.height;
    for(const type of ['mousedown','mouseup'])canvas.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,buttons:type==='mousedown'?1:0}));
    return document.querySelector('#selected-session')?.textContent;
  })()`)
  expect(selected).toBe("session-b")
  await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.some(frame=>frame.actor.selected&&frame.actor.sessionID==='session-b')")
  for (let index = 0; index < 3; index++) await page.evaluate<void>("document.querySelector('[aria-label=\"Zoom in\"]')?.click()")
  const before = await page.evaluate<{ readonly x: number; readonly y: number }>("(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return{x:camera.scrollX,y:camera.scrollY}})()")
  await page.evaluate<void>(`(() => {
    const canvas=document.querySelector('canvas');const rect=canvas.getBoundingClientRect();
    const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    canvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:x,clientY:y,button:0,buttons:1}));
    canvas.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x+120,clientY:y+45,button:0,buttons:1}));
    canvas.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:x+120,clientY:y+45,button:0,buttons:0}));
  })()`)
  await Bun.sleep(100)
  expect(await page.evaluate<string>("document.querySelector('#selected-session')?.textContent")).toBe("session-b")
  const panned = await page.evaluate<{ readonly x: number; readonly y: number }>("(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return{x:camera.scrollX,y:camera.scrollY}})()")
  expect(Math.abs(panned.x - before.x) + Math.abs(panned.y - before.y)).toBeGreaterThan(1)
  await Bun.sleep(100)
  expect(await page.evaluate<number>(`(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return Math.abs(camera.scrollX-(${panned.x}))+Math.abs(camera.scrollY-(${panned.y}))})()`)).toBeLessThan(1)
  await page.evaluate<void>("document.querySelector('button[aria-label=\"Follow selected\"]')?.click()")
  await waitFor(page, `(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return Math.abs(camera.scrollX-(${panned.x}))+Math.abs(camera.scrollY-(${panned.y}))>1})()`)
  const followed = await page.evaluate<{ readonly x: number; readonly y: number }>("(()=>{const camera=window.__officeGame.scene.getScene('office').cameras.main;return{x:camera.scrollX,y:camera.scrollY}})()")
  expect(Math.abs(followed.x - panned.x) + Math.abs(followed.y - panned.y)).toBeGreaterThan(1)
  await page.close()
}, 30_000)

test("mount applies Phaser's enforced 30/20 frame cap instead of changing an active game", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&inspectEngine=1"))
  await waitFor(page, "document.documentElement.dataset.officeFps === '30'")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle quality')?.click()")
  expect(await page.evaluate<string>("document.documentElement.dataset.officeFps")).toBe("30")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Unmount office')?.click()")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click()")
  await waitFor(page, "document.documentElement.dataset.officeFps === '20'")
  await page.close()
}, 30_000)

test("visibility and reduced motion adopt the latest state without replaying a walk", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&inspectEngine=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.some(object=>object.type==='Sprite'&&object.texture.key==='characters')")
  await page.evaluate<void>(`(() => {
    window.__officeHidden=true;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__officeHidden});
    document.dispatchEvent(new Event('visibilitychange'));
    const select=document.querySelector('select[aria-label="Office state"]');
    select.value='attention';select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  await page.evaluate<void>("window.__officeHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
  await Bun.sleep(80)
  const settled = await actorPositions(page)
  await Bun.sleep(220)
  expect(await actorPositions(page)).toEqual(settled)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
  await page.evaluate<void>(`(() => {const select=document.querySelector('select[aria-label="Office state"]');select.value='tool';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await Bun.sleep(80)
  const reduced = await actorPositions(page)
  await Bun.sleep(220)
  expect(await actorPositions(page)).toEqual(reduced)
  await page.close()
}, 30_000)

test("a cue present during hydration does not replay a meeting", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const hydrated = await teamPositions(page)
  await advanceScene(page, 450)
  expect(await teamPositions(page)).toEqual(hydrated)
  await Bun.write(join(captures, "1440x900-team-hydrated.png"), Buffer.from(await page.screenshot(), "base64"))
  await page.close()
}, 30_000)

test("room agent name pills remain distinct at the renderer boundary", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const bounds = await page.evaluate<{ readonly root: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }; readonly task: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } }>(`(() => {
    const labels=window.__officeGame.scene.getScene('office').children.list.filter(object=>object.type==='Text');
    const root=labels.find(label=>label.text.includes(' · Developer'));
    const task=labels.find(label=>label.text.includes(' · Reviewer'));
    if(!root||!task)throw new Error('Team labels missing');
    const box=label=>({left:label.x,right:label.x+label.displayWidth,top:label.y,bottom:label.y+label.displayHeight});
    return {root:box(root),task:box(task)};
  })()`)
  expect(bounds.root.right <= bounds.task.left || bounds.task.right <= bounds.root.left
    || bounds.root.bottom <= bounds.task.top || bounds.task.bottom <= bounds.root.top).toBe(true)
  await page.close()
}, 30_000)

test("a new delegate cue brings supervisor and child into the meeting room and back", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1&cue=0"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const initial = await teamPositions(page)
  const meeting = rooms.find((room) => room.id === "meeting")!
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  const reached = await page.evaluate<boolean>(`(() => {
    const scene=window.__officeGame.scene.getScene('office');
    const ids=new Set(['["fixture-device","session-a"]','["fixture-device","session-b"]']);
    for(let step=0;step<450;step++){
      scene.update(performance.now()+step*50,50);
      const actors=scene.children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters'&&ids.has(object.name));
      if(actors.length===2&&actors.every(actor=>actor.x>=${meeting.left * tileSize}&&actor.x<${(meeting.right + 1) * tileSize}
        &&actor.y>=${meeting.top * tileSize}&&actor.y<${(meeting.bottom + 1) * tileSize})
        &&scene.children.list.some(object=>object.type==='Sprite'&&object.texture.key==='emotes'&&object.visible))return true;
    }
    return false;
  })()`)
  expect(reached).toBe(true)
  await waitFor(page, "(()=>{const objects=window.__officeGame.scene.getScene('office').children.list;return objects.some(object=>object.type==='Text'&&object.text==='MEETING ROOM'&&object.visible)&&objects.some(object=>object.type==='Text'&&object.text==='Running a tool'&&object.visible)})()")
  const inspectMeetingLabel = `(() => {
    const scene=window.__officeGame.scene.getScene('office');
    const title=scene.children.list.find(object=>object.type==='Text'&&object.text==='MEETING ROOM');
    const bubble=scene.children.list.find(object=>object.type==='Text'&&object.text==='Running a tool'&&object.visible);
    if(!title||!bubble)return {visible:false,overlaps:true,alpha:1};
    const scale=scene.resolution/scene.cameras.main.zoom;
    const titleBounds={left:title.x-title.displayWidth/2-12*scale,right:title.x+title.displayWidth/2+12*scale,top:title.y-title.displayHeight/2-6*scale,bottom:title.y+title.displayHeight/2+6*scale};
    const bubbleBounds={left:bubble.x-bubble.displayWidth/2-9*scale,right:bubble.x+bubble.displayWidth/2+9*scale,top:bubble.y-bubble.displayHeight-5*scale,bottom:bubble.y+5*scale};
    return {visible:title.visible,overlaps:titleBounds.left<bubbleBounds.right&&titleBounds.right>bubbleBounds.left&&titleBounds.top<bubbleBounds.bottom&&titleBounds.bottom>bubbleBounds.top,alpha:title.alpha};
  })()`
  const labels = await page.evaluate<{ readonly visible: boolean; readonly overlaps: boolean; readonly alpha: number }>(inspectMeetingLabel)
  expect(labels.visible).toBe(true)
  expect(labels.overlaps).toBe(false)
  await Bun.write(join(captures, "1440x900-team-delegate-meeting.png"), Buffer.from(await page.screenshot(), "base64"))
  await page.evaluate<void>("window.__officeGame.scene.getScene('office').fit()")
  await Bun.sleep(90)
  const fitLabels = await page.evaluate<{ readonly visible: boolean; readonly overlaps: boolean; readonly alpha: number }>(inspectMeetingLabel)
  expect(fitLabels.overlaps && fitLabels.visible && fitLabels.alpha >= 0.35).toBe(false)
  await Bun.write(join(captures, "1440x900-team-delegate-fit.png"), Buffer.from(await page.screenshot(), "base64"))
  await advanceScene(page, 550)
  expect(await teamPositions(page)).toEqual(initial)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  await advanceScene(page, 100)
  expect(await teamPositions(page)).toEqual(initial)
  await page.close()
}, 60_000)

test("two simultaneous delegations start the supervisor and both children without a scene queue", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=multi&inspectEngine=1&cue=0"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 3")
  const before = await actorPositions(page)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  expect(await page.evaluate<string>("document.querySelector('aside')?.dataset.cues")).toBe("2")
  await advanceScene(page, 20)
  const after = await actorPositions(page)
  for (const sessionID of ["session-a", "session-b", "session-d"]) {
    const id = JSON.stringify(["fixture-device", sessionID])
    expect(after.find((actor) => actor.id === id)).not.toEqual(before.find((actor) => actor.id === id))
  }
  await page.close()
}, 30_000)

test("roster cards show real sprite, unique name and role, follow selection, and update current room during delegation", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&cue=0&inspectEngine=1&workspace=1"))
  await waitFor(page, "document.querySelectorAll('.office-roster__row').length===2&&window.__officeGame?.scene.getScene('office').latestFrames.length===2")
  const cards = await page.evaluate<readonly { readonly name: string; readonly room: string; readonly sprite: string }[]>("[...document.querySelectorAll('.office-roster__row')].map(row=>({name:row.querySelector('.office-roster__name').textContent,room:row.querySelector('.office-roster__room').textContent,sprite:getComputedStyle(row.querySelector('.office-roster__sprite')).backgroundImage}))")
  expect(new Set(cards.map((card) => card.name)).size).toBe(2)
  expect(cards.every((card) => card.name.includes(' · ') && card.sprite.includes('characters'))).toBe(true)
  expect(cards.some((card) => card.room === "QA lab")).toBe(true)
  await page.evaluate<void>("document.querySelector('.office-roster__row[data-session-id=\"session-b\"]')?.click()")
  await waitFor(page, "document.querySelector('#selected-session')?.textContent==='session-b'&&document.querySelector('.office-roster__row[data-session-id=\"session-b\"]')?.getAttribute('aria-current')==='true'")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  const met = await page.evaluate<boolean>(`(() => {const scene=window.__officeGame.scene.getScene('office');for(let step=0;step<450;step++){scene.update(performance.now()+step*50,50);if(scene.latestFrames.find(frame=>frame.actor.sessionID==='session-b')?.room==='meeting')return true}return false})()`)
  expect(met).toBe(true)
  await waitFor(page, "document.querySelector('.office-roster__row[data-session-id=\"session-b\"] .office-roster__room')?.textContent==='Meeting room'")
  await advanceScene(page, 550)
  await waitFor(page, "document.querySelector('.office-roster__row[data-session-id=\"session-b\"] .office-roster__room')?.textContent==='QA lab'")
  await page.close()
}, 60_000)

test("a root with a lagging idle detail but a running report stays at its CEO desk with a working bubble", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("idle", "&staleIdle=1&inspectEngine=1&workspace=1&team=1&cue=0"))
  await waitFor(page, "document.querySelectorAll('.office-roster__row').length===2&&window.__officeGame?.scene.getScene('office').latestFrames.length===2")
  const root = await page.evaluate<{ readonly status: string; readonly room: string; readonly bubble: boolean; readonly desk: boolean }>(`(() => {
    const scene=window.__officeGame.scene.getScene('office');
    const frame=scene.latestFrames.find(frame=>frame.actor.sessionID==='session-a');
    return {status:document.querySelector('.office-roster__row[data-session-id="session-a"] .office-roster__status').textContent,
      room:frame.room,bubble:scene.objects.get(frame.actor.id).bubble.text==='Working',
      desk:scene.director.actors.get(frame.actor.id).work.cell.x===Math.floor(frame.position.x/32)&&scene.director.actors.get(frame.actor.id).work.cell.y===Math.floor(frame.position.y/32)};
  })()`)
  expect(root).toEqual({ status: "Working", room: "ceo", bubble: true, desk: true })
  await page.close()
}, 30_000)

test("repeated ready team snapshots preserve roster row nodes and character sprites", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&cue=0&inspectEngine=1&workspace=1&snapshots=1"))
  await waitFor(page, "document.querySelectorAll('.office-roster__row').length===2&&window.__officeGame?.scene.getScene('office').objects.size===2")
  const result = await page.evaluate<{ readonly removed: number; readonly updated: number; readonly sameRows: boolean; readonly sameSprites: boolean; readonly rows: number }>(`(async () => {
    const rows=[...document.querySelectorAll('.office-roster__row')];
    const scene=window.__officeGame.scene.getScene('office');
    const sprites=new Map([...scene.objects].map(([id,objects])=>[id,objects.sprite]));
    let removed=0, updated=0;
    const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.removedNodes)if(rows.some(row=>node===row||node.contains?.(row)))removed++});
    observer.observe(document.querySelector('.office-workspace'),{childList:true,subtree:true});
    for(let index=0;index<12;index++){
      [...document.querySelectorAll('button')].find(button=>button.textContent==='Refresh snapshot').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(document.querySelector('.office-roster__row[data-session-id="session-a"] .office-roster__status')?.textContent===(index%2===0?'Thinking':'Working'))updated++;
    }
    observer.disconnect();
    return {removed,updated,sameRows:rows.every(row=>document.querySelector('.office-roster__row[data-session-id="'+row.dataset.sessionId+'"]')===row),
      sameSprites:[...sprites].every(([id,sprite])=>scene.objects.get(id)?.sprite===sprite),rows:document.querySelectorAll('.office-roster__row').length};
  })()`)
  expect(result).toEqual({ removed: 0, updated: 12, sameRows: true, sameSprites: true, rows: 2 })
  await page.close()
}, 30_000)

test("a report cue sends the child beside its supervisor, shows a report emote, and returns", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1&cue=0&cueKind=report"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const initial = await teamPositions(page)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  const reported = await page.evaluate<boolean>(`(() => {
    const scene=window.__officeGame.scene.getScene('office');
    for(let step=0;step<450;step++){
      scene.update(performance.now()+step*50,50);
      const actors=scene.children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters');
      const root=actors.find(actor=>actor.name==='["fixture-device","session-a"]');
      const child=actors.find(actor=>actor.name==='["fixture-device","session-b"]');
      if(root&&child&&Math.abs(Math.floor(root.x/${tileSize})-Math.floor(child.x/${tileSize}))
        +Math.abs(Math.floor(root.y/${tileSize})-Math.floor(child.y/${tileSize}))<=1
        &&scene.children.list.some(object=>object.type==='Sprite'&&object.texture.key==='emotes'&&object.visible&&String(object.frame.name)==='6'))return true;
    }
    return false;
  })()`)
  expect(reported).toBe(true)
  await Bun.write(join(captures, "1440x900-team-report.png"), Buffer.from(await page.screenshot(), "base64"))
  await advanceScene(page, 550)
  expect(await teamPositions(page)).toEqual(initial)
  await page.close()
}, 60_000)

test("a new research session enters through the glass lobby and leaves when removed", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&arrival=1&inspectEngine=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 1")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle arriving session')?.click()")
  await waitFor(page, "window.__officeGame.scene.getScene('office').children.list.some(object=>object.type==='Sprite'&&object.name==='[\"fixture-device\",\"session-new\"]')")
  const entrance = (await actorPositions(page)).find((actor) => actor.id === '["fixture-device","session-new"]')!
  expect(Math.abs(Math.floor(entrance.x / tileSize) - officeLayout.door.x) + Math.abs(Math.floor(entrance.y / tileSize) - officeLayout.door.y)).toBeLessThanOrEqual(1)
  await advanceScene(page, 500)
  const arrived = (await actorPositions(page)).find((actor) => actor.id === entrance.id)!
  const research = rooms.find((room) => room.id === "research")!
  expect(Math.floor(arrived.x / tileSize)).toBeGreaterThanOrEqual(research.left)
  expect(Math.floor(arrived.x / tileSize)).toBeLessThanOrEqual(research.right)
  expect(Math.floor(arrived.y / tileSize)).toBeGreaterThanOrEqual(research.top)
  expect(Math.floor(arrived.y / tileSize)).toBeLessThanOrEqual(research.bottom)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle arriving session')?.click()")
  await advanceScene(page, 650)
  expect((await actorPositions(page)).some((actor) => actor.id === entrance.id)).toBe(false)
  await page.close()
}, 60_000)

test("reduced motion shows a brief factual cue badge without actor travel", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1&cue=0"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const initial = await actorPositions(page)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle reduced motion')?.click()")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  await Bun.sleep(90)
  expect(await actorPositions(page)).toEqual(initial)
  expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').children.list.some(object=>object.type==='Text'&&object.text==='Delegated'&&object.visible)")).toBe(true)
  await Bun.sleep(900)
  expect(await page.evaluate<boolean>("window.__officeGame.scene.getScene('office').children.list.some(object=>object.type==='Text'&&object.text==='Delegated'&&object.visible)")).toBe(false)
  await page.close()
}, 30_000)

test("returning from a hidden tab adopts a new cue without replaying travel", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1&cue=0"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const initial = await actorPositions(page)
  await page.evaluate<void>(`(() => {
    window.__officeHidden=true;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__officeHidden});
    document.dispatchEvent(new Event('visibilitychange'));
    [...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click();
  })()`)
  await page.evaluate<void>("window.__officeHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
  await Bun.sleep(350)
  expect(await actorPositions(page)).toEqual(initial)
  await page.close()
}, 30_000)

test("offline freezes an active cue and reconnect adopts home without replay", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("tool", "&team=1&inspectEngine=1&cue=0"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  const initial = await actorPositions(page)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle observed cue')?.click()")
  for (let attempt = 0; attempt < 40; attempt++) {
    if (JSON.stringify(await actorPositions(page)) !== JSON.stringify(initial)) break
    await Bun.sleep(60)
  }
  expect(await actorPositions(page)).not.toEqual(initial)
  await page.evaluate<void>("(()=>{const select=document.querySelector('select[aria-label=\"Office state\"]');select.value='offline';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await Bun.sleep(80)
  const frozen = await actorPositions(page)
  await Bun.sleep(350)
  expect(await actorPositions(page)).toEqual(frozen)
  await page.evaluate<void>("(()=>{const select=document.querySelector('select[aria-label=\"Office state\"]');select.value='tool';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await Bun.sleep(120)
  expect(await actorPositions(page)).toEqual(initial)
  await Bun.sleep(350)
  expect(await actorPositions(page)).toEqual(initial)
  await page.close()
}, 30_000)

test("task badges distinguish waiting and failure, while completed children depart", async () => {
  const page = await requireBrowser().openPage()
  const poses: Record<string, string> = {}
  for (const state of ["starting", "running", "cancelling", "waiting"] as const) {
    await page.navigate(url("tool", `&team=1&inspectEngine=1&taskState=${state}`))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
    poses[state] = await page.evaluate<string>(`(() => {
      const sprite=window.__officeGame.scene.getScene('office').children.list.find(object=>object.type==='Sprite'&&object.name==='["fixture-device","session-b"]');
      if(!sprite)throw new Error('Task sprite missing');
      return sprite.texture.key+':'+sprite.frame.name;
    })()`)
  }
  expect(poses.starting).toBe(poses.running)
  expect(poses.cancelling).toBe(poses.running)
  expect(poses.waiting).not.toBe(poses.running)
  for (const [state, marker] of [["waiting", "!"]] as const) {
    await page.navigate(url("tool", `&team=1&inspectEngine=1&taskState=${state}`))
    await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
    const texts = await page.evaluate<readonly string[]>("window.__officeGame.scene.getScene('office').children.list.filter(object=>object.type==='Text'&&object.visible).map(object=>object.text)")
    expect(texts).toContain("TASK")
    expect(texts.some((text) => text.includes(marker))).toBe(true)
  }
  await page.navigate(url("tool", "&team=1&inspectEngine=1&taskState=failed"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 1")
  await page.navigate(url("tool", "&team=1&inspectEngine=1&taskState=completed"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 1")
  await page.navigate(url("tool", "&team=1&inspectEngine=1&transitionTask=1"))
  await waitFor(page, "window.__officeGame?.scene.getScene('office').children.list.filter(object=>object.type==='Sprite'&&object.texture.key==='characters').length === 2")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Toggle task completion')?.click()")
  await waitFor(page, "window.__officeGame.scene.getScene('office').latestFrames.some(frame=>frame.actor.sessionID==='session-b'&&frame.leaving)")
  await advanceScene(page, 500)
  expect((await actorPositions(page)).some((actor) => actor.id === '["fixture-device","session-b"]')).toBe(false)
  await page.close()
}, 30_000)

test("resizes from zero, keeps keyboard input, and offers normal view after graphics context loss", async () => {
  const page = await requireBrowser().openPage()
  await page.navigate(url("attention", "&mounted=0"))
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Zero size')?.click()")
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click()")
  await waitFor(page, "!!document.querySelector('canvas') && !document.querySelector('.office-notice[role=status]')")
  expect(await page.evaluate<number>("document.querySelector('canvas')?.height")).toBe(1)
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Restore size')?.click()")
  await waitFor(page, "document.querySelector('canvas')?.height > 100")
  await page.evaluate<void>("(()=>{const input=document.querySelector('input[aria-label*=Typing]');input.value='agent';input.focus();input.setSelectionRange(0,0)})()")
  await page.pressKey("ArrowRight", "ArrowRight", 39)
  expect(await page.evaluate<number>("document.querySelector('input[aria-label*=Typing]')?.selectionStart")).toBe(1)
  const context = await page.evaluate<boolean>(`(() => {
    const canvas=document.querySelector('.office-canvas-host canvas');
    const gl=canvas?.getContext('webgl2')||canvas?.getContext('webgl');
    const extension=gl?.getExtension('WEBGL_lose_context');
    if(!extension)return false;
    extension.loseContext();return true;
  })()`)
  expect(context).toBe(true)
  await waitFor(page, "!!document.querySelector('.office-notice[role=alert]')")
  expect(await page.evaluate<string>("document.querySelector('.office-notice[role=alert]')?.textContent")).toContain("normal workspace")
  await page.evaluate<void>("document.querySelector('.office-notice[role=alert] button')?.click()")
  expect(await page.evaluate<number>("document.querySelectorAll('canvas').length")).toBe(0)
  await page.close()
}, 30_000)

test("reports failed asset loading without a retry loop", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument(`(() => {
    window.__imageAttempts=0;
    const open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url,...rest){if(String(url).includes('characters.png')){window.__imageAttempts++;return open.call(this,method,'/missing-office-asset.png',...rest)}return open.call(this,method,url,...rest)};
  })()`)
  await page.navigate(url("idle"))
  await waitFor(page, "!!document.querySelector('.office-notice[role=alert]')")
  expect(await page.evaluate<string>("document.querySelector('.office-notice[role=alert]')?.textContent")).toContain("asset failed to load")
  const attempts = await page.evaluate<number>("window.__imageAttempts")
  expect(attempts).toBe(1)
  await Bun.sleep(300)
  expect(await page.evaluate<number>("window.__imageAttempts")).toBe(attempts)
  await page.evaluate<void>("document.querySelector('.office-notice[role=alert] button')?.click()")
  expect(await page.evaluate<number>("document.querySelectorAll('canvas').length")).toBe(0)
  await page.close()
}, 30_000)

test("a missing lazy engine chunk leaves the normal view available", async () => {
  const page = await requireBrowser().openPage()
  await page.blockURLs(["*create-game*"])
  await page.navigate(url("idle", "&mounted=0"))
  await page.evaluate<void>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Mount office')?.click()")
  await waitFor(page, "!!document.querySelector('.office-notice[role=alert]')")
  expect(await page.evaluate<string>("document.querySelector('.office-notice[role=alert]')?.textContent")).toContain("could not start")
  await page.evaluate<void>("document.querySelector('.office-notice[role=alert] button')?.click()")
  expect(await page.evaluate<number>("document.querySelectorAll('canvas').length")).toBe(0)
  await page.close()
}, 30_000)

test("renders through Phaser Canvas when WebGL is unavailable", async () => {
  const page = await requireBrowser().openPage()
  await page.injectOnNewDocument(`(() => {
    window.__officeErrors=[];window.addEventListener('error',event=>window.__officeErrors.push(event.message));
    const context=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){if(String(type).includes('webgl'))return null;return context.call(this,type,...args)};
  })()`)
  await page.navigate(url("tool"))
  await waitFor(page, "!!document.querySelector('canvas') && !document.querySelector('.office-notice[role=status]')")
  expect(await page.evaluate<boolean>("!document.querySelector('.office-notice[role=alert]')")).toBe(true)
  expect(await page.evaluate<string[]>("window.__officeErrors")).toEqual([])
  expect(Buffer.from(await page.screenshot(), "base64").byteLength).toBeGreaterThan(12_000)
  await page.close()
}, 30_000)
