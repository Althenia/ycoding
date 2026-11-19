import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeNumber, decodeRecord, decodeString } from "./cdp"

const port = 4617
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome for Testing executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then(response => response.ok, () => false)) { browser = await launchBrowser(executable, 390, 844); return }
    await Bun.sleep(100)
  }
  throw new Error("The local mobile fixture did not start")
}, 30_000)
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function until(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate(expression)) return
    await Bun.sleep(40)
  }
  throw new Error(`Mobile state did not settle: ${expression}`)
}
async function open(query: string, width = 390, height = 844) {
  const page = await browser!.openPage()
  await page.setViewport(width, height)
  await page.setCoarsePointer(true)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=dark&${query}`)
  await until(page, `!!document.querySelector('.app > .bottom-nav')`)
  await page.evaluate(`document.querySelector('.fixture-banner')?.remove(); document.querySelector('.fixture-controls')?.remove()`)
  return page
}
const named = (name: string) => `[...document.querySelectorAll('button,a')].find(element=>element.getClientRects().length&&!element.closest('[inert]')&&(element.getAttribute('aria-label')||element.textContent).trim()===${JSON.stringify(name)})`
const click = (page: Page, name: string) => page.evaluate(`${named(name)}.click()`)
async function settled(page: Page) {
  await page.evaluate(`Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))`)
}
async function swipe(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.touch("touchStart", x, y)
  for (let step = 1; step <= 6; step++) { await page.touch("touchMove", x + dx * step / 6, y + dy * step / 6); await Bun.sleep(16) }
  await page.touch("touchEnd")
}
async function dismissDown(page: Page, selector = "dialog[open] .overlay__head") {
  await settled(page)
  const point = await page.evaluate(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+12}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, x: (decodeNumber)(record["x"]), y: (decodeNumber)(record["y"]) } })
  await swipe(page, point.x, point.y, 0, 90)
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(`document.documentElement.scrollWidth-document.documentElement.clientWidth`)).toBeLessThanOrEqual(1)
}
async function touchTargets(page:Page,selector:string){
  expect(await page.evaluate(`([...document.querySelectorAll(${JSON.stringify(selector)})].filter(node=>node.getClientRects().length).map(node=>{const box=node.getBoundingClientRect();return {name:node.getAttribute('aria-label')??node.textContent,width:box.width,height:box.height}}).filter(box=>box.width<44||box.height<44))`)).toEqual([])
}

test("phone header, composer and companion keep every action touch-sized with neutral focus return", async () => {
  const page = await open("view=chat&paletteAcceptance=1&team=two&acceptedPreview=1")
  try {
    await until(page, `!!document.querySelector('.companion-context-trigger') && !!document.querySelector('.composer__input')`)
    for (const selector of [".companion-context-trigger", ".yc-notification-center__trigger", '[aria-label="Open Team"]', ".composer__attach", ".mini-composer__send"]) {
      expect(await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(element=>element.getClientRects().length)`)).toBe(true)
      await touchTargets(page, selector)
    }
    await page.pressKey("Tab", "Tab", 9)
    await page.evaluate(`document.querySelector('.companion-context-trigger').focus({preventScroll:true})`)
    expect(await page.evaluate(`(()=>{const button=document.querySelector('.companion-context-trigger'),style=getComputedStyle(button);return button.matches(':focus-visible')&&parseFloat(style.outlineWidth)>=2&&style.getPropertyValue('--yc-focus').trim()===style.getPropertyValue('--yc-border-strong').trim()})()`)).toBe(true)
    await click(page, "Open Session context")
    await until(page, `!!document.querySelector('dialog[open] .companion')`)
    await touchTargets(page, 'dialog[open] .companion button,dialog[open] .overlay__head button')
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open]')`)
    expect(await page.evaluate(`document.activeElement===document.querySelector('.companion-context-trigger')`)).toBe(true)
    await noOverflow(page)
  } finally { await page.close() }
}, 30_000)

test("phone destinations keep five single-line 56px targets and switch views", async () => {
  const page = await open("view=chat&paletteAcceptance=1", 320)
  try {
    for (const width of [320, 390, 430]) {
      await page.setViewport(width, 844)
      const nav = await page.evaluate(`(()=>{const nav=document.querySelector('.app > .bottom-nav'), links=[...nav.querySelectorAll('.bottom-nav__item')];return {labels:links.map(el=>el.innerText.trim()),heights:links.map(el=>el.getBoundingClientRect().height),widths:links.map(el=>el.getBoundingClientRect().width),lines:links.map(el=>{const range=document.createRange();range.selectNodeContents(el.querySelector('.bottom-nav__label'));return range.getClientRects().length}),touch:links.map(el=>getComputedStyle(el).touchAction),taps:links.map(el=>getComputedStyle(el).webkitTapHighlightColor),height:nav.getBoundingClientRect().height,padding:parseFloat(getComputedStyle(nav).paddingBottom)}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, labels: (decodeArray(decodeString))(record["labels"]), heights: (decodeArray(decodeNumber))(record["heights"]), widths: (decodeArray(decodeNumber))(record["widths"]), lines: (decodeArray(decodeNumber))(record["lines"]), touch: (decodeArray(decodeString))(record["touch"]), taps: (decodeArray(decodeString))(record["taps"]), height: (decodeNumber)(record["height"]), padding: (decodeNumber)(record["padding"]) } })
      expect(nav.labels).toEqual(["Projects", "Sessions", "Workspaces", "Usage", "Settings"])
      expect(nav.lines).toEqual([1, 1, 1, 1, 1])
      expect(nav.heights).toEqual([56, 56, 56, 56, 56])
      expect(Math.min(...nav.widths)).toBeGreaterThanOrEqual(44)
      expect(nav.height - nav.padding).toBe(56)
      expect(nav.touch).toEqual(Array(5).fill("manipulation"))
      expect(nav.taps).toEqual(Array(5).fill("rgba(0, 0, 0, 0)"))
      expect(await page.evaluate(`document.querySelector('.workspace__topbar').getBoundingClientRect().height`)).toBe(56)
      await noOverflow(page)
    }
    await page.setViewport(320,844)
    for (const destination of ["projects", "sessions", "workspaces", "usage", "settings"]) {
      await page.evaluate(`document.querySelector('.app > .bottom-nav a[href="/remote/${destination}"]').click()`)
      await until(page, `document.querySelector('.app > .bottom-nav a[href="/remote/${destination}"]')?.getAttribute('aria-current')==='page'`)
      await touchTargets(page,'.app-header button,.app-header a[href]')
      if(destination==='sessions'){
        await click(page,'Open sessions')
        await until(page,`!!document.querySelector('dialog[open] .session-row')`)
        await touchTargets(page,'dialog[open] .session-filters__option')
        await page.pressEscape()
        await until(page,`!document.querySelector('dialog[open]')`)
      }
      await noOverflow(page)
    }
  } finally { await page.close() }
}, 60_000)

test("Sessions drawer preserves search and scroll through swipe-left and scrim dismissal", async () => {
  const page = await open("view=chat&inventoryCount=1000&paletteAcceptance=1")
  try {
    await page.setViewport(320,844)
    await click(page, "Open sessions")
    await until(page, `!!document.querySelector('dialog[open] .sessions-drawer__list .session-row')`)
    await settled(page)
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.sessions-drawer__list')).overscrollBehaviorY`)).toBe("contain")
    await touchTargets(page,'dialog[open] .session-filters__option')
    const bounds = await page.evaluate(`(()=>{const box=document.querySelector('.overlay--sessions-sheet .overlay__surface').getBoundingClientRect();return {width:box.width,height:box.height,top:box.top}})()`)
    expect(bounds).toEqual({ width: 276, height: 844, top: 0 })
    await page.evaluate(`(()=>{const input=document.querySelector('dialog[open] [aria-label="Search sessions"]');input.value='Inventory Session 4';input.dispatchEvent(new InputEvent('input',{bubbles:true}))})()`)
    await until(page, `!!document.querySelector('dialog[open] [data-session-id="ses_inventory_4"]')`)
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open]')`)
    await settled(page)
    await click(page, "Open sessions")
    await until(page, `!!document.querySelector('dialog[open] .sessions-drawer__list')`)
    expect(await page.evaluate(`document.querySelector('dialog[open] [aria-label="Search sessions"]').value`)).toBe("Inventory Session 4")
    await page.evaluate(`(()=>{const input=document.querySelector('dialog[open] [aria-label="Search sessions"]');input.value='';input.dispatchEvent(new InputEvent('input',{bubbles:true}))})()`)
    await until(page, `!!document.querySelector('dialog[open] [data-session-id="ses_inventory_0"]')`)
    await page.evaluate(`document.querySelector('.sessions-drawer__list').scrollTop=300`)
    await until(page, `document.querySelector('.sessions-drawer__list').scrollTop>200`)
    const anchor = await page.evaluate(`(()=>{const root=document.querySelector('.sessions-drawer__list'),bounds=root.getBoundingClientRect(),row=[...root.querySelectorAll('[data-session-id]')].find(row=>row.getBoundingClientRect().bottom>bounds.top);return {id:row.dataset.sessionId,offset:row.getBoundingClientRect().top-bounds.top}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, id: (decodeString)(record["id"]), offset: (decodeNumber)(record["offset"]) } })
    await swipe(page, 240, 360, -160, 2)
    await until(page, `!document.querySelector('dialog[open].overlay--sessions-sheet')`)
    expect(await page.evaluate(`document.activeElement?.getAttribute('aria-label')==='Open sessions'`)).toBe(true)
    await settled(page)
    await click(page, "Open sessions")
    await until(page, `!!document.querySelector('dialog[open] .sessions-drawer__list')`)
    await settled(page)
    expect(await page.evaluate(`document.querySelector('dialog[open] [aria-label="Search sessions"]').value`)).toBe("")
    expect(Math.abs(await page.evaluate(`(()=>{const root=document.querySelector('.sessions-drawer__list'),row=[...root.querySelectorAll('[data-session-id]')].find(row=>row.dataset.sessionId===${JSON.stringify(anchor.id)});return row.getBoundingClientRect().top-root.getBoundingClientRect().top})()`, decodeNumber) - anchor.offset)).toBeLessThanOrEqual(1)
    await page.touch("touchStart", 310, 300)
    await page.touch("touchEnd")
    await until(page, `!document.querySelector('dialog[open].overlay--sessions-sheet')`)
  } finally { await page.close() }
}, 45_000)

test("composer and model command sheets retain drafts, focus and reduced-motion dismissal", async () => {
  const page = await open("view=chat&paletteAcceptance=1")
  try {
    await until(page, `!!document.querySelector('.composer-resident textarea')`)
    expect(await page.evaluate(`parseFloat(getComputedStyle(document.querySelector('.composer-resident textarea')).fontSize)`)).toBeGreaterThanOrEqual(16)
    await page.evaluate(`(()=>{const field=document.querySelector('.composer-resident textarea');field.focus();field.value='Keep my mobile draft';field.dispatchEvent(new InputEvent('input',{bubbles:true}))})()`)
    await click(page, "Hide composer")
    await until(page, `document.querySelector('.composer--collapsed')!==null`)
    await click(page, "Show composer")
    await until(page, `document.activeElement===document.querySelector('.composer-resident textarea')`)
    await page.evaluate(`document.querySelector('.composer-resident .composer__mobile-trigger').click()`)
    await until(page, `!!document.querySelector('dialog[open][aria-label="Choose agent and model"]')`)
    await dismissDown(page)
    await until(page, `!document.querySelector('dialog[open]')`)
    await settled(page)
    await page.evaluate(`document.querySelector('.composer-resident .model-control__trigger').click()`)
    await until(page, `!!document.querySelector('dialog[open][aria-label="Choose model"]')`)
    await dismissDown(page)
    await until(page, `!document.querySelector('dialog[open]')`)
    await settled(page)
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await until(page, `!!document.querySelector('dialog[open].overlay--command-palette')`)
    expect(await page.evaluate(`parseFloat(getComputedStyle(document.querySelector('#command-palette-input')).fontSize)`)).toBeGreaterThanOrEqual(16)
    await dismissDown(page)
    await until(page, `!document.querySelector('dialog[open]')`)
    expect(await page.evaluate(`document.querySelector('.composer-resident textarea').value`)).toBe("Keep my mobile draft")
    expect(await page.evaluate(`window.remoteMutationReport().filter(item=>['session.prompt','session.switchModel','session.command'].includes(item.operation)).length`)).toBe(0)
    await page.setViewport(844, 390)
    await noOverflow(page)
    expect(await page.evaluate(`parseFloat(getComputedStyle(document.querySelector('.composer-resident textarea')).fontSize)`)).toBeGreaterThanOrEqual(16)
  } finally { await page.close() }
}, 60_000)

test("Projects and Coordination show phone detail with explicit return and preserved list scroll", async () => {
  const page = await open("scenario=coordination-projects-390")
  try {
    await until(page, `document.querySelectorAll('.project-card').length===2`)
    await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop=120`)
    const top = await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop`, decodeNumber)
    await click(page, "View project Release train")
    await until(page, `!!document.querySelector('dialog[open][aria-label="Release train"] .project-panel')`)
    await click(page, "Expand project coordination")
    await until(page, `!!document.querySelector('dialog[open][aria-label="Project coordination"]')`)
    await page.evaluate(`document.querySelector('dialog[aria-label="Project coordination"] [data-action="inspect-member"]').click()`)
    await until(page, `!!document.querySelector('.project-coordination__inspector')`)
    expect(await page.evaluate(`(()=>{const master=document.querySelector('.project-coordination__master'),inspector=document.querySelector('.project-coordination__inspector'),body=inspector.closest('.overlay__body');return !master.getClientRects().length && Math.abs(inspector.getBoundingClientRect().top-body.getBoundingClientRect().top-parseFloat(getComputedStyle(body).paddingTop))<=1})()`)).toBe(true)
    await click(page, "Back to members")
    await until(page, `!document.querySelector('.project-coordination__inspector')`)
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open][aria-label="Project coordination"]')`)
    await settled(page)
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open]')`)
    expect(Math.abs(await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop`, decodeNumber) - top)).toBeLessThanOrEqual(1)
    await settled(page)
    await click(page, "Open project Release train")
    await until(page, `!!document.querySelector('.workspace__topbar.project-topbar')`)
    const headerHeight = `document.querySelector('.workspace__topbar.project-topbar').getBoundingClientRect().height`
    const expandedHeight = await page.evaluate(headerHeight, decodeNumber)
    await click(page, "Project identity details")
    await settled(page)
    expect(await page.evaluate(headerHeight, decodeNumber)).toBeLessThan(expandedHeight)
    expect(await page.evaluate(`document.querySelector('.project-topbar .project-phone').getBoundingClientRect().height`, decodeNumber)).toBeGreaterThanOrEqual(44)
    await noOverflow(page)
  } finally { await page.close() }
}, 45_000)

test("Workspaces detail closes back to the retained list and opens its genuine Sessions filter", async () => {
  const page = await open("view=workspaces&workspaces=many", 320)
  try {
    await until(page, `document.querySelectorAll('.workspaces-page .workspace-nav__item').length>2`)
    await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop=80`)
    const top = await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop`, decodeNumber)
    await page.evaluate(`document.querySelector('.workspaces-page .workspace-nav__item button').click()`)
    await until(page, `!!document.querySelector('dialog[open].overlay--workspace-details')`)
    expect(await page.evaluate(`document.querySelector('dialog[open]').innerText.includes('/workspace/')`)).toBe(true)
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open]')`)
    expect(Math.abs(await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop`, decodeNumber) - top)).toBeLessThanOrEqual(1)
    await settled(page)
    await page.evaluate(`document.querySelector('.workspaces-page .workspace-nav__item button').click()`)
    await until(page, `!!document.querySelector('dialog[open].overlay--workspace-details')`)
    await click(page, "Open workspace Sessions")
    await until(page, `!!document.querySelector('.sessions-page__workspace-select')`)
    await noOverflow(page)
  } finally { await page.close() }
}, 45_000)

test("Usage and Settings keep stacked figures, detail sheets, full machine rows and touch switches", async () => {
  const page = await open("view=usage&spend=large", 320)
  try {
    for (const width of [320, 390]) {
      await page.setViewport(width, 844)
      await until(page, `document.querySelectorAll('.usage-distribution__legend li').length>0`)
      await noOverflow(page)
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.usage-providers')).gridTemplateColumns.split(' ').length===1`)).toBe(true)
      await page.evaluate(`document.querySelector('.usage-provider .usage-details-trigger').click()`)
      await until(page, `!!document.querySelector('dialog[open].overlay--usage-details')`)
      await settled(page)
      expect(await page.evaluate(`(()=>{const box=document.querySelector('dialog[open] .overlay__surface').getBoundingClientRect();return box.bottom<=innerHeight+1 && box.top>=0})()`)).toBe(true)
      await dismissDown(page)
      await until(page, `!document.querySelector('dialog[open]')`)
      await settled(page)
    }
    await page.evaluate(`document.querySelector('.app > .bottom-nav a[href="/remote/settings"]').click()`)
    await until(page, `!!document.querySelector('.machine-row')`)
    expect(await page.evaluate(`(() => {
      const list = document.querySelector('.machine-row');
      const owner = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll('li')];
      return { noHorizontalScroll: list.scrollWidth === list.clientWidth, rows: rows.map((row, index) => {
        const box = row.getBoundingClientRect();
        const name = row.querySelector('.machine-row__name');
        const action = row.querySelector('.machine-row__connect');
        const button = action.getBoundingClientRect();
        return { name: name.textContent, action: action.textContent, stacked: index === 0 || box.top > rows[index - 1].getBoundingClientRect().bottom, visible: box.left >= owner.left && box.right <= owner.right && button.right <= box.right && name.scrollWidth <= name.clientWidth && button.height >= 44 };
      }) };
    })()`)).toEqual({ noHorizontalScroll: true, rows: [
      { name: "Studio Mac", action: "Connected", stacked: true, visible: true },
      { name: "Laptop", action: "Connect", stacked: true, visible: true },
    ] })
    const matrix = await page.evaluate(`(()=>{const table=document.querySelector('.notification-table');return {headers:[...table.querySelectorAll('thead th')].slice(1).map(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length}),targets:[...table.querySelectorAll('label.switch')].map(el=>el.getBoundingClientRect().height)}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, headers: (decodeArray(decodeNumber))(record["headers"]), targets: (decodeArray(decodeNumber))(record["targets"]) } })
    expect(Math.min(...matrix.targets)).toBeGreaterThanOrEqual(44)
    expect(matrix.headers.every(lines => lines === 1)).toBe(true)
    await noOverflow(page)
  } finally { await page.close() }
}, 60_000)

test("public phone top bars retain navigation, article contents and changelog filter sheets", async () => {
  const page = await browser!.openPage()
  try {
    await page.setCoarsePointer(true)
    for (const [path, width] of [["/", 320], ["/docs", 390], ["/docs/quickstart", 320], ["/changelog", 390], ["/not-a-route", 320]] as const) {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}${path}`)
      await until(page, `!!document.querySelector('.marketing .app-header__menu')`)
      await noOverflow(page)
      await click(page, "Navigation")
      await until(page, `!!document.querySelector('dialog[open][aria-label="Navigation"]')`)
      await settled(page)
      expect(await page.evaluate(`document.querySelector('dialog[open] .overlay__surface').getBoundingClientRect().height`)).toBeLessThan(844)
      await dismissDown(page)
      await until(page, `!document.querySelector('dialog[open]')`)
      await settled(page)
      if (path === "/docs/quickstart") {
        await click(page, "On this page")
        await until(page, `!!document.querySelector('dialog[open][aria-label="On this page"] a[href^="#"]')`)
        await page.evaluate(`document.querySelector('dialog[open] a[href^="#"]').click()`)
        await until(page, `!document.querySelector('dialog[open]')`)
      }
      if (path === "/changelog") {
        await click(page, "Filters")
        await until(page, `!!document.querySelector('dialog[open][aria-label="Filters"]')`)
        await click(page, "Fixed")
        await page.pressEscape()
        await until(page, `!document.querySelector('dialog[open]')`)
      }
    }
  } finally { await page.close() }
}, 90_000)

test("native visual-viewport events keep focused controls above an occluded viewport with real safe-area insets", async () => {
  const page = await browser!.openPage()
  try {
    await page.setMobileViewport(390, 844)
    await page.setSafeAreaInsets(24, 20)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&paletteAcceptance=1&theme=dark`)
    await until(page, `!!document.querySelector('.composer-resident textarea')`)
    await page.evaluate(`document.querySelector('.fixture-banner')?.remove(); document.querySelector('.fixture-controls')?.remove()`)
    const safe = await page.evaluate(`({header:parseFloat(getComputedStyle(document.querySelector('.workspace__topbar')).paddingTop),bottom:parseFloat(getComputedStyle(document.querySelector('.app > .bottom-nav')).paddingBottom)})`)
    expect(safe).toEqual({ header: 24, bottom: 20 })
    await page.evaluate(`document.querySelector('.composer-resident textarea').focus()`)
    await page.pinch(190, 350, 1.5)
    await until(page, `visualViewport.height<innerHeight-100 && visualViewport.offsetTop>0`)
    await until(page, `getComputedStyle(document.querySelector('.app > .bottom-nav')).display==='none'`)
    expect(await page.evaluate(`(()=>{const viewport=visualViewport,box=document.querySelector('.composer-resident textarea').getBoundingClientRect();return box.bottom<=viewport.offsetTop+viewport.height+1})()`)).toBe(true)
    await page.evaluate(`document.querySelector('.composer-resident .model-control__trigger').click()`)
    await until(page, `!!document.querySelector('dialog[open][aria-label="Choose model"]')`)
    await settled(page)
    expect(await page.evaluate(`(()=>{const viewport=visualViewport,box=document.querySelector('dialog[open] .overlay__surface').getBoundingClientRect();return box.top>=viewport.offsetTop-1&&box.bottom<=viewport.offsetTop+viewport.height+1})()`)).toBe(true)
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open]')`)
  } finally { await page.close() }
}, 45_000)

test("phone Team inspection has an explicit return to the retained direct-child list", async () => {
  const page = await open("view=chat&paletteAcceptance=1&team=two&childTranscript=ready&childQuestion=1")
  try {
    await page.setReducedMotion(true)
    await click(page, "Open Team")
    await until(page, `!!document.querySelector('dialog[open][aria-label="Team"]')`)
    await touchTargets(page,'dialog[open] .companion__pill')
    await click(page, "Expand Team")
    await until(page, `!!document.querySelector('dialog[open][aria-label="Team overview"] [data-action="inspect-child"]')`)
    expect(await page.evaluate(`(() => {
      const usage = document.querySelector('dialog[open][aria-label="Team overview"] .team-overview__child .team-view__usage');
      const labels = [...usage.querySelectorAll('dt')];
      return {
        stacked: labels[2].getBoundingClientRect().top > labels[0].getBoundingClientRect().top,
        readable: labels.every(label => label.scrollWidth <= label.clientWidth),
      };
    })()`)).toEqual({ stacked: true, readable: true })
    await page.evaluate(`document.querySelector('dialog[aria-label="Team overview"] [data-action="inspect-child"]').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await until(page, `document.querySelector('.team-overview__inspector .team-conversation__message') !== null && document.activeElement === document.querySelector('.team-overview__back')`)
    expect(await page.evaluate(`!document.querySelector('.team-overview__children').getClientRects().length`)).toBe(true)
    const inspectorGeometry = await page.evaluate(`(() => {
      const inspector = document.querySelector('.team-overview__inspector');
      const body = inspector.closest('.overlay__body');
      const focus = document.activeElement;
      const style = getComputedStyle(focus);
      const ringStart = focus.getBoundingClientRect().left - parseFloat(style.outlineWidth) - parseFloat(style.outlineOffset);
      return {
        ringVisible: focus.matches(':focus-visible') && style.outlineStyle === 'solid' && [inspector, body].every(node => getComputedStyle(node).overflowX === 'visible' || ringStart >= node.getBoundingClientRect().left + node.clientLeft),
        verticalOwners: [inspector, body].filter(node => node.scrollHeight > node.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)).length,
      };
    })()`)
    const headerTop = `document.querySelector('dialog[aria-label="Team overview"] .overlay__head').getBoundingClientRect().top`
    const fixedHeader = await page.evaluate(headerTop)
    await page.pressKey("End", "End", 35)
    await until(page, `(() => {
      const inspector = document.querySelector('.team-overview__inspector');
      return [inspector, inspector.closest('.overlay__body')].some(node => node.scrollTop > 0 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1);
    })()`)
    const reachedEnd = await page.evaluate(`(() => {
      const inspector = document.querySelector('.team-overview__inspector');
      const body = inspector.closest('.overlay__body');
      return body.scrollTop > 0 && inspector.scrollTop === 0 && inspector.lastElementChild.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + body.clientHeight + 1;
    })()`)
    expect(await page.evaluate(headerTop)).toBe(fixedHeader)
    await page.pressKey("Home", "Home", 36)
    await click(page, "Back to children")
    await until(page, `!document.querySelector('.team-overview__inspector')`)
    expect(await page.evaluate(`document.activeElement?.getAttribute('data-action')`)).toBe("inspect-child")
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open][aria-label="Team overview"]')`)
    await settled(page)
    const activity = await page.evaluate(`(() => {
      const body = document.querySelector('dialog[open][aria-label="Team"] .overlay__body');
      const start = body.getBoundingClientRect().left + body.clientLeft;
      return {
        fits: body.scrollWidth === body.clientWidth && [...body.querySelectorAll('.companion__header, .rl-pane-tabs-row')].every(band => { const box = band.getBoundingClientRect(); return box.left >= start && box.right <= start + body.clientWidth; }),
        focused: document.activeElement === body.querySelector('[aria-label="Expand Team"]') && document.activeElement.matches(':focus-visible'),
      };
    })()`)
    await page.pressEscape()
    await until(page, `!document.querySelector('dialog[open]')`)
    expect(await page.evaluate(`document.activeElement?.getAttribute('aria-label')`)).toBe("Open Team")
    await noOverflow(page)
    expect({ inspectorGeometry, reachedEnd, activity }).toEqual({ inspectorGeometry: { ringVisible: true, verticalOwners: 1 }, reachedEnd: true, activity: { fits: true, focused: true } })
  } finally { await page.close() }
}, 45_000)

test("a selector handle swipe dismisses staged choice without confirming it", async () => {
  const page = await open("scenario=session-list-390")
  try {
    await until(page, `!!document.querySelector('.sessions-page [aria-label="Workspace"]')`)
    const label = await page.evaluate(`document.querySelector('.sessions-page [aria-label="Workspace"]').textContent`)
    await page.evaluate(`document.querySelector('.sessions-page [aria-label="Workspace"]').click()`)
    await until(page, `!!document.querySelector('dialog[open].custom-select__dialog')`)
    await page.evaluate(`document.querySelector('dialog[open] [role="option"][aria-selected="false"]').click()`)
    await settled(page)
    const handle = await page.evaluate(`(()=>{const surface=document.querySelector('dialog[open] .overlay__surface'),box=surface.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+parseFloat(getComputedStyle(surface).paddingTop)+parseFloat(getComputedStyle(surface,'::before').height)/2}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, x: (decodeNumber)(record["x"]), y: (decodeNumber)(record["y"]) } })
    await swipe(page, handle.x, handle.y, 0, 90)
    await until(page, `!document.querySelector('dialog[open]')`)
    expect(await page.evaluate(`document.querySelector('.sessions-page [aria-label="Workspace"]').textContent`)).toBe(label)
    expect(await page.evaluate(`document.activeElement===document.querySelector('.sessions-page [aria-label="Workspace"]')`)).toBe(true)
  } finally { await page.close() }
}, 45_000)
