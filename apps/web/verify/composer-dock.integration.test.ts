import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4471
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 390, 844)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("the hide control sits beneath the capsule and draft, and an open keyboard lifts the composer by the shell inset", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__dock-toggle') !== null`)
    await page.evaluate(`document.documentElement.dataset.theme = "dark"; localStorage.removeItem('ycoding.remote.composer-collapsed'); window.composerSetDraft('ses_fixture', ${JSON.stringify("Keep the draft clear of the hide control. ".repeat(12))})`)
    for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
      await page.setViewport(viewport.width, viewport.height)
      const boxes = await page.evaluate<{ toggleTop: number; capsuleBottom: number; fieldBottom: number }>(`(() => { const toggle=document.querySelector('.mini-composer__mount .composer__dock-toggle').getBoundingClientRect(); const capsule=document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect(); const field=document.querySelector('.mini-composer__mount .composer__input').getBoundingClientRect(); return { toggleTop:toggle.top, capsuleBottom:capsule.bottom, fieldBottom:field.bottom }; })()`)
      expect(boxes.toggleTop).toBeGreaterThanOrEqual(boxes.capsuleBottom - 0.5)
      expect(boxes.toggleTop).toBeGreaterThanOrEqual(boxes.fieldBottom - 0.5)
      await page.evaluate(`document.querySelector('.mini-composer__mount .composer__dock-toggle').click()`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer--collapsed') !== null`)
      const handle = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__dock').getBoundingClientRect().height`)
      expect(handle).toBeLessThanOrEqual(52)
      expect(handle).toBeGreaterThanOrEqual(44)
      const announcementDisplay = await page.evaluate<string>(`getComputedStyle(document.querySelector('.mini-composer__mount .composer--collapsed .session-status__announce')).display`)
      expect(announcementDisplay).not.toBe("none")
      await page.evaluate(`document.querySelector('.mini-composer__mount .composer__dock-toggle').click()`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer--collapsed') === null`)
    }
    await page.setViewport(390, 844)
    await page.setColorScheme("dark")
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-1440`)
    await wait(page, `document.querySelector('.composer-resident .composer__input') !== null`)
    const before = await page.evaluate<number>(`document.querySelector('.composer-resident .composer').getBoundingClientRect().bottom`)
    const navBefore = await page.evaluate<number>(`document.querySelector('.bottom-nav').getBoundingClientRect().height`)
    const appBottomBefore = await page.evaluate<number>(`document.querySelector('.app').getBoundingClientRect().bottom`)
    await page.evaluate(`const app=document.querySelector('.app'); app.setAttribute('data-keyboard-open',''); app.style.setProperty('--yc-keyboard-inset','280px')`)
    const lifted = await page.evaluate<{ margin: string; padding: string; bottom: number; appBottom: number; navDisplay: string }>(`(() => { const node=document.querySelector('.composer-resident .composer'); const style=getComputedStyle(node); return { margin:style.marginBlockEnd, padding:style.paddingBlockEnd, bottom:node.getBoundingClientRect().bottom, appBottom:document.querySelector('.app').getBoundingClientRect().bottom, navDisplay:getComputedStyle(document.querySelector('.bottom-nav')).display }; })()`)
    expect(lifted.margin).toBe("280px")
    expect(Number.parseFloat(lifted.padding)).toBeLessThan(16)
    expect(lifted.navDisplay).toBe("none")
    expect(Math.abs(lifted.appBottom - appBottomBefore)).toBeLessThanOrEqual(1)
    expect(lifted.appBottom - lifted.bottom).toBeGreaterThan(270)
    expect(lifted.appBottom - lifted.bottom).toBeLessThan(290)
    expect(before + navBefore - lifted.bottom).toBeGreaterThan(270)
    expect(before + navBefore - lifted.bottom).toBeLessThan(290)
  } finally { await page.close() }
})

for (const viewport of [{ width: 390, height: 844, inset: 424 }, { width: 390, height: 844, inset: 280 }, { width: 320, height: 700, inset: 280 }]) {
  for (const state of ["plain", "prediction", "attachment", "upload", "catalog-error", "fallback", "jump"] as const) {
    test(`keyboard-open ${state} controls fit at ${viewport.width}×${viewport.height} with ${viewport.inset}px occlusion`, async () => {
      const page = await browser!.openPage()
      try {
        await page.setViewport(viewport.width, viewport.height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-1440`)
        await wait(page, `document.querySelector('.composer-resident .composer__effort') !== null`)
        await page.evaluate(`(() => {
          document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove();
          const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden';
          localStorage.removeItem('ycoding.remote.composer-collapsed');
          const toggle=document.querySelector('.composer-resident .composer__dock-toggle'); if(toggle.getAttribute('aria-expanded') === 'false') toggle.click();
        })()`)
        if (!(["attachment", "upload", "catalog-error"] as readonly string[]).includes(state)) await openEffort(page)
        if (state === "attachment") {
          await page.evaluate(`(() => { const input=document.querySelector('.composer-resident input[type=file]'); const transfer=new DataTransfer(); for(const name of ['very-long-attachment-filename-for-keyboard-layout-check.txt', 'second-note.txt']) transfer.items.add(new File(['Keyboard attachment'], name, { type:'text/plain' })); input.files=transfer.files; input.dispatchEvent(new Event('change', { bubbles:true })); })()`)
          await wait(page, `document.querySelectorAll('.composer-resident .composer__attachment').length === 2`)
        } else if (state !== "plain" && state !== "jump") {
          await page.evaluate(`window.remoteComposerState(${JSON.stringify(state)})`)
          const selector = state === "prediction" ? ".composer__use-prediction" : state === "upload" ? ".composer__upload" : state === "catalog-error" ? ".composer__catalog-status" : ".reasoning-effort p"
          await wait(page, `document.querySelector('.composer-resident ${selector}') !== null`)
        }
        await page.evaluate(`(() => {
          const stub=Object.assign(new EventTarget(), { height:${viewport.height - viewport.inset}, width:${viewport.width}, offsetTop:0, offsetLeft:0, scale:1, pageTop:0, pageLeft:0 });
          Object.defineProperty(window, 'visualViewport', { configurable:true, value:stub }); window.dispatchEvent(new Event('resize'));
        })()`)
        if (state === "jump") {
          const reader = await page.evaluate<{ x: number; y: number }>(`(() => { const rect=document.querySelector('.workspace__scroll').getBoundingClientRect(); return { x:rect.left+3, y:rect.top+rect.height/2 }; })()`)
          await page.wheel(reader.x, reader.y, 0, -600)
          await wait(page, `document.querySelector('.conversation-jump-slot .transcript-navigation__controls--visible [aria-label="Jump to latest"]') !== null`)
        }
        const geometry = await page.evaluate<KeyboardGeometry>(keyboardGeometry())
        if (state === "attachment") {
          expect(geometry.attachmentCount).toBe(2)
          expect(geometry.attachmentProblems, JSON.stringify(geometry)).toEqual([])
        }
        expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(viewport.height - viewport.inset + 1)
        if (viewport.width >= 360) expect(geometry.toggleTop, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.capsuleBottom - 0.5)
        expect(geometry.scrollContainer).toBe(false)
        expect(geometry.smallTargets, JSON.stringify(geometry)).toEqual([])
        expect(geometry.overlaps, JSON.stringify(geometry)).toEqual([])
        expect(geometry.coveredTargets, JSON.stringify(geometry)).toEqual([])
      } finally { await page.close() }
    }, 15_000)
  }
}

test("closed-keyboard attachment chips truncate long filenames within phone viewports", async () => {
  const files = ["notes.txt", "very-long-attachment-filename-to-exercise-truncation-and-multiple-files.txt"]
  for (const width of [390, 320]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&theme=light`)
      await wait(page, `document.querySelector('.composer-resident .composer__input') !== null`)
      await page.evaluate(`(() => {
        const toggle=document.querySelector('.composer-resident .composer__dock-toggle'); if(toggle.getAttribute('aria-expanded') === 'false') toggle.click();
        const input=document.querySelector('.composer-resident input[type=file]'); const transfer=new DataTransfer();
        for(const name of ${JSON.stringify(files)}) transfer.items.add(new File(['Attachment boundary'], name, { type:'text/plain' }));
        input.files=transfer.files; input.dispatchEvent(new Event('change', { bubbles:true }));
      })()`)
      await wait(page, `document.querySelectorAll('.composer-resident .composer__attachment').length === 2`)
      expect(await page.evaluate<boolean>(`document.querySelector('.app').hasAttribute('data-keyboard-open') || document.documentElement.hasAttribute('data-keyboard-open')`)).toBe(false)
      const attachments = await page.evaluate<{ filename: string; chip: AttachmentBounds; name: AttachmentBounds; size: AttachmentBounds; remove: AttachmentBounds; nameStyle: { overflow: string; textOverflow: string; whiteSpace: string }; reachable: boolean }[]>(`Array.from(document.querySelectorAll('.composer-resident .composer__attachment')).map(chip=>{
        const name=chip.querySelector('.composer__attachment-name'); const size=chip.querySelector('.composer__attachment-size'); const remove=chip.querySelector('button');
        const bounds=node=>{const rect=node.getBoundingClientRect(); return {left:rect.left,right:rect.right,width:rect.width,height:rect.height,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}};
        const style=getComputedStyle(name); const rect=remove.getBoundingClientRect();
        return {filename:name.textContent,chip:bounds(chip),name:bounds(name),size:bounds(size),remove:bounds(remove),nameStyle:{overflow:style.overflow,textOverflow:style.textOverflow,whiteSpace:style.whiteSpace},reachable:remove.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))};
      })`)
      expect(attachments.map((item) => item.filename)).toEqual(files)
      for (const item of attachments) {
        for (const box of [item.chip, item.name, item.size, item.remove]) {
          expect(box.left, JSON.stringify({ width, item })).toBeGreaterThanOrEqual(0)
          expect(box.right, JSON.stringify({ width, item })).toBeLessThanOrEqual(width)
        }
        expect(item.chip.scrollWidth).toBeLessThanOrEqual(item.chip.clientWidth)
        expect(item.size.scrollWidth).toBeLessThanOrEqual(item.size.clientWidth)
        expect(item.remove.scrollWidth).toBeLessThanOrEqual(item.remove.clientWidth)
        expect(item.name.width).toBeGreaterThan(0)
        expect(item.nameStyle).toEqual({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })
        if (item.filename === files[1]) expect(item.name.scrollWidth).toBeGreaterThan(item.name.clientWidth)
        expect(item.remove.width).toBeGreaterThanOrEqual(44)
        expect(item.remove.height).toBeGreaterThanOrEqual(44)
        expect(item.reachable, JSON.stringify({ width, item })).toBe(true)
      }
    } finally { await page.close() }
  }
}, 15_000)

async function openEffort(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>) {
  await page.evaluate(`(() => { const chip=document.querySelector('.composer-resident .composer__effort'); if (chip.getAttribute('aria-expanded') === 'false') chip.click() })()`)
  await wait(page, `(() => { const panel=document.querySelector('.composer-resident .composer__effort-panel'), content=document.querySelector('.composer-resident .reasoning-effort'); return content !== null && panel.getBoundingClientRect().height >= content.getBoundingClientRect().height - 1 && getComputedStyle(panel).opacity === '1' })()`)
}

type AttachmentBounds = { left: number; right: number; width: number; height: number; scrollWidth: number; clientWidth: number }

test("queued status spans the keyboard-open draft row on phones", async () => {
  for (const viewport of [{ width: 390, height: 844, inset: 424 }, { width: 320, height: 700, inset: 280 }]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(viewport.width, viewport.height)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-1440`)
      await wait(page, `document.querySelector('.composer-resident .composer__effort') !== null`)
      await page.evaluate(`(() => {
        document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove();
        const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden';
        const toggle=document.querySelector('.composer-resident .composer__dock-toggle'); if(toggle.getAttribute('aria-expanded') === 'false') toggle.click();
        window.remoteComposerState('queued');
        const stub=Object.assign(new EventTarget(), { height:${viewport.height - viewport.inset}, width:${viewport.width}, offsetTop:0, offsetLeft:0, scale:1, pageTop:0, pageLeft:0 });
        Object.defineProperty(window, 'visualViewport', { configurable:true, value:stub }); window.dispatchEvent(new Event('resize'));
      })()`)
      await wait(page, `document.querySelector('.composer-resident .composer__queue-indicator') !== null`)
      const indicator = await page.evaluate<{ width: number; height: number }>(`(() => { const rect=document.querySelector('.composer-resident .composer__queue-indicator').getBoundingClientRect(); return { width:rect.width, height:rect.height }; })()`)
      expect(indicator.width).toBeGreaterThanOrEqual(200)
      expect(indicator.height).toBeLessThanOrEqual(24)
      const geometry = await page.evaluate<KeyboardGeometry>(keyboardGeometry())
      expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(viewport.height - viewport.inset + 1)
      if (viewport.width >= 360) expect(geometry.toggleTop, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.capsuleBottom - 0.5)
      expect(geometry.scrollContainer).toBe(false)
      expect(geometry.smallTargets, JSON.stringify(geometry)).toEqual([])
      expect(geometry.overlaps, JSON.stringify(geometry)).toEqual([])
      expect(geometry.coveredTargets, JSON.stringify(geometry)).toEqual([])
    } finally { await page.close() }
  }
}, 15_000)

type KeyboardGeometry = {
  bottom: number
  toggleTop: number
  capsuleBottom: number
  scrollContainer: boolean
  smallTargets: string[]
  overlaps: string[]
  coveredTargets: string[]
  attachmentCount: number
  attachmentProblems: string[]
}

function keyboardGeometry() {
  return `(() => {
    const composer=document.querySelector('.composer-resident .composer');
    const capsule=composer.querySelector('.composer__row').getBoundingClientRect();
    const toggle=composer.querySelector('.composer__dock-toggle').getBoundingClientRect();
    const visible=node=>{const rect=node.getBoundingClientRect(); return rect.width>0&&rect.height>0&&node.checkVisibility({opacityProperty:true,visibilityProperty:true})};
    const controls=[...composer.querySelectorAll('button,input[type=range],textarea'),...document.querySelectorAll('.conversation-jump-slot .transcript-navigation__controls--visible button')].filter(visible);
    const label=node=>node.getAttribute('aria-label')||node.textContent.trim()||node.className;
    const intersects=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0.5;
    const overlaps=[];
    for(const control of controls.filter(node=>node.closest('.conversation-jump-slot')))if(intersects(control.getBoundingClientRect(),composer.getBoundingClientRect()))overlaps.push(label(control)+' / composer');
    for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++)if(intersects(controls[i].getBoundingClientRect(),controls[j].getBoundingClientRect()))overlaps.push(label(controls[i])+' / '+label(controls[j]));
    const walker=document.createTreeWalker(composer,NodeFilter.SHOW_TEXT);
    for(let text=walker.nextNode();text;text=walker.nextNode()){
      if(!text.textContent.trim()||!visible(text.parentElement)||text.parentElement.closest('.visually-hidden'))continue;
      const range=document.createRange();range.selectNodeContents(text);
      const rects=[...range.getClientRects()].map(rect=>{let box={left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};for(let parent=text.parentElement;parent&&parent!==composer;parent=parent.parentElement){const style=getComputedStyle(parent);const clip=parent.getBoundingClientRect();if(style.overflowX!=='visible'){const ellipsis=style.textOverflow==='ellipsis';box.left=Math.max(box.left,clip.left+(ellipsis?parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth):0));box.right=Math.min(box.right,clip.right-(ellipsis?parseFloat(style.paddingRight)+parseFloat(style.borderRightWidth):0))}if(style.overflowY!=='visible'){box.top=Math.max(box.top,clip.top);box.bottom=Math.min(box.bottom,clip.bottom)}}return box});
      for(const control of controls){if(control.contains(text.parentElement))continue;if(rects.some(rect=>intersects(control.getBoundingClientRect(),rect)))overlaps.push(label(control)+' / '+text.textContent.trim())}
    }
    const style=getComputedStyle(composer);
    const attachments=[...composer.querySelectorAll('.composer__attachment')];
    const attachmentProblems=attachments.filter(node=>{const name=node.querySelector('.composer__attachment-name');const remove=node.querySelector('button');const rect=remove.getBoundingClientRect();return !visible(node)||name.getBoundingClientRect().width<24||!visible(remove)||rect.width<43.5||rect.height<43.5||!remove.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))}).map(node=>node.textContent.trim());
    return {bottom:composer.getBoundingClientRect().bottom,toggleTop:toggle.top,capsuleBottom:capsule.bottom,scrollContainer:['auto','scroll'].includes(style.overflowY)||['auto','scroll'].includes(getComputedStyle(composer.closest('.composer-resident')).overflowY),smallTargets:controls.filter(node=>{const rect=node.getBoundingClientRect();return rect.width<43.5||rect.height<43.5}).map(label),overlaps,coveredTargets:controls.filter(node=>{const rect=node.getBoundingClientRect();const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return !node.contains(hit)}).map(label),attachmentCount:attachments.length,attachmentProblems};
  })()`
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok).catch(() => false)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 120; index++) {
    if (await page.evaluate<boolean>(expression).catch(() => false)) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
