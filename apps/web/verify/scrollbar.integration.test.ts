import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

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

test("the public page and horizontal scroll regions use the same owned scrollbar", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(`http://127.0.0.1:${port}/docs/quickstart`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.docs-article') !== null`); attempt += 1) await Bun.sleep(100)
    await frames(page)
    const size = await scrollbarSize(page)
    const viewport = await page.evaluate<{ width: number; client: number; scrollable: boolean }>(`({ width: innerWidth, client: document.documentElement.clientWidth, scrollable: document.documentElement.scrollHeight > innerHeight })`)
    expect(viewport.scrollable).toBe(true)
    expect(viewport.width - viewport.client).toBe(size)
    const [documentThumb] = await pixels(page, await page.screenshot(), [[viewport.width - size / 2, 16]])
    expect(documentThumb).toBe(await tokenColor(page, "--yc-border-strong"))
    const probe = await page.evaluate<{ left: number; bottom: number; thickness: number }>(`(() => {
      const probe = document.createElement('div')
      probe.style.cssText = 'position:fixed;left:40px;top:160px;width:240px;height:80px;overflow:auto;background:var(--yc-bg);z-index:2147483647'
      probe.innerHTML = '<div style="width:960px;height:24px"></div>'
      document.body.append(probe)
      const rect = probe.getBoundingClientRect()
      return { left: rect.left, bottom: rect.bottom, thickness: probe.offsetHeight - probe.clientHeight }
    })()`)
    expect(probe.thickness).toBe(size)
    await frames(page)
    const [horizontalThumb] = await pixels(page, await page.screenshot(), [[probe.left + 16, probe.bottom - size / 2]])
    expect(horizontalThumb).toBe(await tokenColor(page, "--yc-border-strong"))
  } finally { await page.close() }
}, 30_000)

test("primary scroll regions keep their content width when overflow appears", async () => {
  for (const [width, height] of [[1440, 900], [1024, 768]] as const) {
    const page = await remote("view=settings&noSelection=1", "System alerts", width, height, "light")
    try {
      const overflowing = await scrollerBox(page, ".app--settings .workspace__scroll")
      expect(overflowing.scrollable).toBe(true)
      await page.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>.app--settings .settings > :not(:first-child), .app--settings .page-head { display: none; }</style>')`)
      await frames(page)
      const fitting = await scrollerBox(page, ".app--settings .workspace__scroll")
      expect(fitting.scrollable).toBe(false)
      expect(fitting.client).toBe(overflowing.client)
    } finally { await page.close() }
  }
}, 30_000)

test("the conversation column and composer keep shared edges beside a visible scrollbar", async () => {
  for (const [width, height] of [[1440, 900], [1024, 768]] as const) {
    const page = await remote("view=chat", "Stream remote output safely", width, height, "light")
    try {
      const size = await scrollbarSize(page)
      expect((await scrollerBox(page, ".app--conversation .workspace__scroll")).thickness).toBe(size)
      const edges = await page.evaluate<{ column: readonly [number, number]; composer: readonly [number, number]; band: number; window: number }>(`(() => {
        const column = document.querySelector('.conversation-breadcrumb').getBoundingClientRect()
        const composer = document.querySelector('.composer .composer__row').getBoundingClientRect()
        return { column: [column.left, column.right], composer: [composer.left, composer.right], band: document.querySelector('.workspace__topbar').getBoundingClientRect().right, window: innerWidth }
      })()`)
      expect(Math.abs(edges.column[0] - edges.composer[0])).toBeLessThanOrEqual(1)
      expect(Math.abs(edges.column[1] - edges.composer[1])).toBeLessThanOrEqual(1)
      expect(edges.band).toBe(edges.window)
    } finally { await page.close() }
  }
}, 30_000)

test("touch pointers and forced colors keep the platform scrollbar", async () => {
  const page = await remote("view=settings&noSelection=1", "System alerts", 1440, 900, "light")
  try {
    const size = await scrollbarSize(page)
    await page.setCoarsePointer(true)
    await frames(page)
    const coarse = await scrollerBox(page, ".app--settings .workspace__scroll")
    expect(coarse.thickness).not.toBe(size)
    expect(coarse.gutter).toBe("auto")
    await page.setCoarsePointer(false)
    await page.setForcedColors(true)
    await frames(page)
    const forced = await scrollerBox(page, ".app--settings .workspace__scroll")
    expect(forced.thickness).not.toBe(size)
    expect(forced.gutter).toBe("auto")
  } finally { await page.close() }
}, 30_000)

async function remote(query: string, expected: string, width: number, height: number, theme: "light" | "dark") {
  const page = await browser!.openPage()
  await page.setViewport(width, height)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(expected)})`); attempt += 1) await Bun.sleep(100)
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
  return Number.parseFloat(await page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--yc-scrollbar-size')`))
}

function scrollerBox(page: Page, selector: string) {
  return page.evaluate<{ top: number; right: number; bottom: number; thickness: number; client: number; scrollable: boolean; gutter: string }>(`(() => {
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
  })()`)
}

function tokenColor(page: Page, token: string) {
  return page.evaluate<string>(`(() => {
    const probe = document.createElement('i')
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(token)})
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color.match(/\\d+/g).slice(0, 3).join(',')
  })()`)
}

function pixels(page: Page, screenshot: string, points: readonly (readonly [number, number])[]) {
  return page.evaluate<string[]>(`new Promise(resolve => {
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
  })`)
}
