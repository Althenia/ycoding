import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { RELEASES } from "../src/content/changelog"
import { SITEMAP_PATHS } from "../src/seo/sitemap"
import { launchBrowser, decodeArray, decodeBoolean, decodeNumber, decodeOptional, decodeRecord, decodeString } from "./cdp"

const port = 4179
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable before running this integration test.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the public component server")
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("public routes and design-system behavior", () => {
  test("keeps global public navigation open in current, hover and keyboard-focus states", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.setReducedMotion(true)
      for (const path of ["/", "/docs", "/changelog"]) {
        await page.navigate(url(path))
        await waitFor(page, ".nav__link--active")
        const links = await page.evaluate(`(()=>{const links=[...document.querySelectorAll('.app-header .nav__link')];return{routes:links.map(e=>e.getAttribute('href')),current:links.filter(e=>e.getAttribute('aria-current')==='page').map(e=>e.getAttribute('href')),open:links.every(e=>{const s=getComputedStyle(e);return s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.borderRadius==='0px'}),targets:links.every(e=>{const b=e.getBoundingClientRect();return b.width>=44&&b.height>=44})}})()`)
        expect(links).toEqual({ routes: ["/", "/docs", "/changelog"], current: [path], open: true, targets: true })
        const box = await page.evaluate(`(()=>{const b=document.querySelector('.nav__link--active').getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, x: (decodeNumber)(record["x"]), y: (decodeNumber)(record["y"]) } })
        await page.mouse("mouseMoved", box.x, box.y)
        expect(await page.evaluate(`getComputedStyle(document.querySelector('.nav__link--active')).backgroundColor`)).toBe("rgba(0, 0, 0, 0)")
        await page.evaluate(`document.querySelector('.app-header .brand').focus()`)
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate(`document.activeElement===document.querySelector('.nav__link')&&document.activeElement.matches(':focus-visible')&&getComputedStyle(document.activeElement).outlineStyle!=='none'`)).toBe(true)
      }
    } finally { await page.close() }
  })
  for (const path of ["/docs/configuration/autonomous", "/changelog"]) test(`one public header owns search without a second band on ${path}`, async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}${path}`)
      await waitFor(page, ".docs-article")
      expect(await page.evaluate(`document.querySelectorAll('.app-header .docs-search-trigger').length`)).toBe(1)
      expect(await page.evaluate(`document.querySelectorAll('.docs-bar').length`)).toBe(0)
      expect(await page.evaluate(`document.querySelectorAll('.docs-search-trigger').length`)).toBe(1)
    } finally { await page.close() }
  })

  test("not-found recovery uses an open centered composition with a prominent heading", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/not-a-route`)
      await waitFor(page, ".not-found")
      const display = await page.evaluate(`(()=>{const card=document.querySelector('.not-found__card'),box=card.getBoundingClientRect(),css=getComputedStyle(card);return{border:css.borderTopWidth,background:css.backgroundColor,centered:Math.abs(box.left+box.width/2-innerWidth/2)<1,heading:parseFloat(getComputedStyle(card.querySelector('h1')).fontSize),links:[...card.querySelectorAll('a')].map(e=>e.getAttribute('href'))}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, border: (decodeString)(record["border"]), background: (decodeString)(record["background"]), centered: (decodeBoolean)(record["centered"]), heading: (decodeNumber)(record["heading"]), links: (decodeArray(decodeString))(record["links"]) } })
      expect(display.border).toBe("0px")
      expect(display.background).toBe("rgba(0, 0, 0, 0)")
      expect(display.centered).toBe(true)
      expect(display.heading).toBeGreaterThanOrEqual(36)
      expect(display.links).toEqual(["/docs", "/", "/remote"])
    } finally { await page.close() }
  })
  for (const path of ["/", "/docs", "/changelog", "/not-a-route"]) test(`matches the approved public header and content track without shrinking controls on ${path}`, async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.setReducedMotion(true)
        await page.navigate(url(path))
        await page.evaluate(`new Promise((resolve, reject) => {
          const start = performance.now()
          const mounted = () => {
            if (document.querySelector('.marketing .app-header__cta a')) return document.fonts.ready.then(() => resolve(undefined))
            if (performance.now() - start > 4000) return reject(new Error('Public header did not mount'))
            requestAnimationFrame(mounted)
          }
          mounted()
        })`)
        const geometry = await page.evaluate(`(() => {
          const header = document.querySelector('.marketing .app-header').getBoundingClientRect()
          const track = document.querySelector('.app-header__inner').getBoundingClientRect()
          const brand = document.querySelector('.app-header .brand').getBoundingClientRect()
          const action = document.querySelector('.app-header__cta a').getBoundingClientRect()
          return { height: header.height, width: track.width, inset: brand.left, action: action.height, contained: action.top >= header.top && action.bottom <= header.bottom, overflow: document.documentElement.scrollWidth > innerWidth }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), width: (decodeNumber)(record["width"]), inset: (decodeNumber)(record["inset"]), action: (decodeNumber)(record["action"]), contained: (decodeBoolean)(record["contained"]), overflow: (decodeBoolean)(record["overflow"]) } })
        expect(geometry.height, path).toBe(56)
        expect(geometry.width, path).toBe(1440)
        expect(geometry.inset, path).toBe(32)
        expect(geometry.action, path).toBeGreaterThanOrEqual(44)
        expect(geometry.contained, path).toBe(true)
        expect(geometry.overflow, path).toBe(false)
    } finally { await page.close() }
  })

  for (const [path, selector] of [["/", ".hero__headline"], ["/docs/quickstart", ".docs-article > h1"], ["/changelog", ".release"]] as const) {
    test(`animates public entrances over time and leaves content visible without motion on ${path}`, async () => {
      const page = await requireBrowser().openPage()
      await page.setViewport(1440, 900)
      await page.setReducedMotion(false)
      await page.setAnimationPlaybackRate(0)
      await page.navigate(url(path))
      const early = await page.evaluate(`new Promise((resolve, reject) => {
        const selector = ${JSON.stringify(selector)}
        const start = performance.now()
        const wait = () => {
          const element = document.querySelector(selector)
          if (!(element instanceof HTMLElement) || document.documentElement.dataset.motion !== 'on' || Number(getComputedStyle(element).opacity) >= 1) {
            if (performance.now() - start > 15000) return reject(new Error('motion gate, target or entrance missing'))
            return requestAnimationFrame(wait)
          }
          resolve({ opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform + getComputedStyle(element).translate })
        }
        wait()
      })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, opacity: (decodeNumber)(record["opacity"]), transform: (decodeString)(record["transform"]) } })
      await page.setAnimationPlaybackRate(1)
      const animated = await page.evaluate(`new Promise((resolve) => {
        const element = document.querySelector(${JSON.stringify(selector)})
        setTimeout(() => {
          const middle = Number(getComputedStyle(element).opacity)
          const transformChanged = ${JSON.stringify(early.transform)} !== getComputedStyle(element).transform + getComputedStyle(element).translate
          setTimeout(() => resolve({ early: ${early.opacity}, middle, settled: Number(getComputedStyle(element).opacity), transformChanged }), 700)
        }, 100)
      })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, early: (decodeNumber)(record["early"]), middle: (decodeNumber)(record["middle"]), settled: (decodeNumber)(record["settled"]), transformChanged: (decodeBoolean)(record["transformChanged"]) } })
      expect(animated.early).toBeLessThan(1)
      expect(animated.middle).toBeGreaterThan(animated.early)
      expect(animated.settled).toBe(1)
      expect(animated.transformChanged).toBe(true)
      await page.setReducedMotion(true)
      expect(await page.evaluate(`Number(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity)`)).toBe(1)
      await page.evaluate(`document.documentElement.removeAttribute('data-motion')`)
      expect(await page.evaluate(`Number(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity)`)).toBe(1)
      await page.close()
    })
  }

  test("keeps public landing content visible when entrance motion is disabled", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(1440, 900)
    await page.setReducedMotion(true)
    await page.navigate(url("/"))
    expect(await page.evaluate(`({ gate: document.documentElement.dataset.motion, opacity: Number(getComputedStyle(document.querySelector('.hero__headline')).opacity), animations: document.querySelector('.hero__headline').getAnimations().length })`)).toEqual({ opacity: 1, animations: 0 })
    await page.setViewport(390, 844)
    await page.setReducedMotion(false)
    await page.navigate(url("/"))
    expect(await page.evaluate(`Number(getComputedStyle(document.querySelector('.feature:last-child')).opacity)`)).toBe(0)
    await page.evaluate(`document.documentElement.removeAttribute('data-motion')`)
    expect(await page.evaluate(`Number(getComputedStyle(document.querySelector('.feature:last-child')).opacity)`)).toBe(1)
    await page.evaluate(`document.documentElement.dataset.motion = 'on'`)
    await page.setReducedMotion(true)
    expect(await page.evaluate(`Number(getComputedStyle(document.querySelector('.feature:last-child')).opacity)`)).toBe(1)
    await page.close()
  })

  test("reveals scrolled cards and sections without changing document geometry", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    for (const [path, selector] of [["/", ".feature"], ["/docs/quickstart", ".docs-article .doc-section"], ["/changelog", ".release"]] as const) {
      await page.navigate(url(path))
      for (let attempt = 0; attempt < 50 && !(await page.evaluate(`document.querySelector(${JSON.stringify(selector)}) instanceof HTMLElement`)); attempt += 1) await Bun.sleep(100)
      const motion = await page.evaluate(`new Promise((resolve, reject) => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].at(-1)
        if (!(element instanceof HTMLElement)) return reject(new Error('reveal target missing: ' + ${JSON.stringify(path)}))
        const before = Number(getComputedStyle(element).opacity)
        const heightBefore = document.querySelector('#main').offsetHeight
        element.scrollIntoView({ block: 'center' })
        const start = performance.now()
        const wait = () => {
          if (!element.classList.contains('motion-reveal--visible')) {
            if (performance.now() - start > 3000) return reject(new Error('reveal not observed'))
            return requestAnimationFrame(wait)
          }
          const early = Number(getComputedStyle(element).opacity)
          setTimeout(() => resolve({ before, early, middle: Number(getComputedStyle(element).opacity), heightBefore, heightAfter: document.querySelector('#main').offsetHeight }), 300)
        }
        wait()
      })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, before: (decodeNumber)(record["before"]), early: (decodeNumber)(record["early"]), middle: (decodeNumber)(record["middle"]), heightBefore: (decodeNumber)(record["heightBefore"]), heightAfter: (decodeNumber)(record["heightAfter"]) } })
      expect(motion.before).toBe(0)
      expect(motion.middle).toBeGreaterThan(motion.early)
      expect(motion.heightAfter).toBe(motion.heightBefore)
    }
    await page.close()
  })

  test("cross-fades public route content and slides the documentation contents marker", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(1440, 900)
    await page.navigate(url("/"))
    await page.setAnimationPlaybackRate(0)
    await page.evaluate(`document.querySelector('nav[aria-label="Primary"] a[href="/docs"]')?.click()`)
    const early = await page.evaluate(`new Promise((resolve, reject) => {
      const start = performance.now()
      const wait = () => {
        const main = document.querySelector('.marketing > main')
        if (!(main instanceof HTMLElement) || !main.querySelector('.docs-article') || !main.getAnimations().some((animation) => animation.animationName === 'yc-page-in')) {
          if (performance.now() - start > 3000) return reject(new Error('docs route entry missing'))
          return requestAnimationFrame(wait)
        }
        resolve(Number(getComputedStyle(main).opacity))
      }
      wait()
    })`, decodeNumber)
    expect(early).toBeLessThan(1)
    await page.setAnimationPlaybackRate(1)
    const later = await page.evaluate(`new Promise((resolve) => setTimeout(() => resolve(Number(getComputedStyle(document.querySelector('.marketing > main')).opacity)), 120))`)
    expect(later).toBeGreaterThan(early)
    await page.navigate(url("/docs/quickstart"))
    const marker = await page.evaluate(`new Promise((resolve, reject) => {
      const list = document.querySelector('.docs-toc__list')
      const headings = [...document.querySelectorAll('.doc-section > h2[id]')]
      if (!(list instanceof HTMLElement) || headings.length < 2) return reject(new Error('contents rail missing'))
      const first = getComputedStyle(list, '::before').transform
      window.scrollTo(0, scrollY + headings[1].getBoundingClientRect().top - innerHeight * 0.2)
      const start = performance.now()
      const wait = () => {
        if (document.querySelector('.docs-toc__list a[aria-current="location"]')?.hash !== '#' + headings[1].id) {
          if (performance.now() - start > 3000) return reject(new Error('contents selection missing'))
          return requestAnimationFrame(wait)
        }
        setTimeout(() => {
          const moving = getComputedStyle(list, '::before').transform
          setTimeout(() => resolve({ first, moving, settled: getComputedStyle(list, '::before').transform }), 400)
        }, 60)
      }
      wait()
    })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, first: (decodeString)(record["first"]), moving: (decodeString)(record["moving"]), settled: (decodeString)(record["settled"]) } })
    expect(marker.moving).not.toBe(marker.first)
    expect(marker.settled).not.toBe(marker.moving)
    await page.close()
  })

  test("tracks the visible documentation section in the contents rail", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(1440, 900)
    await page.navigate(url("/docs/quickstart"))
    const active = await page.evaluate(`(() => {
      const heading = document.querySelector('.doc-section > h2[id]')
      if (!(heading instanceof HTMLElement)) throw new Error('documentation section missing')
      heading.scrollIntoView()
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(heading.id))))
    })()`, decodeString)
    expect(await page.evaluate(`document.querySelector('.docs-toc__list a[aria-current="location"]')?.hash ?? ""`)).toBe(`#${active}`)
    await page.close()
  })

  test("keeps short-page footers at the viewport edge without fixing long-page footers", async () => {
    const page = await requireBrowser().openPage()
    const measure = () =>
      page.evaluate(`(() => {
        const footer = document.querySelector(".site-footer")
        const main = document.querySelector("#main")
        if (!(footer instanceof HTMLElement) || !(main instanceof HTMLElement)) throw new Error("public shell missing")
        const footerBox = footer.getBoundingClientRect()
        const mainBox = main.getBoundingClientRect()
        const root = document.documentElement
        return {
          viewport: { width: innerWidth, height: innerHeight },
          footer: { top: footerBox.top, bottom: footerBox.bottom, position: getComputedStyle(footer).position },
          main: { top: mainBox.top, bottom: mainBox.bottom },
          document: { height: root.getBoundingClientRect().height, scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth },
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, viewport: ((value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), height: (decodeNumber)(record["height"]) } })(record["viewport"]), footer: ((value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]), position: (decodeString)(record["position"]) } })(record["footer"]), main: ((value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]) } })(record["main"]), document: ((value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), scrollHeight: (decodeNumber)(record["scrollHeight"]), scrollWidth: (decodeNumber)(record["scrollWidth"]) } })(record["document"]) } })
    await page.setViewport(2048, 1113)
    await page.navigate(url("/"))
    const short = await measure()
    expect(Math.abs(short.footer.bottom - short.viewport.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(short.footer.bottom - short.document.height)).toBeLessThanOrEqual(1)
    expect(short.document.scrollHeight).toBe(short.viewport.height)
    for (const path of ["/docs", "/changelog", "/not-a-route"]) {
      await page.navigate(url(path))
      const tall = await measure()
      expect(tall.document.scrollWidth).toBeLessThanOrEqual(tall.viewport.width)
      if (tall.document.scrollHeight <= tall.viewport.height) {
        expect(Math.abs(tall.footer.bottom - tall.document.height)).toBeLessThanOrEqual(1)
      }
    }
    await page.navigate(url("/docs/quickstart"))
    const long = await measure()
    expect(long.document.scrollHeight).toBeGreaterThan(long.viewport.height)
    expect(long.footer.position).not.toBe("fixed")
    expect(long.footer.position).not.toBe("sticky")
    expect(long.footer.top).toBeGreaterThanOrEqual(long.main.bottom - 1)
    await page.setViewport(390, 844)
    for (const path of ["/", "/docs/quickstart", "/changelog"]) {
      await page.navigate(url(path))
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    await page.close()
  })

  test("assigns compact public shapes and open topic and release rows without narrow overflow", async () => {
    const page = await requireBrowser().openPage()
    const radii = async (path: string, selectors: readonly string[]) => {
      await page.navigate(url(path))
      return page.evaluate(`[...${JSON.stringify(selectors)}].map(selector => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error("missing public surface: " + selector)
        return getComputedStyle(element).borderRadius
      })`, decodeArray(decodeString))
    }
    expect(await radii("/", [".button--primary", ".feature", ".code-block"])).toEqual(["6px", "14px", "6px"])
    expect(await radii("/docs", [".docs-search-trigger", ".doc-section", ".card"])).toEqual(["999px", "0px", "6px"])
    expect(await radii("/docs/quickstart", [".docs-bar__nav-toggle"])).toEqual(["999px"])
    expect(await radii("/docs/quickstart", [".code-block", ".callout"])).toEqual(["10px", "10px"])
    expect(await radii("/changelog", [".release", ".filters__option"])).toEqual(["0px", "10px"])
    await page.setViewport(390, 844)
    for (const path of ["/", "/docs", "/docs/quickstart", "/changelog"]) {
      await page.navigate(url(path))
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    await page.close()
  })

  test("keeps every published public route nonblank, in-flow, and within its viewport", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]] as const) {
      await page.setViewport(width, height)
      for (const theme of ["light", "dark"] as const) {
        for (const path of SITEMAP_PATHS) {
          await page.navigate(url(path))
          await page.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true })()`)
          const layout = await page.evaluate(`(() => {
            const main = document.querySelector("#main")
            const footer = document.querySelector(".site-footer")
            if (!(main instanceof HTMLElement) || !(footer instanceof HTMLElement)) throw new Error("public shell missing")
            const root = document.documentElement
            return {
              overflow: root.scrollWidth > innerWidth,
              mainHeight: main.getBoundingClientRect().height,
              footerBottom: footer.getBoundingClientRect().bottom,
              rootHeight: root.getBoundingClientRect().height,
              short: root.scrollHeight <= innerHeight,
            }
          })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, overflow: (decodeBoolean)(record["overflow"]), mainHeight: (decodeNumber)(record["mainHeight"]), footerBottom: (decodeNumber)(record["footerBottom"]), rootHeight: (decodeNumber)(record["rootHeight"]), short: (decodeBoolean)(record["short"]) } })
          expect(layout.overflow).toBe(false)
          expect(layout.mainHeight).toBeGreaterThan(0)
          if (layout.short) expect(Math.abs(layout.footerBottom - layout.rootHeight)).toBeLessThanOrEqual(1)
        }
      }
    }
    await page.close()
  }, 180_000)

  test("keeps the install action and product footer destinations available", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/"))
    const before = await page.evaluate(`(() => {
      const copy = document.querySelector(".hero .code-block__copy")
      const head = document.querySelector(".hero .code-block__head")
      return { copyVisible: copy instanceof HTMLElement && getComputedStyle(copy).display !== "none", headVisible: head instanceof HTMLElement && getComputedStyle(head).display !== "none", footerLinks: [...document.querySelectorAll(".footer__columns a")].map(link => link.getAttribute("href")) }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, copyVisible: (decodeBoolean)(record["copyVisible"]), headVisible: (decodeBoolean)(record["headVisible"]), footerLinks: (decodeArray(decodeString))(record["footerLinks"]) } })
    expect(before.copyVisible).toBe(true)
    expect(before.headVisible).toBe(true)
    expect(before.footerLinks).toContain("/remote")
    await page.evaluate(`document.querySelector(".hero .code-block__copy")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    expect(await page.evaluate(`document.querySelector(".hero .code-block__copy")?.getAttribute("aria-label")`)).toBe("Copied")
    await page.close()
  })

  test("keeps the product landing page mobile navigation and capability composition", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/"))
    await settleMotion(page)
    const layout = await page.evaluate(`(() => {
      const nav = document.querySelector('.marketing .nav')
      const header = document.querySelector('.marketing .app-header')
      const headerAction = document.querySelector('.marketing .app-header__cta a')
      const headline = document.querySelector('.marketing .hero__headline')
      const support = document.querySelector('.marketing .hero__support')
      const primaryAction = document.querySelector('.marketing .hero__actions .button')
      const code = document.querySelector('.marketing .hero .code-block')
      const hero = document.querySelector('.marketing .hero')
      const content = document.querySelector('.marketing .hero__content')
      const actionRect = headerAction?.getBoundingClientRect()
      const features = [...document.querySelectorAll('.marketing .feature')]
      if (!(nav instanceof HTMLElement) || !(header instanceof HTMLElement) || !(headline instanceof HTMLElement) || !(support instanceof HTMLElement) || !(primaryAction instanceof HTMLElement) || !(code instanceof HTMLElement) || !(hero instanceof HTMLElement) || !(content instanceof HTMLElement) || features.length !== 4) throw new Error('landing page composition missing')
      const box = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } }
      const heroBox = box(hero)
      const contentBox = box(content)
      const actionBounds = [...document.querySelectorAll('.marketing .hero__actions .button')].map(box)
      return {
        navVisible: getComputedStyle(nav).display !== 'none',
        headerActionWithinHeader: headerAction instanceof HTMLElement && getComputedStyle(headerAction).display !== 'none' && !!actionRect && actionRect.top >= header.getBoundingClientRect().top && actionRect.bottom <= header.getBoundingClientRect().bottom && actionRect.left >= 0 && actionRect.right <= innerWidth && actionRect.height >= 44,
        hero: heroBox,
        content: contentBox,
        headline: box(headline),
        support: box(support),
        actionBounds,
        code: box(code),
        featureTop: features[0].getBoundingClientRect().top,
        supportSize: parseFloat(getComputedStyle(support).fontSize),
        actionsWithinContent: actionBounds.every(action => action.left >= contentBox.left && action.right <= contentBox.right && action.top < action.bottom),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, navVisible: (decodeBoolean)(record["navVisible"]), hero: ((value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]), left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["hero"]), content: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["content"]), headline: ((value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]), left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["headline"]), support: ((value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]), left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["support"]), actionBounds: (decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]), left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } }))(record["actionBounds"]), code: ((value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]), left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["code"]), featureTop: (decodeNumber)(record["featureTop"]), supportSize: (decodeNumber)(record["supportSize"]), actionsWithinContent: (decodeBoolean)(record["actionsWithinContent"]), headerActionWithinHeader: (decodeBoolean)(record["headerActionWithinHeader"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(layout.navVisible).toBe(true)
    expect(layout.headerActionWithinHeader).toBe(true)
    expect(layout.supportSize).toBe(14)
    expect(layout.headline.top).toBeLessThan(layout.support.top)
    expect(layout.support.top).toBeLessThan(layout.actionBounds[0]!.top)
    expect(layout.actionBounds.at(-1)!.bottom).toBeLessThan(layout.code.top)
    expect(layout.code.bottom).toBeLessThanOrEqual(layout.hero.bottom)
    expect(layout.featureTop).toBeGreaterThanOrEqual(layout.hero.bottom)
    expect(layout.headline.left).toBeGreaterThanOrEqual(layout.content.left)
    expect(layout.headline.right).toBeLessThanOrEqual(layout.content.right)
    expect(layout.actionsWithinContent).toBe(true)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps landing page tablet capability cards compact with all four descriptions", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 1024)
    await page.navigate(url("/"))
    const layout = await page.evaluate(`(() => {
      const features = [...document.querySelectorAll('.marketing .feature')]
      const description = features[0]?.querySelector('.feature__text')
      if (features.length !== 4 || !(description instanceof HTMLElement)) throw new Error('Tablet capabilities missing')
      return {
        heights: features.map(feature => feature.getBoundingClientRect().height),
        descriptions: features.map(feature => feature.querySelector('.feature__text')?.textContent.trim() ?? ''),
        descriptionSize: parseFloat(getComputedStyle(description).fontSize),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, heights: (decodeArray(decodeNumber))(record["heights"]), descriptions: (decodeArray(decodeString))(record["descriptions"]), descriptionSize: (decodeNumber)(record["descriptionSize"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(Math.max(...layout.heights)).toBeLessThanOrEqual(145)
    expect(layout.descriptions.every(description => description.length > 0)).toBe(true)
    expect(layout.descriptionSize).toBeGreaterThanOrEqual(14)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps product footer links aligned and touch-reachable on tablet", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 900)
    await page.navigate(url("/"))
    const footer = await page.evaluate(`(() => {
      const footer = document.querySelector('.marketing .site-footer')
      const header = document.querySelector('.marketing .app-header__inner')
      const content = document.querySelector('.marketing .site-footer > .container')
      const columns = document.querySelector('.marketing .footer__columns')
      const groups = [...document.querySelectorAll('.marketing .footer__column')]
      const links = [...document.querySelectorAll('.marketing .footer__columns a')]
      if (!(footer instanceof HTMLElement) || !(header instanceof HTMLElement) || !(content instanceof HTMLElement) || !(columns instanceof HTMLElement) || groups.length !== 3 || links.length === 0) throw new Error('Marketing footer missing')
      const headerBox = header.getBoundingClientRect()
      const contentBox = content.getBoundingClientRect()
      return {
        aligned: Math.abs(contentBox.left - headerBox.left) <= 1 && Math.abs(contentBox.right - headerBox.right) <= 1,
        titles: groups.map(group => group.querySelector('.footer__title')?.textContent?.trim() ?? ''),
        links: links.map(link => link.getAttribute('href') ?? ''),
        linkHeights: links.map(link => link.getBoundingClientRect().height),
        contained: links.every(link => { const rect = link.getBoundingClientRect(); return rect.left >= contentBox.left && rect.right <= contentBox.right && rect.top >= footer.getBoundingClientRect().top && rect.bottom <= footer.getBoundingClientRect().bottom }),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, aligned: (decodeBoolean)(record["aligned"]), titles: (decodeArray(decodeString))(record["titles"]), links: (decodeArray(decodeString))(record["links"]), linkHeights: (decodeArray(decodeNumber))(record["linkHeights"]), contained: (decodeBoolean)(record["contained"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(footer.aligned).toBe(true)
    expect(footer.titles).toEqual(["Product", "Guides", "Project"])
    expect(footer.links.length).toBeGreaterThan(0)
    expect(footer.links).toContain("/remote")
    expect(Math.min(...footer.linkHeights)).toBeGreaterThanOrEqual(44)
    expect(footer.contained).toBe(true)
    expect(footer.overflowing).toBe(false)
    await page.setViewport(390, 844)
    const mobile = await page.evaluate(`(() => ({
      linkHeights: [...document.querySelectorAll('.marketing .footer__columns a')].map(link => link.getBoundingClientRect().height),
      overflowing: document.documentElement.scrollWidth > innerWidth,
    }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, linkHeights: (decodeArray(decodeNumber))(record["linkHeights"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(mobile.linkHeights.length).toBeGreaterThan(0)
    expect(Math.min(...mobile.linkHeights)).toBeGreaterThanOrEqual(44)
    expect(mobile.overflowing).toBe(false)
    await page.close()
  })

  test("keeps documentation index mobile topic groups compact without shrinking links", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    const layout = await page.evaluate(`(() => {
      const group = document.querySelector('.docs--index .docs-topic-index [data-doc-group="get-started"]')
      if (!(group instanceof HTMLElement)) throw new Error('Getting started group missing')
      return {
        firstGroupTop: group.getBoundingClientRect().top,
        firstGroupHeight: group.getBoundingClientRect().height,
        linkHeights: [...group.querySelectorAll('.card__link')].map(link => link.getBoundingClientRect().height),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, firstGroupTop: (decodeNumber)(record["firstGroupTop"]), firstGroupHeight: (decodeNumber)(record["firstGroupHeight"]), linkHeights: (decodeArray(decodeNumber))(record["linkHeights"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(layout.firstGroupTop).toBeLessThanOrEqual(360)
    expect(layout.linkHeights).toHaveLength(3)
    expect(Math.min(...layout.linkHeights)).toBeGreaterThanOrEqual(44)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps documentation index tablet and desktop topic links compact without decorative rows", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [768, 1440]) {
      await page.setViewport(width, 900)
      await page.navigate(url("/docs"))
      const layout = await page.evaluate(`(() => {
        const links = [...document.querySelectorAll('.docs--index .card__link')]
        return {
          links: links.length,
          visibleTitles: links.filter(link => link.querySelector('.card__title')?.getBoundingClientRect().height > 0).length,
          visibleDescriptions: links.filter(link => link.querySelector('.card__text')?.getBoundingClientRect().height > 0).length,
          decorativeIcons: links.filter(link => { const icon = link.querySelector('svg'); return icon instanceof SVGElement && getComputedStyle(icon).display !== 'none' }).length,
          minLinkHeight: Math.min(...links.map(link => link.getBoundingClientRect().height)),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, links: (decodeNumber)(record["links"]), visibleTitles: (decodeNumber)(record["visibleTitles"]), visibleDescriptions: (decodeNumber)(record["visibleDescriptions"]), decorativeIcons: (decodeNumber)(record["decorativeIcons"]), minLinkHeight: (decodeNumber)(record["minLinkHeight"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(layout.links).toBe(22)
      expect(layout.visibleTitles).toBe(layout.links)
      expect(layout.visibleDescriptions).toBe(layout.links)
      expect(layout.decorativeIcons).toBe(0)
      expect(layout.minLinkHeight).toBeGreaterThanOrEqual(44)
      expect(layout.overflowing).toBe(false)
    }
    await page.close()
  })

  test("uses available documentation index width without an empty desktop contents column", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [1440, 1920] as const) {
      await page.setViewport(width, 900)
      await page.navigate(url("/docs"))
      const layout = await page.evaluate(`(() => {
        const header = document.querySelector('.app-header__inner')
        const rail = document.querySelector('.docs--index .docs-shell__nav')
        const content = document.querySelector('.docs--index .docs-article')
        const shell = document.querySelector('.docs--index .docs-shell')
        const links = [...document.querySelectorAll('.docs--index .doc-section .card__link')]
        if (!(header instanceof HTMLElement) || !(rail instanceof HTMLElement) || !(content instanceof HTMLElement) || !(shell instanceof HTMLElement) || links.length === 0) throw new Error('Documentation layout is incomplete')
        const headerBox = header.getBoundingClientRect()
        const railBox = rail.getBoundingClientRect()
        const contentBox = content.getBoundingClientRect()
        return {
          header: { left: headerBox.left, right: headerBox.right },
          rail: { left: railBox.left, right: railBox.right },
          content: { left: contentBox.left, right: contentBox.right },
          columns: getComputedStyle(shell).gridTemplateColumns.split(' ').length,
          links: links.length,
          minLinkHeight: Math.min(...links.map(link => link.getBoundingClientRect().height)),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, header: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["header"]), rail: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["rail"]), content: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["content"]), columns: (decodeNumber)(record["columns"]), links: (decodeNumber)(record["links"]), minLinkHeight: (decodeNumber)(record["minLinkHeight"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(layout.rail.right - layout.rail.left).toBe(0)
      expect(layout.content.left).toBeGreaterThanOrEqual(layout.header.left - 1)
      expect(layout.content.right).toBeGreaterThanOrEqual(layout.header.left - 1)
      expect(layout.content.right).toBeLessThanOrEqual(layout.header.right + 1)
      expect(layout.columns).toBe(1)
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.docs-topic-index')).gridTemplateColumns.split(' ').length`)).toBe(3)
      expect(layout.links).toBe(22)
      expect(layout.minLinkHeight).toBeGreaterThanOrEqual(44)
      expect(layout.overflowing).toBe(false)
    }
    await page.close()
  })

  test("keeps quickstart guide mobile article rhythm compact while retaining published guidance", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs/quickstart"))
    const layout = await page.evaluate(`(() => {
      const section = document.querySelector('.docs--article .doc-section')
      const heading = section?.querySelector('h2')
      if (!(section instanceof HTMLElement) || !(heading instanceof HTMLElement)) throw new Error('Quickstart section missing')
      return {
        sectionPadding: parseFloat(getComputedStyle(section).paddingTop),
        sectionHeadingSize: parseFloat(getComputedStyle(heading).fontSize),
        guidanceVisible: document.querySelector('.docs-article')?.textContent?.includes('Run one direct prompt') === true,
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, sectionPadding: (decodeNumber)(record["sectionPadding"]), sectionHeadingSize: (decodeNumber)(record["sectionHeadingSize"]), guidanceVisible: (decodeBoolean)(record["guidanceVisible"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(layout.sectionPadding).toBeLessThanOrEqual(16)
    expect(layout.sectionHeadingSize).toBeLessThanOrEqual(18)
    expect(layout.guidanceVisible).toBe(true)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps quickstart guide article details readable with compact mobile blocks", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs/quickstart"))
    const layout = await page.evaluate(`(() => {
      const lede = document.querySelector('.docs--article .docs-article__lede')
      const tableCell = document.querySelector('.docs--article .doc-table td')
      if (!(lede instanceof HTMLElement) || !(tableCell instanceof HTMLElement)) throw new Error('Quickstart details missing')
      return {
        ledeSize: parseFloat(getComputedStyle(lede).fontSize),
        sectionPadding: [...document.querySelectorAll('.docs--article .doc-section')].map(section => parseFloat(getComputedStyle(section).paddingTop)),
        codePadding: [...document.querySelectorAll('.docs--article .code-block pre')].map(code => parseFloat(getComputedStyle(code).paddingTop)),
        copyHeights: [...document.querySelectorAll('.docs--article .code-block__copy')].map(copy => copy.getBoundingClientRect().height),
        tableCellPadding: parseFloat(getComputedStyle(tableCell).paddingTop),
        sections: document.querySelectorAll('.docs--article .doc-section').length,
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, ledeSize: (decodeNumber)(record["ledeSize"]), sectionPadding: (decodeArray(decodeNumber))(record["sectionPadding"]), codePadding: (decodeArray(decodeNumber))(record["codePadding"]), copyHeights: (decodeArray(decodeNumber))(record["copyHeights"]), tableCellPadding: (decodeNumber)(record["tableCellPadding"]), sections: (decodeNumber)(record["sections"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(layout.ledeSize).toBe(14)
    expect(layout.sections).toBe(4)
    expect(layout.sectionPadding.every(padding => padding <= 12)).toBe(true)
    expect(layout.codePadding).toHaveLength(1)
    expect(layout.codePadding.every(padding => padding <= 8)).toBe(true)
    expect(layout.copyHeights).toHaveLength(1)
    expect(layout.copyHeights.every(height => height >= 44)).toBe(true)
    expect(layout.tableCellPadding).toBeLessThanOrEqual(8)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("shows changelog mobile change-type filters without losing the year filter", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/changelog"))
    const before = await page.evaluate(`(() => {
      const filters = [...document.querySelectorAll('.release__inline-filters button')]
      const yearTrigger = document.querySelector('.docs--changelog .docs-bar__nav-toggle')
      return {
        labels: filters.map(button => button.textContent.trim()),
        heights: filters.map(button => button.getBoundingClientRect().height),
        yearTrigger: yearTrigger instanceof HTMLElement && getComputedStyle(yearTrigger).display !== 'none',
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, labels: (decodeArray(decodeString))(record["labels"]), heights: (decodeArray(decodeNumber))(record["heights"]), yearTrigger: (decodeBoolean)(record["yearTrigger"]) } })
    expect(before.labels).toEqual(["All", "Added", "Changed", "Fixed"])
    expect(Math.min(...before.heights)).toBeGreaterThanOrEqual(44)
    expect(before.yearTrigger).toBe(true)
    await page.evaluate(`(() => { const added = [...document.querySelectorAll('.release__inline-filters button')].find(button => button.textContent.trim() === 'Added'); if (!(added instanceof HTMLButtonElement)) return false; added.click(); return true })()`)
    const filtered = await page.evaluate(`(() => ({
      pressed: document.querySelector('.release__inline-filters button:nth-of-type(2)')?.getAttribute('aria-pressed') === 'true',
      groups: [...document.querySelectorAll('.release__change h4')].map(group => group.textContent.trim()),
    }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, pressed: (decodeBoolean)(record["pressed"]), groups: (decodeArray(decodeString))(record["groups"]) } })
    expect(filtered.pressed).toBe(true)
    expect(filtered.groups.length).toBeGreaterThan(0)
    expect(filtered.groups.every(group => group === "Added")).toBe(true)
    await page.close()
  })

  test("keeps the changelog mobile release stream compact without dropping notes", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/changelog"))
    const layout = await page.evaluate(`(() => {
      const lede = document.querySelector('.docs--changelog .docs-article__lede')
      const card = document.querySelector('.releases--timeline .release')
      const groups = card?.querySelector('.release__changes')
      if (!(lede instanceof HTMLElement) || !(card instanceof HTMLElement) || !(groups instanceof HTMLElement)) throw new Error('Changelog composition missing')
      return {
        ledeSize: parseFloat(getComputedStyle(lede).fontSize),
        cardPadding: parseFloat(getComputedStyle(card).paddingTop),
        groupGap: parseFloat(getComputedStyle(groups).rowGap),
        notes: document.querySelectorAll('.release__change li').length,
        releases: document.querySelectorAll('.releases--timeline .release').length,
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, ledeSize: (decodeNumber)(record["ledeSize"]), cardPadding: (decodeNumber)(record["cardPadding"]), groupGap: (decodeNumber)(record["groupGap"]), notes: (decodeNumber)(record["notes"]), releases: (decodeNumber)(record["releases"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(layout.ledeSize).toBeLessThanOrEqual(14)
    expect(layout.cardPadding).toBeLessThanOrEqual(12)
    expect(layout.groupGap).toBeLessThanOrEqual(8)
    expect(layout.notes).toBeGreaterThan(0)
    expect(layout.releases).toBeGreaterThan(0)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("uses the changelog compact tablet release rhythm with every note retained", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 1024)
    await page.navigate(url("/changelog"))
    await settleMotion(page)
    const layout = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.releases--timeline .release')]
      const lede = document.querySelector('.docs--changelog .docs-article__lede')
      const filter = document.querySelector('.release__inline-filters button')
      const groups = cards[0]?.querySelector('.release__changes')
      if (!(cards[0] instanceof HTMLElement) || !(lede instanceof HTMLElement) || !(filter instanceof HTMLElement) || !(groups instanceof HTMLElement)) throw new Error('Tablet changelog missing')
      return {
        ledeSize: parseFloat(getComputedStyle(lede).fontSize),
        cardPadding: parseFloat(getComputedStyle(cards[0]).paddingTop),
        groupGap: parseFloat(getComputedStyle(groups).rowGap),
        noteCount: document.querySelectorAll('.release__change li').length,
        groupCount: document.querySelectorAll('.release__change').length,
        filterHeight: filter.getBoundingClientRect().height,
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, ledeSize: (decodeNumber)(record["ledeSize"]), cardPadding: (decodeNumber)(record["cardPadding"]), groupGap: (decodeNumber)(record["groupGap"]), noteCount: (decodeNumber)(record["noteCount"]), groupCount: (decodeNumber)(record["groupCount"]), filterHeight: (decodeNumber)(record["filterHeight"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(layout.ledeSize).toBeLessThanOrEqual(14)
    expect(layout.cardPadding).toBeLessThanOrEqual(12)
    expect(layout.groupGap).toBeLessThanOrEqual(8)
    expect(layout.noteCount).toBeGreaterThan(0)
    expect(layout.groupCount).toBeGreaterThan(0)
    expect(layout.filterHeight).toBeGreaterThanOrEqual(44)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("uses the available changelog phone and tablet width without dropping release controls", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, left, minWidth] of [[390, 16, 354], [768, 24, 716]] as const) {
      await page.setViewport(width, 1024)
      await page.navigate(url("/changelog"))
      await settleMotion(page)
      const layout = await page.evaluate(`(() => {
        const card = document.querySelector('.docs--changelog .releases--timeline .release')
        const filters = [...document.querySelectorAll('.docs--changelog .release__inline-filters button')]
        if (!(card instanceof HTMLElement) || filters.length === 0) throw new Error('changelog release controls missing')
        const rect = card.getBoundingClientRect()
        return {
          left: rect.left,
          width: rect.width,
          filterCount: filters.length,
          minFilterHeight: Math.min(...filters.map(filter => filter.getBoundingClientRect().height)),
          releases: document.querySelectorAll('.docs--changelog .releases--timeline .release').length,
          notes: document.querySelectorAll('.docs--changelog .release__change li').length,
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), width: (decodeNumber)(record["width"]), filterCount: (decodeNumber)(record["filterCount"]), minFilterHeight: (decodeNumber)(record["minFilterHeight"]), releases: (decodeNumber)(record["releases"]), notes: (decodeNumber)(record["notes"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(layout.left).toBeGreaterThanOrEqual(left - 2)
      expect(layout.left).toBeLessThanOrEqual(left + 2)
      expect(layout.width).toBeGreaterThanOrEqual(minWidth)
      expect(layout.filterCount).toBe(4)
      expect(layout.minFilterHeight).toBeGreaterThanOrEqual(44)
      expect(layout.releases).toBeGreaterThan(0)
      expect(layout.notes).toBeGreaterThan(0)
      expect(layout.overflowing).toBe(false)
    }
    await page.close()
  })

  test("uses the changelog desktop release width without reserving an empty contents rail", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [1280, 1440, 2048] as const) {
      await page.setViewport(width, 900)
      await page.navigate(url("/changelog"))
      await settleMotion(page)
      const layout = await page.evaluate(`(() => {
        const shell = document.querySelector('.docs--changelog .docs-shell')
        const card = document.querySelector('.docs--changelog .releases--timeline .release')
        const filters = document.querySelector('.docs--changelog .release__inline-filters')
        if (!(shell instanceof HTMLElement) || !(card instanceof HTMLElement)) throw new Error('changelog desktop release layout missing')
        const rect = card.getBoundingClientRect()
        return {
          cardLeft: rect.left,
          cardWidth: rect.width,
          contentWidth: document.querySelector('.docs--changelog .docs-article').getBoundingClientRect().width,
          columns: getComputedStyle(shell).gridTemplateColumns.split(' ').length,
          contentsRail: shell.querySelector('.docs-shell__toc') !== null,
          filtersVisible: filters instanceof HTMLElement && filters.getBoundingClientRect().height > 0,
          notes: document.querySelectorAll('.docs--changelog .release__change li').length,
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, cardLeft: (decodeNumber)(record["cardLeft"]), cardWidth: (decodeNumber)(record["cardWidth"]), contentWidth: (decodeNumber)(record["contentWidth"]), columns: (decodeNumber)(record["columns"]), contentsRail: (decodeBoolean)(record["contentsRail"]), filtersVisible: (decodeBoolean)(record["filtersVisible"]), notes: (decodeNumber)(record["notes"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(layout.cardWidth).toBeGreaterThanOrEqual(760)
      expect(Math.abs(layout.cardWidth - layout.contentWidth)).toBeLessThanOrEqual(1)
      expect(layout.columns).toBe(1)
      expect(layout.contentsRail).toBe(false)
      expect(layout.filtersVisible).toBe(true)
      expect(layout.notes).toBeGreaterThan(0)
      expect(layout.overflowing).toBe(false)
      expect(layout.cardLeft).toBeGreaterThan(0)
    }
    await page.close()
  })

  test("fills the mobile offline frame while retaining navigation and retry", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [320, 390]) {
      await page.setViewport(width, 844)
      await page.navigate(url("/offline.html"))
      const layout = await page.evaluate(`(() => {
        const card = document.querySelector('.offline-card')
        const action = card?.querySelector('.retry')
        if (!(card instanceof HTMLElement) || !(action instanceof HTMLAnchorElement)) throw new Error('Offline panel missing')
        return {
          cardWidth: card.getBoundingClientRect().width,
          links: [...document.querySelectorAll('a')].map(link => link.getAttribute('href') ?? ''),
          actionHeight: action.getBoundingClientRect().height,
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, cardWidth: (decodeNumber)(record["cardWidth"]), links: (decodeArray(decodeString))(record["links"]), actionHeight: (decodeNumber)(record["actionHeight"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(layout.cardWidth).toBeGreaterThanOrEqual(width - 4)
      expect(layout.links).toEqual(["/", "/", "/docs", "/changelog", "/remote"])
      expect(layout.actionHeight).toBeGreaterThanOrEqual(44)
      expect(layout.overflowing).toBe(false)
    }
    await page.close()
  })

  test("keeps mobile not-found actions centered and touch-reachable", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/not-a-route"))
    const layout = await page.evaluate(`(() => {
      const card = document.querySelector('.not-found__card')
      if (!(card instanceof HTMLElement)) throw new Error('404 card missing')
      const heading = card.querySelector('h1')
      const prose = card.querySelector('.prose')
      if (!(heading instanceof HTMLElement) || !(prose instanceof HTMLElement)) throw new Error('404 content missing')
      const actions = [...card.querySelectorAll('.not-found__actions a')]
      const box = card.getBoundingClientRect()
      return {
        cardWidth: box.width,
        cardLeft: box.left,
        cardRight: box.right,
        textAlign: getComputedStyle(card).textAlign,
        title: heading.textContent?.trim() ?? '',
        prose: prose.textContent?.trim() ?? '',
        links: actions.map(link => link.getAttribute('href') ?? ''),
        actions: actions.map(link => link.getBoundingClientRect().height),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, cardWidth: (decodeNumber)(record["cardWidth"]), cardLeft: (decodeNumber)(record["cardLeft"]), cardRight: (decodeNumber)(record["cardRight"]), textAlign: (decodeString)(record["textAlign"]), title: (decodeString)(record["title"]), prose: (decodeString)(record["prose"]), links: (decodeArray(decodeString))(record["links"]), actions: (decodeArray(decodeNumber))(record["actions"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
    expect(layout.cardWidth).toBeGreaterThan(0)
    expect(layout.cardLeft).toBeGreaterThanOrEqual(0)
    expect(layout.cardRight).toBeLessThanOrEqual(390)
    expect(layout.textAlign).toBe("center")
    expect(layout.title).toBe("Page not found")
    expect(layout.prose).not.toBe("")
    expect(layout.links).toEqual(["/docs", "/"])
    expect(layout.actions).toHaveLength(2)
    expect(Math.min(...layout.actions)).toBeGreaterThanOrEqual(44)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps tablet and desktop status panels contained with working actions", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [768, 1440] as const) {
      await page.setViewport(width, 900)
      await page.navigate(url("/not-a-route"))
      const notFound = await page.evaluate(`(() => {
        const card = document.querySelector('.not-found__card')
        const container = document.querySelector('.app-header__inner')
        if (!(card instanceof HTMLElement) || !(container instanceof HTMLElement)) throw new Error('Not-found panel or site container missing')
        const cardBox = card.getBoundingClientRect()
        const containerBox = container.getBoundingClientRect()
        return {
          card: { left: cardBox.left, right: cardBox.right },
          container: { left: containerBox.left, right: containerBox.right },
          links: [...card.querySelectorAll('a')].map(link => link.getAttribute('href') ?? ''),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, card: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["card"]), container: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["container"]), links: (decodeArray(decodeString))(record["links"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(notFound.card.left).toBeGreaterThanOrEqual(notFound.container.left - 1)
      expect(notFound.card.right).toBeLessThanOrEqual(notFound.container.right + 1)
      expect(notFound.links).toEqual(["/docs", "/", "/remote"])
      expect(notFound.overflowing).toBe(false)

      await page.navigate(url("/offline.html"))
      const offline = await page.evaluate(`(() => {
        const card = document.querySelector('.offline-card')
        const container = document.querySelector('header')
        if (!(card instanceof HTMLElement) || !(container instanceof HTMLElement)) throw new Error('Offline panel or site container missing')
        const cardBox = card.getBoundingClientRect()
        const containerBox = container.getBoundingClientRect()
        return {
          card: { left: cardBox.left, right: cardBox.right },
          container: { left: containerBox.left, right: containerBox.right },
          links: [...document.querySelectorAll('a')].map(link => link.getAttribute('href') ?? ''),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, card: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["card"]), container: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["container"]), links: (decodeArray(decodeString))(record["links"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(offline.card.left).toBeGreaterThanOrEqual(offline.container.left - 1)
      expect(offline.card.right).toBeLessThanOrEqual(offline.container.right + 1)
      expect(offline.links).toEqual(["/", "/", "/docs", "/changelog", "/remote"])
      expect(offline.overflowing).toBe(false)
    }
    await page.close()
  })

  test("keeps tablet status content aligned and actionable", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [768, 1023]) {
      await page.setViewport(width, 900)
      await page.navigate(url("/not-a-route"))
      await settleMotion(page)
      const notFound = await page.evaluate(`(() => {
        const card = document.querySelector('.not-found__card')
        const heading = card?.querySelector('h1')
        const description = card?.querySelector('.prose')
        if (!(card instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(description instanceof HTMLElement)) throw new Error('Not-found panel missing')
        const bounds = card.getBoundingClientRect()
        const links = [...card.querySelectorAll('a')]
        return {
          textAlign: getComputedStyle(card).textAlign,
          title: heading.textContent?.trim() ?? '',
          description: description.textContent?.trim() ?? '',
          links: links.map(link => link.getAttribute('href') ?? ''),
          actionHeights: links.map(link => link.getBoundingClientRect().height),
          contained: [heading, description, ...links].every(element => { const rect = element.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right }),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, textAlign: (decodeString)(record["textAlign"]), title: (decodeString)(record["title"]), description: (decodeString)(record["description"]), links: (decodeArray(decodeString))(record["links"]), actionHeights: (decodeArray(decodeNumber))(record["actionHeights"]), contained: (decodeBoolean)(record["contained"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(notFound.textAlign).toBe("center")
      expect(notFound.title).toBe("Page not found")
      expect(notFound.description).not.toBe("")
      expect(notFound.links).toEqual(["/docs", "/", "/remote"])
      expect(Math.min(...notFound.actionHeights)).toBeGreaterThanOrEqual(44)
      expect(notFound.contained).toBe(true)
      expect(notFound.overflowing).toBe(false)

      await page.navigate(url("/offline.html"))
      const offline = await page.evaluate(`(() => {
        const card = document.querySelector('.offline-card')
        const icon = card?.querySelector('.offline-icon')
        const heading = card?.querySelector('h1')
        const description = card?.querySelector('p:not(.status)')
        const retry = card?.querySelector('.retry')
        if (!(card instanceof HTMLElement) || !(icon instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(description instanceof HTMLElement) || !(retry instanceof HTMLElement)) throw new Error('Offline panel missing')
        return {
          height: card.getBoundingClientRect().height,
          iconRight: icon.getBoundingClientRect().right,
          headingLeft: heading.getBoundingClientRect().left,
          descriptionTop: description.getBoundingClientRect().top - card.getBoundingClientRect().top,
          noteCount: card.querySelectorAll('p:not(.status)').length,
          retryHeight: retry.getBoundingClientRect().height,
          retryTop: retry.getBoundingClientRect().top - card.getBoundingClientRect().top,
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), iconRight: (decodeNumber)(record["iconRight"]), headingLeft: (decodeNumber)(record["headingLeft"]), descriptionTop: (decodeNumber)(record["descriptionTop"]), noteCount: (decodeNumber)(record["noteCount"]), retryHeight: (decodeNumber)(record["retryHeight"]), retryTop: (decodeNumber)(record["retryTop"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
      expect(offline.height).toBeLessThanOrEqual(280)
      if (width === 768) {
        expect(Math.abs(offline.height - 237)).toBeLessThanOrEqual(2)
        expect(offline.descriptionTop).toBeGreaterThanOrEqual(108)
        expect(offline.descriptionTop).toBeLessThanOrEqual(113)
        expect(offline.retryTop).toBeGreaterThanOrEqual(165)
        expect(offline.retryTop).toBeLessThanOrEqual(171)
      }
      expect(offline.headingLeft - offline.iconRight).toBeGreaterThanOrEqual(12)
      expect(offline.noteCount).toBe(2)
      expect(offline.retryHeight).toBeGreaterThanOrEqual(44)
      expect(offline.overflowing).toBe(false)
    }
    await page.close()
  })

  test("uses documentation group widths, open releases and unframed recovery content", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/docs"))
    const documentGroups = await page.evaluate(`(() => {
      const content=document.querySelector('.docs--index .docs-article')
      if (!(content instanceof HTMLElement)) throw new Error('Documentation index content is missing')
      return {
        tracks:[...document.querySelectorAll('.docs--index .docs-topic-index .card-grid')].map(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').map(track => Number.parseFloat(track))),
        cards:[...document.querySelectorAll('.docs--index .docs-topic-index .card')].map(card => card.getBoundingClientRect().width),
        contentWidth:content.getBoundingClientRect().width,
        overflow:document.documentElement.scrollWidth > innerWidth,
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, tracks: (decodeArray(decodeArray(decodeNumber)))(record["tracks"]), cards: (decodeArray(decodeNumber))(record["cards"]), contentWidth: (decodeNumber)(record["contentWidth"]), overflow: (decodeBoolean)(record["overflow"]) } })
    expect(documentGroups.tracks.length).toBeGreaterThan(0)
    expect(documentGroups.tracks.every((tracks) => tracks.length >= 1 && tracks.length <= 3 && tracks.every((width) => Math.abs(width - tracks[0]!) <= 1))).toBe(true)
    expect(documentGroups.cards.every((width) => width >= 240 && width <= documentGroups.contentWidth + 1)).toBe(true)
    expect(documentGroups.overflow).toBe(false)
    await page.navigate(url("/changelog"))
    expect(await page.evaluate(`(() => { const release = document.querySelector(".releases--timeline .release"); if (!(release instanceof HTMLElement)) throw new Error("release missing"); return { columns: getComputedStyle(release).gridTemplateColumns.split(" ").length, before: getComputedStyle(release, "::before").content } })()`)).toEqual({ columns: 1, before: "none" })
    await page.navigate(url("/not-a-route"))
    expect(await page.evaluate(`(() => { const card = document.querySelector(".not-found__card"); if (!(card instanceof HTMLElement)) throw new Error("not-found card missing"); const actions = card.querySelector(".not-found__actions"); return { border: Number.parseFloat(getComputedStyle(card).borderTopWidth), justifyItems: getComputedStyle(card).justifyItems, actions: actions instanceof HTMLElement ? getComputedStyle(actions).justifyContent : "" } })()`)).toEqual({ border: 0, justifyItems: "center", actions: "center" })
    await page.close()
  })

  test("renders changelog release status from the live changelog contract", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/changelog"))
    const releases = await page.evaluate(`[...document.querySelectorAll(".releases--timeline .release")].map(release => ({ version: release.querySelector(".release__version")?.textContent?.trim() ?? "", date: release.querySelector(".release__date")?.textContent?.trim() ?? "", tags: [...release.querySelectorAll(".release__tags .tag")].map(tag => tag.textContent?.trim() ?? "") }))`)
    expect(releases).toEqual(RELEASES.map((release) => ({ version: `v${release.version}`, date: release.date, tags: release.tags })))
    expect(await page.evaluate(`[...document.querySelectorAll(".releases--timeline .tag")].map(tag => tag.textContent?.trim() ?? "").filter(tag => tag === "Latest" || tag === "Current")`)).toEqual([])
    await page.close()
  })

  test("aligns the landing divider with the capability grid", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [390, 1440]) {
      await page.setViewport(width, 900)
      await page.navigate(url("/"))
      await settleMotion(page)
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        expect(await page.evaluate(`(() => {
          const grid = document.querySelector(".features__grid")
          const first = grid?.firstElementChild
          const last = grid?.lastElementChild
          if (!(grid instanceof HTMLElement) || !(first instanceof HTMLElement) || !(last instanceof HTMLElement)) throw new Error("landing capabilities missing")
          const style = getComputedStyle(grid)
          const box = grid.getBoundingClientRect()
          return style.borderBlockStartStyle === "solid" && style.borderBlockStartWidth === "1px" && style.borderBlockStartColor !== "transparent" && Math.abs(box.left - first.getBoundingClientRect().left) < 1 && Math.abs(box.right - last.getBoundingClientRect().right) < 1
        })()`)).toBe(true)
      }
    }
    await page.close()
  })

  test("keeps landing and offline touch controls visible without mobile overflow", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/"))
    const landing = await page.evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth, copy: document.querySelector(".hero .code-block__copy")?.getBoundingClientRect().width ?? 0 })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, overflow: (decodeBoolean)(record["overflow"]), copy: (decodeNumber)(record["copy"]) } })
    expect(landing.overflow).toBe(false)
    expect(landing.copy).toBeGreaterThan(0)
    await page.navigate(url("/not-a-route"))
    const actions = await page.evaluate(`[...document.querySelectorAll(".not-found__actions .button")].map(button => { const box = button.getBoundingClientRect(); return { width: box.width, parent: button.parentElement?.getBoundingClientRect().width ?? 0 } })`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), parent: (decodeNumber)(record["parent"]) } }))
    expect(actions).toHaveLength(2)
    expect(actions.every((action) => Math.abs(action.width - action.parent) < 1)).toBe(true)
    await page.close()
  })

  test("keeps open topic lists and groups them into three desktop columns without a duplicate rail", async () => {
    const page = await requireBrowser().openPage()
    const index = async (width: number) => {
      await page.setViewport(width, 900)
      await page.navigate(url("/docs"))
      return page.evaluate(`(() => {
        const group = name => document.querySelector('.docs-topic-index [data-doc-group="'+name+'"]')
        const measure = section => {
          if (!(section instanceof HTMLElement)) throw new Error("group missing")
          const grid = section.querySelector(".card-grid")
          const links = [...section.querySelectorAll(".card__link")]
          return { tracks: grid instanceof HTMLElement ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0, summaries: [...section.querySelectorAll(".card__text")].filter(card => getComputedStyle(card).display !== "none").length, targetHeights: links.map(link => link.getBoundingClientRect().height), hrefs: links.map(link => link.getAttribute("href") ?? "") }
        }
        const gettingStarted = group("get-started")
        const navTitles = [...document.querySelectorAll(".docs-shell__nav .docs-nav__title")]
        const navUsage = navTitles.find(element => element.textContent?.trim() === "Usage")
        return { navGettingStarted: navTitles.find(element => element.textContent?.trim() === "Getting started")?.textContent?.trim(), navUsage: navUsage?.textContent?.trim(), navUsageVisible: navUsage instanceof HTMLElement && navUsage.getClientRects().length>0, indexGettingStarted: [...document.querySelectorAll(".docs-topic-index__label")].map(element => element.textContent?.trim()).find(text => text === "Getting started"), indexUsage: [...document.querySelectorAll(".docs-topic-index__label")].map(element => element.textContent?.trim()).find(text => text === "Usage"), configuration: measure(group("configuration")), gettingStarted: { tonalCards: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card")].filter(card => getComputedStyle(card).borderTopWidth === "0px" && getComputedStyle(card).backgroundColor === "rgba(0, 0, 0, 0)").length : 0, targetHeights: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card__link")].map(link => link.getBoundingClientRect().height) : [], hrefs: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card__link")].map(link => link.getAttribute("href") ?? "") : [] } }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, navGettingStarted: (decodeOptional(decodeString))(record["navGettingStarted"]), navUsage: (decodeOptional(decodeString))(record["navUsage"]), navUsageVisible: (decodeBoolean)(record["navUsageVisible"]), indexGettingStarted: (decodeOptional(decodeString))(record["indexGettingStarted"]), indexUsage: (decodeOptional(decodeString))(record["indexUsage"]), configuration: ((value: unknown) => { const record = decodeRecord(value); return { ...record, tracks: (decodeNumber)(record["tracks"]), summaries: (decodeNumber)(record["summaries"]), targetHeights: (decodeArray(decodeNumber))(record["targetHeights"]), hrefs: (decodeArray(decodeString))(record["hrefs"]) } })(record["configuration"]), gettingStarted: ((value: unknown) => { const record = decodeRecord(value); return { ...record, tonalCards: (decodeNumber)(record["tonalCards"]), targetHeights: (decodeArray(decodeNumber))(record["targetHeights"]), hrefs: (decodeArray(decodeString))(record["hrefs"]) } })(record["gettingStarted"]) } })
    }
    const mobile = await index(390)
    expect(mobile.navUsage).toBe("Usage")
    expect(mobile.indexUsage).toBe("Usage")
    expect(mobile.configuration.tracks).toBe(1)
    expect(mobile.configuration.summaries).toBe(mobile.configuration.hrefs.length)
    expect(mobile.configuration.hrefs).toContain("/docs/configuration")
    expect(mobile.configuration.targetHeights.length).toBeGreaterThan(0)
    expect(mobile.configuration.targetHeights.every((height) => height >= 44)).toBe(true)
    expect(mobile.gettingStarted.tonalCards).toBe(mobile.gettingStarted.hrefs.length)
    expect(mobile.gettingStarted.hrefs).toContain("/docs/quickstart")
    expect(mobile.gettingStarted.targetHeights.length).toBeGreaterThan(0)
    expect(mobile.gettingStarted.targetHeights.every((height) => height >= 44)).toBe(true)
    expect((await index(768)).configuration.tracks).toBe(1)
    const desktop = await index(1440)
    expect(desktop.navGettingStarted).toBe("Getting started")
    expect(desktop.navUsage).toBe("Usage")
    expect(desktop.navUsageVisible).toBe(false)
    expect(desktop.indexGettingStarted).toBe("Getting started")
    expect(desktop.configuration.tracks).toBe(2)
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.docs-topic-index')).gridTemplateColumns.split(' ').length`)).toBe(3)
    await page.close()
  })

  test("announces the current public route and documentation page in navigation", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(url("/docs/quickstart"))
      expect(await page.evaluate(`[...document.querySelectorAll('.nav .nav__link--active, .docs-shell__nav .docs-nav__link--active')].map(link => link.getAttribute('aria-current') ?? '')`)).toEqual(["page", "page"])

      await page.setViewport(390, 900)
      await page.navigate(url("/changelog"))
      await page.evaluate(`document.querySelector('.app-header__menu')?.click()`)
      expect(await page.evaluate(`document.querySelector('.primary-nav__routes .docs-nav__link--active')?.getAttribute('aria-current') ?? ''`)).toBe("page")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("keeps keyboard focus visible inside the open documentation search dialog", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 900)
      await page.navigate(url("/docs/quickstart"))
      await page.evaluate(`document.querySelector('.docs-search-trigger')?.click()`)
      expect(await page.evaluate(`document.querySelector('.overlay--docs-search')?.hasAttribute('open') === true`)).toBe(true)
      for (let step = 0; step < 6; step += 1) {
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate(`document.querySelector('.overlay--docs-search')?.contains(document.activeElement) === true`)).toBe(true)
      }
    } finally {
      await page.close()
    }
  }, 30_000)

  test("uses navigation state-specific surfaces and public heading scales", async () => {
    const page = await requireBrowser().openPage()
    const heading = async (path: string, width: number, selector = "h1") => {
      await page.setViewport(width, 900)
      await page.navigate(url(path))
      return page.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error("heading missing"); const style = getComputedStyle(element); return { size: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight) } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, size: (decodeNumber)(record["size"]), line: (decodeNumber)(record["line"]) } })
    }
    await page.setViewport(768, 900)
    await page.navigate(url("/docs/quickstart"))
    for (let attempt = 0; attempt < 50 && !(await page.evaluate(`document.querySelector('.docs-bar__nav-toggle') instanceof HTMLElement`)); attempt += 1) await Bun.sleep(100)
    await page.evaluate(`document.querySelector(".docs-bar__nav-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    await page.evaluate(`new Promise(resolve => {
      const wait = () => {
        const surface = document.querySelector('.overlay--docs-nav .overlay__surface')
        if (!(surface instanceof HTMLElement)) return requestAnimationFrame(wait)
        Promise.all(surface.getAnimations().map(animation => animation.finished)).then(() => resolve(undefined))
      }
      wait()
    })`)
    const drawer = await page.evaluate(`(() => { const dialog = document.querySelector(".overlay--docs-nav"); const surface = dialog?.querySelector(".overlay__surface"); const close = dialog?.querySelector(".overlay__close"); const header = document.querySelector(".app-header"); if (!(surface instanceof HTMLElement) || !(close instanceof HTMLElement) || !(header instanceof HTMLElement)) throw new Error("docs drawer missing"); const box = surface.getBoundingClientRect(); return { width: box.width, left: box.left, top: box.top, height: box.height, headerHeight: header.getBoundingClientRect().height, close: close.getBoundingClientRect().height } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), left: (decodeNumber)(record["left"]), top: (decodeNumber)(record["top"]), height: (decodeNumber)(record["height"]), headerHeight: (decodeNumber)(record["headerHeight"]), close: (decodeNumber)(record["close"]) } })
    expect(drawer).toEqual({ width: 320, left: 0, top: drawer.headerHeight, height: 900 - drawer.headerHeight, headerHeight: drawer.headerHeight, close: 44 })
    await page.setViewport(1440, 900)
    await page.navigate(url("/docs"))
    await page.evaluate(`document.querySelector(".docs-search-trigger")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    expect(await page.evaluate(`Number.parseFloat(getComputedStyle(document.querySelector(".overlay--docs-search .overlay__surface")).inlineSize)`)).toBe(600)
    expect(await page.evaluate(`!!document.querySelector('.overlay--docs-search .overlay__head #docs-search-field')`)).toBe(true)
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.overlay--docs-search .overlay__surface')).insetBlockStart`)).toBe("96px")
    await page.evaluate(`(()=>{const input=document.querySelector('.overlay--docs-search input');input.value='autonom';input.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`)
    await settleMotion(page)
    expect(await page.evaluate(`(()=>{const footer=document.querySelector('.docs-search__footer').getBoundingClientRect(),surface=document.querySelector('.overlay--docs-search .overlay__surface').getBoundingClientRect(),results=document.querySelector('.search__results');return footer.top>=surface.top&&footer.bottom<=surface.bottom&&results.scrollHeight>results.clientHeight})()`)).toBe(true)
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    await page.evaluate(`document.querySelector(".app-header__menu")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    await settleMotion(page)
    const primary = await page.evaluate(`(() => { const dialog = document.querySelector(".overlay--primary-nav"); const surface = dialog?.querySelector(".overlay__surface"); if (!(surface instanceof HTMLElement)) throw new Error("primary navigation missing"); const box = surface.getBoundingClientRect(); const targets = [...surface.querySelectorAll("a,button")].map(target => target.getBoundingClientRect().height); return { width: box.width, height: box.height, brand: !!surface.querySelector(".primary-nav__brand"), routeBoxes: surface.querySelectorAll(".primary-nav__routes .docs-nav__link").length, activeRoute: surface.querySelector(".primary-nav__routes .docs-nav__link--active")?.textContent?.trim(), actionOrder: [...surface.querySelectorAll(".primary-nav__actions > *")].map(action => action.textContent?.trim() ?? ""), targets } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), height: (decodeNumber)(record["height"]), brand: (decodeBoolean)(record["brand"]), routeBoxes: (decodeNumber)(record["routeBoxes"]), activeRoute: (decodeOptional(decodeString))(record["activeRoute"]), actionOrder: (decodeArray(decodeString))(record["actionOrder"]), targets: (decodeArray(decodeNumber))(record["targets"]) } })
    expect(primary.width).toBe(390)
    expect(primary.height).toBeLessThan(844)
    expect(primary.height).toBeGreaterThan(44 * primary.routeBoxes)
    expect(await page.evaluate(`(() => { const surface = document.querySelector('.overlay--primary-nav .overlay__surface'); const box = surface.getBoundingClientRect(); return Math.abs(box.bottom - innerHeight) <= 1 && [...surface.querySelectorAll('a,button')].every(target => { const rect = target.getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom && rect.left >= box.left && rect.right <= box.right }) })()`)).toBe(true)
    expect(primary.brand).toBe(true)
    expect(primary.routeBoxes).toBe(3)
    expect(primary.activeRoute).toBe("Documentation")
    expect(primary.actionOrder).toEqual(["Open workspace", "Search docs/"])
    expect(primary.targets.every((height) => height >= 44)).toBe(true)
    expect(await heading("/", 390, ".hero__headline")).toEqual({ size: 24, line: 33 })
    expect(await heading("/", 768, ".hero__headline")).toEqual({ size: 30, line: 37.5 })
    expect(await heading("/", 1440, ".hero__headline")).toEqual({ size: 48, line: 48 })
    expect(await heading("/docs", 390, ".docs-article > h1")).toEqual({ size: 16, line: 24 })
    expect(await heading("/docs", 768, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/docs", 1440, ".docs-article > h1")).toEqual({ size: 30, line: 38 })
    expect(await heading("/docs/quickstart", 390, ".docs-article > h1")).toEqual({ size: 22, line: 22 })
    expect(await heading("/docs/quickstart", 768, ".docs-article > h1")).toEqual({ size: 24, line: 30 })
    expect(await heading("/docs/quickstart", 1440, ".docs-article > h1")).toEqual({ size: 26, line: 32 })
    expect(await heading("/changelog", 390, ".docs-article > h1")).toEqual({ size: 16, line: 24 })
    expect(await heading("/changelog", 768, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/changelog", 1440, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/not-a-route", 390, ".not-found h1")).toEqual({ size: 40, line: 44 })
    expect(await heading("/not-a-route", 768, ".not-found h1")).toEqual({ size: 40, line: 44 })
    expect(await heading("/not-a-route", 1440, ".not-found h1")).toEqual({ size: 56, line: 60 })
    expect(await heading("/offline.html", 390, ".offline-card h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/offline.html", 768, ".offline-card h1")).toEqual({ size: 18, line: 27 })
    expect(await heading("/offline.html", 1440, ".offline-card h1")).toEqual({ size: 20, line: 28 })
    await page.close()
  }, 60_000)

  test("keeps the search shortcut owned by its active dialog", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    await page.evaluate(`(() => { const menu = document.querySelector(".app-header__menu"); if (!(menu instanceof HTMLButtonElement)) throw new Error("menu missing"); menu.dispatchEvent(new MouseEvent("click", { bubbles: true })); menu.focus(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })) })()`)
    const opened = await page.evaluate(`({ dialogs: document.querySelectorAll(".overlay--docs-search[open]").length, inputIds: [...document.querySelectorAll("#docs-search-field")].map(input => input.id) })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, dialogs: (decodeNumber)(record["dialogs"]), inputIds: (decodeArray(decodeString))(record["inputIds"]) } })
    expect(opened.dialogs).toBe(1)
    expect(new Set(opened.inputIds).size).toBe(1)
    expect(opened.inputIds).toEqual(["docs-search-field"])
    await page.evaluate(`(() => { const input = document.querySelector(".overlay--docs-search #docs-search-field"); if (!(input instanceof HTMLInputElement)) throw new Error("search input missing"); input.value = "quickstart"; input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "quickstart" })) })()`)
    await page.pressEscape()
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, 50))`)
    expect(await page.evaluate(`document.querySelectorAll(".overlay--primary-nav[open]").length`)).toBe(1)
    expect(await page.evaluate(`document.querySelectorAll(".overlay--docs-search[open]").length`)).toBe(0)
    expect(await page.evaluate(`({ tag: document.activeElement?.tagName ?? "", className: document.activeElement instanceof HTMLElement ? document.activeElement.className : "" })`)).toEqual({ tag: "BUTTON", className: "docs-search-trigger" })
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`)
    await page.evaluate(`document.querySelector(".overlay--docs-search .search__result")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, 50))`)
    expect(await page.evaluate(`({ path: location.pathname, dialogs: document.querySelectorAll("dialog[open]").length })`)).toEqual({ path: "/docs/quickstart", dialogs: 0 })
    await page.close()
  }, 10_000)

  test("returns focus to each public menu opener after an unfocused click", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(url("/docs/quickstart"))
      for (const [trigger, dialog] of [[".app-header__menu", ".overlay--primary-nav"], [".docs-bar__nav-toggle", ".overlay--docs-nav"]] as const) {
        await page.evaluate(`document.querySelector('.skip-link')?.focus(); document.querySelector('${trigger}')?.click()`)
        expect(await page.evaluate(`document.querySelector('${dialog}[open]') !== null`)).toBe(true)
        await page.pressEscape()
        expect(await page.evaluate(`document.querySelector('${dialog}[open]') === null && document.activeElement === document.querySelector('${trigger}')`)).toBe(true)
      }
    } finally { await page.close() }
  }, 10_000)

  test("the documentation index has one header search and open topic links on their group edge", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(url("/docs"))
      expect(await page.evaluate(`document.querySelectorAll('.docs-search-trigger').length`)).toBe(1)
      expect(await page.evaluate(`document.querySelector('.docs--index .docs-article').getBoundingClientRect().width`)).toBe(1280)
      expect(await page.evaluate(`!!document.querySelector('.app-header .docs-search-trigger')`)).toBe(true)
      expect(await page.evaluate(`!!document.querySelector('.docs--index .docs-bar')`)).toBe(false)
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.docs-topic-index [data-doc-group="configuration"] .card-grid')).gridTemplateColumns.split(' ').length`)).toBe(2)
      expect(await page.evaluate(`[...document.querySelectorAll('.docs-topic-index .doc-section')].every(section=>Math.abs(section.querySelector('.card__title').getBoundingClientRect().left-section.querySelector('h2').getBoundingClientRect().left)<=1)`)).toBe(true)
    } finally { await page.close() }
  }, 10_000)

  test("documentation search caps its result list while keeping every result and keyboard controls reachable", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setReducedMotion(true)
      await page.setViewport(1440, 900)
      await page.navigate(url("/docs"))
      await page.evaluate(`document.querySelector('.docs-search-trigger').click()`)
      await page.evaluate(`(()=>{const input=document.querySelector('#docs-search-field');input.value='autonom';input.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`)
      const layout = await page.evaluate(`(()=>{const list=document.querySelector('.search__results'),surface=document.querySelector('.overlay--docs-search .overlay__surface').getBoundingClientRect(),footer=document.querySelector('.docs-search__footer').getBoundingClientRect();return{height:list.getBoundingClientRect().height,max:getComputedStyle(list).maxBlockSize,scrolls:list.scrollHeight>list.clientHeight,count:list.children.length,footer:footer.bottom<=surface.bottom,close:!!document.querySelector('.overlay--docs-search .overlay__close').getClientRects().length}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), max: (decodeString)(record["max"]), scrolls: (decodeBoolean)(record["scrolls"]), count: (decodeNumber)(record["count"]), footer: (decodeBoolean)(record["footer"]), close: (decodeBoolean)(record["close"]) } })
      expect(layout.max).toBe("380px")
      expect(layout.height).toBeLessThanOrEqual(380)
      expect(layout.scrolls).toBe(true)
      expect(layout.count).toBe(8)
      expect(layout.footer).toBe(true)
      expect(layout.close).toBe(true)
      for (let index = 0; index < 7; index++) await page.pressKey("ArrowDown", "ArrowDown", 40)
      expect(await page.evaluate(`document.querySelector('#docs-search-field').getAttribute('aria-activedescendant')`)).toBe("docs-search-option-7")
      expect(await page.evaluate(`(()=>{const list=document.querySelector('.search__results').getBoundingClientRect(),active=document.querySelector('.search__result--active').getBoundingClientRect();return active.top>=list.top&&active.bottom<=list.bottom})()`)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate(`document.activeElement===document.querySelector('.docs-search-trigger')`)).toBe(true)
    } finally { await page.close() }
  }, 10_000)
})

function requireBrowser() {
  if (!browser) throw new Error("Browser was not initialized")
  return browser
}

async function waitFor(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>, selector: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return
    await Bun.sleep(25)
  }
  throw new Error(`Public route did not mount ${selector}`)
}

async function settleMotion(page: Awaited<ReturnType<ReturnType<typeof requireBrowser>["openPage"]>>) {
  await page.evaluate(`new Promise(resolve => {
    const settle = () => document.documentElement.dataset.motion === "on"
      ? Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)).then(() => resolve(undefined))
      : requestAnimationFrame(settle)
    settle()
  })`)
}

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(url("/"))).ok
  } catch {
    return false
  }
}
