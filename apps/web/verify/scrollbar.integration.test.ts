import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeBoolean, decodeNumber, decodeRecord, decodeString } from "./cdp"

const port = 4473
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900, { scrollbars: true })
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Remote fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("a background Session refresh preserves the sidebar scroll range, rows, and focus", async () => {
  const page = await browser!.openPage()
  try {
    for (const theme of ["light", "dark"]) for (const width of [768, 1440]) for (const reduced of [false, true]) {
      await page.setViewport(width, 900)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&inventoryCount=4&sessionListGate=1&machineName=Personal&theme=${theme}`)
      for (let attempt = 0; attempt < 100 && !await page.evaluate(`window.remotePendingSessionLists?.() > 0`); attempt++) await Bun.sleep(25)
      await page.evaluate(`window.remoteReleaseSessionList()`)
      for (let attempt = 0; attempt < 100 && !await page.evaluate(`window.providerAuthState().activeSessionID === 'ses_fixture' && window.providerAuthState().sessions.length === 3 && !window.providerAuthState().sessionPageLoading`); attempt++) await Bun.sleep(25)
      await page.evaluate(`document.fonts.ready`)
      await frames(page)
      const height = await page.evaluate(`(() => { const root = document.querySelector('.workspace__rail-body'); return innerHeight - root.clientHeight + root.firstElementChild.getBoundingClientRect().height + 20 })()`, decodeNumber)
      await page.setViewport(width, Math.ceil(height))
      await frames(page)
      await page.evaluate(`(() => {
        window.sidebarRows = [...document.querySelectorAll('.workspace__rail .session-row')]
        window.sidebarRows[1].focus({ preventScroll: true })
        window.sidebarState = () => {
          const root = document.querySelector('.workspace__rail-body')
          const list = root.querySelector('.session-list')
          const state = window.providerAuthState()
          return { height: root.clientHeight, scrollHeight: root.scrollHeight, top: root.scrollTop, width: list.clientWidth,
            listHeight: list.getBoundingClientRect().height, rows: state.sessions.map(row => row.id), workspace: state.selectedWorkspaceID,
            heading: (root.querySelector('.session-list__group')?.textContent ?? ''), footer: [...root.querySelectorAll('.panel__note')].map(note => note.textContent),
            active: state.activeSessionID, focused: document.activeElement === window.sidebarRows[1], retained: window.sidebarRows.every(row => row.isConnected) }
        }
      })()`)
      const before = await page.evaluate(`window.sidebarState()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), scrollHeight: (decodeNumber)(record["scrollHeight"]), rows: (decodeArray(decodeString))(record["rows"]), focused: (decodeBoolean)(record["focused"]) } })
      expect(before.rows).toHaveLength(3)
      expect(before.scrollHeight).toBe(before.height)
      expect(before.focused).toBe(true)
      await page.evaluate(`window.remoteHoldSessionLists(); window.remoteInvalidateSessions()`)
      for (let attempt = 0; attempt < 100 && !await page.evaluate(`window.remotePendingSessionLists() > 0`); attempt++) await Bun.sleep(25)
      expect(await page.evaluate(`window.providerAuthState().sessionPageLoading`)).toBe(true)
      const pending = await page.evaluate(`new Promise(resolve => { const samples = []; const sample = () => { samples.push(window.sidebarState()); if (samples.length === 16) resolve(samples); else requestAnimationFrame(sample) }; requestAnimationFrame(sample) })`, decodeArray((value: unknown) => value))
      await page.evaluate(`window.remoteReleaseSessionList()`)
      for (let attempt = 0; attempt < 100 && await page.evaluate(`window.providerAuthState().sessionPageLoading`, decodeBoolean); attempt++) await Bun.sleep(25)
      await frames(page)
      for (const sample of pending) expect(sample).toEqual(before)
      expect(await page.evaluate(`window.sidebarState()`)).toEqual(before)
    }
  } finally { await page.close() }
}, 40_000)

test("expanded Team inspector draws the owned thumb at rest, under the pointer, and while dragged", async () => {
  const page = await remote("view=chat&presentation=conversation&team=two&childTranscript=1&theme=dark", "Stream remote output safely", 1440, 900, "dark")
  try {
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.team-view__task')`); attempt++) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('[aria-label="Expand Team"]').click()`)
    await page.evaluate(`document.querySelector('.team-overview [data-action="inspect-child"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.team-conversation__message')`); attempt++) await Bun.sleep(50)
    await page.evaluate(`document.fonts.ready`)
    await frames(page)
    const size = await scrollbarSize(page)
    const box = await scrollerBox(page, ".team-overview__inspector")
    expect(box.scrollable).toBe(true)
    expect(box.thickness).toBe(size)
    const y = box.top + 16
    const points = [[box.right - size / 2, y], [box.right - 9, y], [box.right - 1, y], [box.right - size - 3, y]] as const
    const [restCenter, restOuter, restEdge, reference] = await pixels(page, await page.screenshot(), points)
    expect(restCenter).toBe(await tokenColor(page, "--yc-border-strong"))
    expect(restOuter).toBe(reference)
    expect(restEdge).toBe(reference)
    await page.mouse("mouseMoved", box.right - size / 2, y)
    await frames(page)
    const [hoverCenter, hoverOuter, hoverEdge] = await pixels(page, await page.screenshot(), points.slice(0, 3))
    expect(hoverCenter).toBe(await tokenColor(page, "--yc-text-muted"))
    expect(hoverOuter).toBe(await tokenColor(page, "--yc-text-muted"))
    expect(hoverEdge).toBe(reference)
    await page.mouse("mousePressed", box.right - size / 2, y)
    await frames(page)
    const [dragOuter] = await pixels(page, await page.screenshot(), [points[1]])
    await page.mouse("mouseReleased", box.right - size / 2, y)
    expect(dragOuter).toBe(await tokenColor(page, "--yc-green-strong"))
  } finally { await page.close() }
}, 20_000)

test("remote scroll regions draw the owned thumb at rest, under the pointer, and while dragged in both themes", async () => {
  for (const theme of ["light", "dark"] as const) {
    const page = await remote("view=settings&noSelection=1", "System alerts", 1440, 900, theme)
    try {
      const size = await scrollbarSize(page)
      const box = await scrollerBox(page, ".app--settings .workspace__scroll")
      expect(box.scrollable).toBe(true)
      expect(box.thickness).toBe(size)
      const y = Math.round(box.top + 16)
      const low = Math.round(box.bottom - 4)
      const points = [[box.right - size / 2, y], [box.right - 9, y], [box.right - 1, y], [box.right - size - 3, y], [box.right - size / 2, low], [box.right - size - 3, low]] as const
      const [restCenter, restOuter, restEdge, reference, trackEnd, referenceLow] = await pixels(page, await page.screenshot(), points)
      expect(restCenter).toBe(await tokenColor(page, "--yc-border-strong"))
      expect(restOuter).toBe(reference)
      expect(restEdge).toBe(reference)
      expect(trackEnd).toBe(referenceLow)
      await page.mouse("mouseMoved", box.right - size / 2, y)
      await frames(page)
      const [hoverCenter, hoverOuter, hoverEdge] = await pixels(page, await page.screenshot(), points.slice(0, 3))
      expect(hoverCenter).toBe(await tokenColor(page, "--yc-text-muted"))
      expect(hoverOuter).toBe(await tokenColor(page, "--yc-text-muted"))
      expect(hoverEdge).toBe(reference)
      await page.mouse("mousePressed", box.right - size / 2, y)
      await frames(page)
      const [dragOuter] = await pixels(page, await page.screenshot(), [points[1]])
      await page.mouse("mouseReleased", box.right - size / 2, y)
      expect(dragOuter).toBe(await tokenColor(page, "--yc-green-strong"))
    } finally { await page.close() }
  }
}, 60_000)

test("cursor paging still shows loading feedback in the sidebar and Sessions table", async () => {
  for (const view of ["chat", "sessions"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=${view}&inventoryCount=60&sessionListGate=1`)
      for (let attempt = 0; attempt < 100 && !await page.evaluate(`window.remotePendingSessionLists?.() > 0`); attempt++) await Bun.sleep(25)
      const scope = view === "chat" ? ".workspace__rail-body" : ".workspace__scroll"
      expect(await page.evaluate(`[...document.querySelectorAll('${scope} [role=status]')].some(item => item.textContent.includes('Loading sessions'))`)).toBe(true)
      await page.evaluate(`window.remoteReleaseSessionList()`)
      for (let attempt = 0; attempt < 100 && !await page.evaluate(`window.providerAuthState().selectedSessionInfo?.id === 'ses_fixture' && window.providerAuthState().sessionHasNext && !window.providerAuthState().sessionPageLoading`); attempt++) await Bun.sleep(25)
      await frames(page)
      const resident = await page.evaluate(`window.providerAuthState().sessions.length`)
      expect(resident).toBeGreaterThanOrEqual(25)
      await page.evaluate(`(() => { window.remoteHoldSessionLists(); const root = document.querySelector('${scope}'); root.scrollTop = root.scrollHeight; root.dispatchEvent(new WheelEvent('wheel', { deltaY: 250, bubbles: true })); })()`)
      for (let attempt = 0; attempt < 100 && !await page.evaluate(`window.remotePendingSessionLists() > 0`); attempt++) await Bun.sleep(25)
      expect(await page.evaluate(`window.providerAuthState().sessionPaginationLoading`)).toBe(true)
      expect(await page.evaluate(`window.providerAuthState().sessions.length`)).toBe(resident)
      expect(await page.evaluate(`[...document.querySelectorAll('${scope} [role=status]')].some(item => item.textContent.includes('Loading more sessions'))`)).toBe(true)
      await page.evaluate(`window.remoteReleaseSessionList()`)
      for (let attempt = 0; attempt < 100 && await page.evaluate(`window.providerAuthState().sessionPageLoading`, decodeBoolean); attempt++) await Bun.sleep(25)
      expect(await page.evaluate(`window.providerAuthState().sessions.length`)).toBe(31)
      expect(await page.evaluate(`[...document.querySelectorAll('${scope} [role=status]')].some(item => item.textContent.includes('Loading more sessions'))`)).toBe(false)
    } finally { await page.close() }
  }
}, 20_000)

test("the public page and horizontal scroll regions use the same owned scrollbar", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(`http://127.0.0.1:${port}/docs/quickstart`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`document.querySelector('.docs-article') !== null`); attempt += 1) await Bun.sleep(100)
    await frames(page)
    const size = await scrollbarSize(page)
    const viewport = await page.evaluate(`({ width: innerWidth, client: document.documentElement.clientWidth, scrollable: document.documentElement.scrollHeight > innerHeight })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), client: (decodeNumber)(record["client"]), scrollable: (decodeBoolean)(record["scrollable"]) } })
    expect(viewport.scrollable).toBe(true)
    expect(viewport.width - viewport.client).toBe(size)
    const [documentThumb] = await pixels(page, await page.screenshot(), [[viewport.width - size / 2, 16]])
    expect(documentThumb).toBe(await tokenColor(page, "--yc-border-strong"))
    const probe = await page.evaluate(`(() => {
      const probe = document.createElement('div')
      probe.style.cssText = 'position:fixed;left:40px;top:160px;width:240px;height:80px;overflow:auto;background:var(--yc-bg);z-index:2147483647'
      probe.innerHTML = '<div style="width:960px;height:24px"></div>'
      document.body.append(probe)
      const rect = probe.getBoundingClientRect()
      return { left: rect.left, bottom: rect.bottom, thickness: probe.offsetHeight - probe.clientHeight }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), bottom: (decodeNumber)(record["bottom"]), thickness: (decodeNumber)(record["thickness"]) } })
    expect(probe.thickness).toBe(size)
    await frames(page)
    const [horizontalThumb] = await pixels(page, await page.screenshot(), [[probe.left + 16, probe.bottom - size / 2]])
    expect(horizontalThumb).toBe(await tokenColor(page, "--yc-border-strong"))
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('.docs-search-trigger').click()`)
    await page.evaluate(`(()=>{const input=document.querySelector('#docs-search-field');input.value='autonom';input.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`)
    await frames(page)
    const results = await scrollerBox(page, ".search__results")
    expect(results.scrollable).toBe(true)
    expect(results.thickness).toBe(size)
    const [resultThumb] = await pixels(page, await page.screenshot(), [[results.right - size / 2, results.top + 16]])
    expect(resultThumb).toBe(await tokenColor(page, "--yc-border-strong"))
  } finally { await page.close() }
}, 30_000)

test("primary scroll regions keep their content width when overflow appears", async () => {
  for (const [width, height] of [[1440, 900], [1024, 768]] as const) {
    const page = await remote("view=settings&noSelection=1", "System alerts", width, height, "light")
    try {
      const overflowing = await scrollerBox(page, ".app--settings .workspace__scroll")
      expect(overflowing.scrollable).toBe(true)
      await page.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>.app--settings .settings > :not([aria-labelledby="app-settings"]), .app--settings .page-head { display: none; }</style>')`)
      await frames(page)
      const fitting = await scrollerBox(page, ".app--settings .workspace__scroll")
      expect(fitting.scrollable).toBe(false)
      expect(fitting.client).toBe(overflowing.client)
    } finally { await page.close() }
  }
}, 30_000)

test("the Sessions sidebar reserves its scrollbar gutter before its rows overflow", async () => {
  for (const theme of ["light", "dark"] as const) for (const width of [768, 1440]) {
    const page = await remote("view=chat&inventoryCount=4", "Inventory Session", width, 1100, theme)
    try {
      await page.evaluate(`document.fonts.ready`)
      await frames(page)
      const fitting = await scrollerBox(page, ".workspace__rail-body")
      expect(fitting.scrollable).toBe(false)
      const overflowHeight = await page.evaluate(`(() => { const root = document.querySelector('.workspace__rail-body'); return innerHeight - root.clientHeight + root.firstElementChild.getBoundingClientRect().height - 20 })()`, decodeNumber)
      await page.setViewport(width, Math.floor(overflowHeight))
      await frames(page)
      const overflowing = await scrollerBox(page, ".workspace__rail-body")
      expect(overflowing.scrollable).toBe(true)
      expect(overflowing.client).toBe(fitting.client)
      expect(fitting.gutter).toBe("stable")
      expect(overflowing.thickness).toBe(await scrollbarSize(page))
      await page.setViewport(767, 900)
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.workspace__rail-body')).scrollbarGutter`)).toBe("auto")
    } finally { await page.close() }
  }
}, 30_000)

test("the conversation column and composer keep shared edges beside a visible scrollbar", async () => {
  for (const [width, height] of [[1440, 900], [1024, 768]] as const) {
    const page = await remote("view=chat", "Stream remote output safely", width, height, "light")
    try {
      const size = await scrollbarSize(page)
      expect((await scrollerBox(page, ".app--conversation .workspace__scroll")).thickness).toBe(size)
      const edges = await page.evaluate(`(() => {
        const column = document.querySelector('.conversation-pane').getBoundingClientRect()
        const composer = document.querySelector('.composer .composer__row').getBoundingClientRect()
        return { column: [column.left, column.right], composer: [composer.left, composer.right], band: document.querySelector('.workspace__topbar').getBoundingClientRect().right, window: innerWidth }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, column: ((value: unknown) => { const items = decodeArray((item: unknown) => item)(value); if (items.length !== 2) throw new Error("Expected 2 tuple items"); return [(decodeNumber)(items[0]), (decodeNumber)(items[1])] as const })(record["column"]), composer: ((value: unknown) => { const items = decodeArray((item: unknown) => item)(value); if (items.length !== 2) throw new Error("Expected 2 tuple items"); return [(decodeNumber)(items[0]), (decodeNumber)(items[1])] as const })(record["composer"]), band: (decodeNumber)(record["band"]), window: (decodeNumber)(record["window"]) } })
      expect(Math.abs(edges.column[0] - edges.composer[0])).toBeLessThanOrEqual(1)
      expect(Math.abs(edges.column[1] - edges.composer[1])).toBeLessThanOrEqual(1)
      expect(edges.band).toBe(edges.window)
    } finally { await page.close() }
  }
}, 30_000)

test("touch pointers retain owned scrollbars and forced colors use readable system inks", async () => {
  const page = await remote("view=settings&noSelection=1", "System alerts", 1440, 900, "light")
  try {
    const size = await scrollbarSize(page)
    await page.setCoarsePointer(true)
    await frames(page)
    const coarse = await scrollerBox(page, ".app--settings .workspace__scroll")
    expect(coarse.thickness).toBe(size)
    expect(coarse.gutter).toBe("auto")
    await page.setCoarsePointer(false)
    await page.setForcedColors(true)
    await frames(page)
    const forced = await scrollerBox(page, ".app--settings .workspace__scroll")
    expect(forced.thickness).toBeGreaterThan(0)
    expect(forced.gutter).toBe("auto")
    const inks = await page.evaluate(`(()=>{const scroller=document.querySelector('.workspace__scroll'),root=getComputedStyle(document.documentElement);return{thumb:getComputedStyle(scroller,'::-webkit-scrollbar-thumb').backgroundColor,track:getComputedStyle(scroller,'::-webkit-scrollbar-track').backgroundColor,text:root.color,canvas:getComputedStyle(document.body).backgroundColor}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, thumb: (decodeString)(record["thumb"]), track: (decodeString)(record["track"]), text: (decodeString)(record["text"]), canvas: (decodeString)(record["canvas"]) } })
    expect(inks.thumb).toBe(inks.text)
    expect(inks.track).toBe(inks.canvas)
    expect(inks.canvas).not.toBe("rgba(0, 0, 0, 0)")
  } finally { await page.close() }
}, 30_000)

test("composer autocomplete, pickers and selection sheets inherit owned fine-pointer scrollbar parts", async () => {
  const page = await browser!.openPage()
  const owned = async (selector: string) => {
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`); attempt++) await Bun.sleep(25)
    const result = await page.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});return{width:getComputedStyle(element,'::-webkit-scrollbar').width,thumb:getComputedStyle(element,'::-webkit-scrollbar-thumb').backgroundColor.match(/\\d+/g).slice(0,3).join(','),track:getComputedStyle(element,'::-webkit-scrollbar-track').backgroundColor}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeString)(record["width"]), thumb: (decodeString)(record["thumb"]), track: (decodeString)(record["track"]) } })
    expect(result.width).toBe(`${await scrollbarSize(page)}px`)
    expect(result.thumb).toBe(await tokenColor(page, "--yc-border-strong"))
    expect(result.track).toBe("rgba(0, 0, 0, 0)")
  }
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.mini-composer__mount textarea')`); attempt++) await Bun.sleep(25)
    await page.evaluate(`(()=>{const input=document.querySelector('.mini-composer__mount textarea');input.focus();input.value='/pla';input.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`)
    await owned(".mini-composer__autocomplete")
    await page.pressEscape()
    await page.evaluate(`document.querySelector('.mini-composer__mount .mini-picker__trigger').click()`)
    await owned(".mini-picker__list")
    await page.pressEscape()
    await page.setViewport(390, 844)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.mini-composer__mount .composer__mobile-trigger')`); attempt++) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('.mini-composer__mount .composer__mobile-trigger').click()`)
    await owned(".composer__selection-options")
    await page.evaluate(`document.querySelector('.composer__selection-options .mini-picker__trigger').click()`)
    await owned(".mini-picker__surface--sheet .mini-picker__list")
  } finally { await page.close() }
}, 30_000)

async function remote(query: string, expected: string, width: number, height: number, theme: "light" | "dark") {
  const page = await browser!.openPage()
  await page.setViewport(width, height)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 80 && !await page.evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`); attempt += 1) await Bun.sleep(100)
  await page.evaluate(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)}
    document.querySelector('.fixture__banner')?.remove()
    document.querySelector('.fixture__controls')?.remove()
    const fixture = document.querySelector('.fixture')
    fixture.style.height = '100dvh'
    fixture.style.minHeight = '0'
    fixture.style.overflow = 'hidden'
  })()`)
  await frames(page)
  return page
}

function frames(page: Page) {
  return page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
}

async function scrollbarSize(page: Page) {
  return Number.parseFloat(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--yc-scrollbar-size')`, decodeString))
}

function scrollerBox(page: Page, selector: string) {
  return page.evaluate(`(() => {
    const scroller = document.querySelector(${JSON.stringify(selector)})
    scroller.scrollTop = 0
    const rect = scroller.getBoundingClientRect()
    const style = getComputedStyle(scroller)
    const left = parseFloat(style.borderLeftWidth)
    const right = parseFloat(style.borderRightWidth)
    return {
      top: rect.top,
      right: rect.right - right,
      bottom: rect.bottom - parseFloat(style.borderBottomWidth),
      thickness: scroller.offsetWidth - scroller.clientWidth - left - right,
      client: scroller.clientWidth,
      scrollable: scroller.scrollHeight > scroller.clientHeight,
      gutter: style.scrollbarGutter,
    }
  })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), right: (decodeNumber)(record["right"]), bottom: (decodeNumber)(record["bottom"]), thickness: (decodeNumber)(record["thickness"]), client: (decodeNumber)(record["client"]), scrollable: (decodeBoolean)(record["scrollable"]), gutter: (decodeString)(record["gutter"]) } })
}

function tokenColor(page: Page, token: string) {
  return page.evaluate(`(() => {
    const probe = document.createElement('i')
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(token)})
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color.match(/\\d+/g).slice(0, 3).join(',')
  })()`, decodeString)
}

function pixels(page: Page, screenshot: string, points: readonly (readonly [number, number])[]) {
  return page.evaluate(`new Promise(resolve => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      resolve(${JSON.stringify(points.map(([x, y]) => [Math.round(x), Math.round(y)]))}.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3).join(',')))
    }
    image.src = 'data:image/png;base64,${screenshot}'
  })`, decodeArray(decodeString))
}
