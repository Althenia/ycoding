import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { RELEASES } from "../src/content/changelog"
import { SITEMAP_PATHS } from "../src/seo/sitemap"
import { launchBrowser } from "./cdp"

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

describe("public Stitch fidelity", () => {
  test("keeps short-page footers at the viewport edge without fixing long-page footers", async () => {
    const page = await requireBrowser().openPage()
    const measure = () =>
      page.evaluate<{
        readonly viewport: { readonly width: number; readonly height: number }
        readonly footer: { readonly top: number; readonly bottom: number; readonly position: string }
        readonly main: { readonly top: number; readonly bottom: number }
        readonly document: { readonly height: number; readonly scrollHeight: number; readonly scrollWidth: number }
      }>(`(() => {
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
      })()`)
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
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    await page.close()
  })

  test("uses one radius for public controls and raised surfaces without narrow overflow", async () => {
    const page = await requireBrowser().openPage()
    const radii = async (path: string, selectors: readonly string[]) => {
      await page.navigate(url(path))
      return page.evaluate<readonly string[]>(`[...${JSON.stringify(selectors)}].map(selector => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error("missing public surface: " + selector)
        return getComputedStyle(element).borderRadius
      })`)
    }
    expect(await radii("/", [".button--primary", ".feature", ".code-block"])).toEqual(["10px", "10px", "10px"])
    expect(await radii("/docs", [".docs-bar__nav-toggle", ".docs-search-trigger", ".doc-section", ".card"])).toEqual(["10px", "10px", "10px", "10px"])
    expect(await radii("/docs/quickstart", [".code-block", ".callout"])).toEqual(["10px", "10px"])
    expect(await radii("/changelog", [".release", ".filters__option"])).toEqual(["10px", "10px"])
    await page.setViewport(390, 844)
    for (const path of ["/", "/docs", "/docs/quickstart", "/changelog"]) {
      await page.navigate(url(path))
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
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
          await page.evaluate<boolean>(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true })()`)
          const layout = await page.evaluate<{
            readonly overflow: boolean
            readonly mainHeight: number
            readonly footerBottom: number
            readonly rootHeight: number
            readonly short: boolean
          }>(`(() => {
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
          })()`)
          expect(layout.overflow).toBe(false)
          expect(layout.mainHeight).toBeGreaterThan(0)
          if (layout.short) expect(Math.abs(layout.footerBottom - layout.rootHeight)).toBeLessThanOrEqual(1)
        }
      }
    }
    await page.close()
  }, 60_000)

  test("keeps P09 copy actionable and compact footer links reachable", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/"))
    const before = await page.evaluate<{ readonly copyVisible: boolean; readonly headVisible: boolean; readonly footerLinks: readonly string[] }>(`(() => {
      const copy = document.querySelector(".hero .code-block__copy")
      const head = document.querySelector(".hero .code-block__head")
      return { copyVisible: copy instanceof HTMLElement && getComputedStyle(copy).display !== "none", headVisible: head instanceof HTMLElement && getComputedStyle(head).display !== "none", footerLinks: [...document.querySelectorAll(".footer__compact .footer__links a")].map(link => link.getAttribute("href")) }
    })()`)
    expect(before.copyVisible).toBe(true)
    expect(before.headVisible).toBe(true)
    expect(before.footerLinks).toContain("/remote")
    await page.evaluate<void>(`document.querySelector(".hero .code-block__copy")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    expect(await page.evaluate<string>(`document.querySelector(".hero .code-block__copy")?.getAttribute("aria-label")`)).toBe("Copied")
    await page.close()
  })

  test("keeps the approved P09 mobile navigation and capability composition", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/"))
    const layout = await page.evaluate<{
      readonly navVisible: boolean
      readonly headerActionVisible: boolean
      readonly headerBottom: number
      readonly headlineHeight: number
      readonly supportSize: number
      readonly supportHeight: number
      readonly primaryActionTop: number
      readonly codeTop: number
      readonly firstFeatureTop: number
      readonly featureHeights: readonly number[]
      readonly overflowing: boolean
    }>(`(() => {
      const nav = document.querySelector('.marketing .nav')
      const header = document.querySelector('.marketing .app-header')
      const headerAction = document.querySelector('.marketing .app-header__cta a')
      const headline = document.querySelector('.marketing .hero__headline')
      const support = document.querySelector('.marketing .hero__support')
      const primaryAction = document.querySelector('.marketing .hero__actions .button')
      const code = document.querySelector('.marketing .hero .code-block')
      const actionRect = headerAction?.getBoundingClientRect()
      const features = [...document.querySelectorAll('.marketing .feature')]
      if (!(nav instanceof HTMLElement) || !(header instanceof HTMLElement) || !(headline instanceof HTMLElement) || !(support instanceof HTMLElement) || !(primaryAction instanceof HTMLElement) || !(code instanceof HTMLElement) || features.length !== 4) throw new Error('P09 composition missing')
      return {
        navVisible: getComputedStyle(nav).display !== 'none',
        headerActionVisible: headerAction instanceof HTMLElement && getComputedStyle(headerAction).display !== 'none' && !!actionRect && actionRect.top >= 0 && actionRect.bottom <= 60 && actionRect.right <= innerWidth && actionRect.height >= 44,
        headerBottom: header.getBoundingClientRect().bottom,
        headlineHeight: headline.getBoundingClientRect().height,
        supportSize: parseFloat(getComputedStyle(support).fontSize),
        supportHeight: support.getBoundingClientRect().height,
        primaryActionTop: primaryAction.getBoundingClientRect().top,
        codeTop: code.getBoundingClientRect().top,
        firstFeatureTop: features[0].getBoundingClientRect().top,
        featureHeights: features.map(feature => feature.getBoundingClientRect().height),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`)
    expect(layout.navVisible).toBe(true)
    expect(layout.headerActionVisible).toBe(true)
    expect(layout.headerBottom).toBeGreaterThanOrEqual(96)
    expect(layout.headlineHeight).toBeGreaterThanOrEqual(64)
    expect(layout.supportSize).toBe(14)
    expect(layout.supportHeight).toBeLessThanOrEqual(24)
    expect(layout.primaryActionTop).toBeGreaterThanOrEqual(245)
    expect(layout.primaryActionTop).toBeLessThanOrEqual(255)
    expect(layout.codeTop).toBeGreaterThanOrEqual(365)
    expect(layout.codeTop).toBeLessThanOrEqual(375)
    expect(layout.firstFeatureTop).toBeGreaterThanOrEqual(460)
    expect(layout.firstFeatureTop).toBeLessThanOrEqual(510)
    expect(Math.max(...layout.featureHeights)).toBeLessThanOrEqual(135)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps P09 tablet capability cards compact with all four descriptions", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 1024)
    await page.navigate(url("/"))
    const layout = await page.evaluate<{
      readonly heights: readonly number[]
      readonly descriptions: readonly string[]
      readonly descriptionSize: number
      readonly overflowing: boolean
    }>(`(() => {
      const features = [...document.querySelectorAll('.marketing .feature')]
      const description = features[0]?.querySelector('.feature__text')
      if (features.length !== 4 || !(description instanceof HTMLElement)) throw new Error('Tablet capabilities missing')
      return {
        heights: features.map(feature => feature.getBoundingClientRect().height),
        descriptions: features.map(feature => feature.querySelector('.feature__text')?.textContent.trim() ?? ''),
        descriptionSize: parseFloat(getComputedStyle(description).fontSize),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`)
    expect(Math.max(...layout.heights)).toBeLessThanOrEqual(145)
    expect(layout.descriptions.every(description => description.length > 0)).toBe(true)
    expect(layout.descriptionSize).toBeGreaterThanOrEqual(14)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps every P09 tablet footer link reachable in a compact wrap", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 900)
    await page.navigate(url("/"))
    const footer = await page.evaluate<{
      readonly height: number
      readonly rows: number
      readonly links: readonly string[]
      readonly linkHeights: readonly number[]
      readonly linkSize: number
      readonly licenseVisible: boolean
      readonly overflowing: boolean
    }>(`(() => {
      const footer = document.querySelector('.marketing .site-footer')
      const links = [...document.querySelectorAll('.marketing .footer__compact .footer__links a')]
      const license = document.querySelector('.marketing .footer__compact > span')
      if (!(footer instanceof HTMLElement) || !(license instanceof HTMLElement) || links.length === 0) throw new Error('Marketing footer missing')
      return {
        height: footer.getBoundingClientRect().height,
        rows: new Set(links.map(link => Math.round(link.getBoundingClientRect().top))).size,
        links: links.map(link => link.getAttribute('href') ?? ''),
        linkHeights: links.map(link => link.getBoundingClientRect().height),
        linkSize: parseFloat(getComputedStyle(links[0]).fontSize),
        licenseVisible: license.getBoundingClientRect().height > 0,
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`)
    expect(footer.height).toBeLessThanOrEqual(150)
    expect(footer.rows).toBeLessThanOrEqual(3)
    expect(footer.links).toHaveLength(13)
    expect(footer.links).toContain("/remote")
    expect(Math.min(...footer.linkHeights)).toBeGreaterThanOrEqual(44)
    expect(footer.linkSize).toBeGreaterThanOrEqual(13)
    expect(footer.licenseVisible).toBe(true)
    expect(footer.overflowing).toBe(false)
    await page.setViewport(390, 844)
    const mobile = await page.evaluate<{ readonly linkHeights: readonly number[]; readonly overflowing: boolean }>(`(() => ({
      linkHeights: [...document.querySelectorAll('.marketing .footer__compact .footer__links a')].map(link => link.getBoundingClientRect().height),
      overflowing: document.documentElement.scrollWidth > innerWidth,
    }))()`)
    expect(mobile.linkHeights).toHaveLength(13)
    expect(Math.min(...mobile.linkHeights)).toBeGreaterThanOrEqual(44)
    expect(mobile.overflowing).toBe(false)
    await page.close()
  })

  test("keeps P10 mobile topic groups compact without shrinking links", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    const layout = await page.evaluate<{
      readonly firstGroupTop: number
      readonly firstGroupHeight: number
      readonly linkHeights: readonly number[]
      readonly overflowing: boolean
    }>(`(() => {
      const group = document.querySelector('.docs--index .docs-topic-index [data-doc-group="get-started"]')
      if (!(group instanceof HTMLElement)) throw new Error('Getting started group missing')
      return {
        firstGroupTop: group.getBoundingClientRect().top,
        firstGroupHeight: group.getBoundingClientRect().height,
        linkHeights: [...group.querySelectorAll('.card__link')].map(link => link.getBoundingClientRect().height),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`)
    expect(layout.firstGroupTop).toBeLessThanOrEqual(360)
    expect(layout.firstGroupHeight).toBeLessThanOrEqual(280)
    expect(layout.linkHeights).toHaveLength(3)
    expect(Math.min(...layout.linkHeights)).toBeGreaterThanOrEqual(44)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps P10 tablet and desktop topic links compact without decorative rows", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [768, 1440]) {
      await page.setViewport(width, 900)
      await page.navigate(url("/docs"))
      const layout = await page.evaluate<{
        readonly links: number
        readonly visibleTitles: number
        readonly visibleDescriptions: number
        readonly decorativeIcons: number
        readonly minLinkHeight: number
        readonly overflowing: boolean
      }>(`(() => {
        const links = [...document.querySelectorAll('.docs--index .card__link')]
        return {
          links: links.length,
          visibleTitles: links.filter(link => link.querySelector('.card__title')?.getBoundingClientRect().height > 0).length,
          visibleDescriptions: links.filter(link => link.querySelector('.card__text')?.getBoundingClientRect().height > 0).length,
          decorativeIcons: links.filter(link => { const icon = link.querySelector('svg'); return icon instanceof SVGElement && getComputedStyle(icon).display !== 'none' }).length,
          minLinkHeight: Math.min(...links.map(link => link.getBoundingClientRect().height)),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(layout.links).toBe(22)
      expect(layout.visibleTitles).toBe(layout.links)
      expect(layout.visibleDescriptions).toBe(layout.links)
      expect(layout.decorativeIcons).toBe(0)
      expect(layout.minLinkHeight).toBeGreaterThanOrEqual(44)
      expect(layout.overflowing).toBe(false)
    }
    await page.close()
  })

  test("uses the available P10 index width without an empty desktop contents column", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, left, minWidth] of [[390, 16, 354], [768, 24, 716], [1280, 288, 948], [1440, 288, 1100], [2048, 296, 1690]] as const) {
      await page.setViewport(width, 900)
      await page.navigate(url("/docs"))
      const layout = await page.evaluate<{
        readonly left: number
        readonly width: number
        readonly columns: number
        readonly links: number
        readonly minLinkHeight: number
        readonly overflowing: boolean
      }>(`(() => {
        const group = document.querySelector('.docs--index .docs-topic-index [data-doc-group="get-started"]')
        const shell = document.querySelector('.docs--index .docs-shell')
        const links = [...document.querySelectorAll('.docs--index .doc-section .card__link')]
        if (!(group instanceof HTMLElement) || !(shell instanceof HTMLElement) || links.length === 0) throw new Error('P10 index missing')
        const rect = group.getBoundingClientRect()
        return {
          left: rect.left,
          width: rect.width,
          columns: getComputedStyle(shell).gridTemplateColumns.split(' ').length,
          links: links.length,
          minLinkHeight: Math.min(...links.map(link => link.getBoundingClientRect().height)),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(layout.left).toBeGreaterThanOrEqual(left - 2)
      expect(layout.left).toBeLessThanOrEqual(left + 2)
      expect(layout.width).toBeGreaterThanOrEqual(minWidth)
      expect(layout.columns).toBe(width >= 1024 ? 2 : 1)
      expect(layout.links).toBe(22)
      expect(layout.minLinkHeight).toBeGreaterThanOrEqual(44)
      expect(layout.overflowing).toBe(false)
    }
    await page.close()
  })

  test("keeps P11 mobile article rhythm compact while retaining published guidance", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs/quickstart"))
    const layout = await page.evaluate<{
      readonly sectionPadding: number
      readonly sectionHeadingSize: number
      readonly guidanceVisible: boolean
      readonly overflowing: boolean
    }>(`(() => {
      const section = document.querySelector('.docs--article .doc-section')
      const heading = section?.querySelector('h2')
      if (!(section instanceof HTMLElement) || !(heading instanceof HTMLElement)) throw new Error('Quickstart section missing')
      return {
        sectionPadding: parseFloat(getComputedStyle(section).paddingTop),
        sectionHeadingSize: parseFloat(getComputedStyle(heading).fontSize),
        guidanceVisible: document.querySelector('.docs-article')?.textContent?.includes('One direct run') === true,
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`)
    expect(layout.sectionPadding).toBeLessThanOrEqual(16)
    expect(layout.sectionHeadingSize).toBeLessThanOrEqual(18)
    expect(layout.guidanceVisible).toBe(true)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("keeps P11 article details readable with compact mobile blocks", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs/quickstart"))
    const layout = await page.evaluate<{
      readonly ledeSize: number
      readonly sectionPadding: readonly number[]
      readonly codePadding: readonly number[]
      readonly copyHeights: readonly number[]
      readonly tableCellPadding: number
      readonly sections: number
      readonly overflowing: boolean
    }>(`(() => {
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
    })()`)
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

  test("shows P13 mobile change-type filters without losing the year filter", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/changelog"))
    const before = await page.evaluate<{ readonly labels: readonly string[]; readonly heights: readonly number[]; readonly yearTrigger: boolean }>(`(() => {
      const filters = [...document.querySelectorAll('.release__inline-filters button')]
      const yearTrigger = document.querySelector('.docs--changelog .docs-bar__nav-toggle')
      return {
        labels: filters.map(button => button.textContent.trim()),
        heights: filters.map(button => button.getBoundingClientRect().height),
        yearTrigger: yearTrigger instanceof HTMLElement && getComputedStyle(yearTrigger).display !== 'none',
      }
    })()`)
    expect(before.labels).toEqual(["All", "Added", "Changed", "Fixed"])
    expect(Math.min(...before.heights)).toBeGreaterThanOrEqual(44)
    expect(before.yearTrigger).toBe(true)
    await page.evaluate<boolean>(`(() => { const added = [...document.querySelectorAll('.release__inline-filters button')].find(button => button.textContent.trim() === 'Added'); if (!(added instanceof HTMLButtonElement)) return false; added.click(); return true })()`)
    const filtered = await page.evaluate<{ readonly pressed: boolean; readonly groups: readonly string[] }>(`(() => ({
      pressed: document.querySelector('.release__inline-filters button:nth-of-type(2)')?.getAttribute('aria-pressed') === 'true',
      groups: [...document.querySelectorAll('.release__change h4')].map(group => group.textContent.trim()),
    }))()`)
    expect(filtered.pressed).toBe(true)
    expect(filtered.groups.length).toBeGreaterThan(0)
    expect(filtered.groups.every(group => group === "Added")).toBe(true)
    await page.close()
  })

  test("keeps the P13 mobile release stream compact without dropping notes", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/changelog"))
    const layout = await page.evaluate<{
      readonly ledeSize: number
      readonly cardPadding: number
      readonly groupGap: number
      readonly notes: number
      readonly releases: number
      readonly overflowing: boolean
    }>(`(() => {
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
    })()`)
    expect(layout.ledeSize).toBeLessThanOrEqual(14)
    expect(layout.cardPadding).toBeLessThanOrEqual(12)
    expect(layout.groupGap).toBeLessThanOrEqual(8)
    expect(layout.notes).toBeGreaterThan(0)
    expect(layout.releases).toBeGreaterThan(0)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("uses the P13 compact tablet release rhythm with every note retained", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 1024)
    await page.navigate(url("/changelog"))
    const layout = await page.evaluate<{
      readonly ledeSize: number
      readonly cardPadding: number
      readonly groupGap: number
      readonly noteCount: number
      readonly groupCount: number
      readonly filterHeight: number
      readonly overflowing: boolean
    }>(`(() => {
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
    })()`)
    expect(layout.ledeSize).toBeLessThanOrEqual(14)
    expect(layout.cardPadding).toBeLessThanOrEqual(12)
    expect(layout.groupGap).toBeLessThanOrEqual(8)
    expect(layout.noteCount).toBeGreaterThan(0)
    expect(layout.groupCount).toBeGreaterThan(0)
    expect(layout.filterHeight).toBeGreaterThanOrEqual(44)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("uses the available P13 phone and tablet width without dropping release controls", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, left, minWidth] of [[390, 16, 354], [768, 24, 716]] as const) {
      await page.setViewport(width, 1024)
      await page.navigate(url("/changelog"))
      const layout = await page.evaluate<{
        readonly left: number
        readonly width: number
        readonly filterCount: number
        readonly minFilterHeight: number
        readonly releases: number
        readonly notes: number
        readonly overflowing: boolean
      }>(`(() => {
        const card = document.querySelector('.docs--changelog .releases--timeline .release')
        const filters = [...document.querySelectorAll('.docs--changelog .release__inline-filters button')]
        if (!(card instanceof HTMLElement) || filters.length === 0) throw new Error('P13 release controls missing')
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
      })()`)
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

  test("uses the P13 desktop release width without reserving an empty contents rail", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [1280, 1440, 2048] as const) {
      await page.setViewport(width, 900)
      await page.navigate(url("/changelog"))
      const layout = await page.evaluate<{
        readonly cardLeft: number
        readonly cardWidth: number
        readonly columns: number
        readonly contentsRail: boolean
        readonly filtersVisible: boolean
        readonly notes: number
        readonly overflowing: boolean
      }>(`(() => {
        const shell = document.querySelector('.docs--changelog .docs-shell')
        const card = document.querySelector('.docs--changelog .releases--timeline .release')
        const filters = document.querySelector('.docs--changelog .docs-shell__nav .filters--release')
        if (!(shell instanceof HTMLElement) || !(card instanceof HTMLElement)) throw new Error('P13 desktop release layout missing')
        const rect = card.getBoundingClientRect()
        return {
          cardLeft: rect.left,
          cardWidth: rect.width,
          columns: getComputedStyle(shell).gridTemplateColumns.split(' ').length,
          contentsRail: shell.querySelector('.docs-shell__toc') !== null,
          filtersVisible: filters instanceof HTMLElement && filters.getBoundingClientRect().height > 0,
          notes: document.querySelectorAll('.docs--changelog .release__change li').length,
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(layout.cardWidth).toBeGreaterThanOrEqual(760)
      expect(layout.cardWidth).toBeLessThanOrEqual(776)
      expect(layout.columns).toBe(2)
      expect(layout.contentsRail).toBe(false)
      expect(layout.filtersVisible).toBe(true)
      expect(layout.notes).toBeGreaterThan(0)
      expect(layout.overflowing).toBe(false)
      if (width === 1440) {
        expect(layout.cardLeft).toBeGreaterThanOrEqual(405)
        expect(layout.cardLeft).toBeLessThanOrEqual(415)
      }
    }
    await page.close()
  })

  test("fills the P14 offline mobile frame while retaining its navigation and retry", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [320, 390]) {
      await page.setViewport(width, 844)
      await page.navigate(url("/offline.html"))
      const layout = await page.evaluate<{
        readonly cardWidth: number
        readonly links: readonly string[]
        readonly actionHeight: number
        readonly overflowing: boolean
      }>(`(() => {
        const card = document.querySelector('.offline-card')
        const action = card?.querySelector('.retry')
        if (!(card instanceof HTMLElement) || !(action instanceof HTMLAnchorElement)) throw new Error('Offline panel missing')
        return {
          cardWidth: card.getBoundingClientRect().width,
          links: [...document.querySelectorAll('a')].map(link => link.getAttribute('href') ?? ''),
          actionHeight: action.getBoundingClientRect().height,
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(layout.cardWidth).toBeGreaterThanOrEqual(width - 4)
      expect(layout.links).toEqual(["/", "/", "/docs", "/changelog", "/remote"])
      expect(layout.actionHeight).toBeGreaterThanOrEqual(44)
      expect(layout.overflowing).toBe(false)
    }
    await page.close()
  })

  test("keeps P14 mobile not-found actions inside the approved full-width panel", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/not-a-route"))
    const layout = await page.evaluate<{
      readonly cardWidth: number
      readonly cardHeight: number
      readonly iconTop: number
      readonly firstActionTop: number
      readonly workspaceLink: boolean
      readonly actions: readonly number[]
      readonly overflowing: boolean
    }>(`(() => {
      const card = document.querySelector('.not-found__card')
      if (!(card instanceof HTMLElement)) throw new Error('404 card missing')
      const icon = card.querySelector('.not-found__icon')
      const firstAction = card.querySelector('.not-found__actions a')
      if (!(icon instanceof HTMLElement) || !(firstAction instanceof HTMLElement)) throw new Error('404 actions missing')
      return {
        cardWidth: card.getBoundingClientRect().width,
        cardHeight: card.getBoundingClientRect().height,
        iconTop: icon.getBoundingClientRect().top - card.getBoundingClientRect().top,
        firstActionTop: firstAction.getBoundingClientRect().top - card.getBoundingClientRect().top,
        workspaceLink: card.querySelector('a[href="/remote"]') instanceof HTMLAnchorElement,
        actions: [...card.querySelectorAll('a')].map(link => link.getBoundingClientRect().height),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }
    })()`)
    expect(layout.cardWidth).toBeGreaterThanOrEqual(386)
    expect(layout.cardHeight).toBeGreaterThanOrEqual(450)
    expect(layout.iconTop).toBeLessThanOrEqual(28)
    expect(layout.firstActionTop).toBeGreaterThanOrEqual(270)
    expect(layout.firstActionTop).toBeLessThanOrEqual(290)
    expect(layout.workspaceLink).toBe(true)
    expect(layout.actions).toHaveLength(3)
    expect(Math.min(...layout.actions)).toBeGreaterThanOrEqual(44)
    expect(layout.overflowing).toBe(false)
    await page.close()
  })

  test("uses the P14 tablet and desktop panel widths without losing status actions", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, expected] of [[768, 718], [1440, 671]] as const) {
      await page.setViewport(width, 900)
      await page.navigate(url("/not-a-route"))
      const notFound = await page.evaluate<{ readonly width: number; readonly height: number; readonly links: readonly string[]; readonly overflowing: boolean }>(`(() => {
        const card = document.querySelector('.not-found__card')
        if (!(card instanceof HTMLElement)) throw new Error('Not-found panel missing')
        return {
          width: card.getBoundingClientRect().width,
          height: card.getBoundingClientRect().height,
          links: [...card.querySelectorAll('a')].map(link => link.getAttribute('href') ?? ''),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(Math.abs(notFound.width - expected)).toBeLessThanOrEqual(3)
      if (width === 1440) expect(Math.abs(notFound.height - 420)).toBeLessThanOrEqual(2)
      expect(notFound.links).toEqual(["/docs", "/", "/remote"])
      expect(notFound.overflowing).toBe(false)

      await page.navigate(url("/offline.html"))
      const offline = await page.evaluate<{ readonly width: number; readonly height: number; readonly links: readonly string[]; readonly overflowing: boolean }>(`(() => {
        const card = document.querySelector('.offline-card')
        if (!(card instanceof HTMLElement)) throw new Error('Offline panel missing')
        return {
          width: card.getBoundingClientRect().width,
          height: card.getBoundingClientRect().height,
          links: [...document.querySelectorAll('a')].map(link => link.getAttribute('href') ?? ''),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(Math.abs(offline.width - expected)).toBeLessThanOrEqual(3)
      if (width === 1440) expect(Math.abs(offline.height - 420)).toBeLessThanOrEqual(2)
      expect(offline.links).toEqual(["/", "/", "/docs", "/changelog", "/remote"])
      expect(offline.overflowing).toBe(false)
    }
    await page.close()
  })

  test("places P14 tablet status copy beside its icon while retaining every action", async () => {
    const page = await requireBrowser().openPage()
    for (const width of [768, 1023]) {
      await page.setViewport(width, 900)
      await page.navigate(url("/not-a-route"))
      const notFound = await page.evaluate<{
        readonly height: number
        readonly iconRight: number
        readonly headingLeft: number
        readonly descriptionLeft: number
        readonly links: number
        readonly actionHeights: readonly number[]
        readonly overflowing: boolean
      }>(`(() => {
        const card = document.querySelector('.not-found__card')
        const icon = card?.querySelector('.not-found__icon')
        const heading = card?.querySelector('h1')
        const description = card?.querySelector('.prose')
        if (!(card instanceof HTMLElement) || !(icon instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(description instanceof HTMLElement)) throw new Error('Not-found panel missing')
        return {
          height: card.getBoundingClientRect().height,
          iconRight: icon.getBoundingClientRect().right,
          headingLeft: heading.getBoundingClientRect().left,
          descriptionLeft: description.getBoundingClientRect().left,
          links: card.querySelectorAll('a').length,
          actionHeights: [...card.querySelectorAll('a')].map(link => link.getBoundingClientRect().height),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(notFound.height).toBeLessThanOrEqual(280)
      expect(notFound.headingLeft - notFound.iconRight).toBeGreaterThanOrEqual(12)
      expect(notFound.descriptionLeft - notFound.iconRight).toBeGreaterThanOrEqual(12)
      expect(notFound.links).toBe(3)
      expect(Math.min(...notFound.actionHeights)).toBeGreaterThanOrEqual(44)
      expect(notFound.overflowing).toBe(false)

      await page.navigate(url("/offline.html"))
      const offline = await page.evaluate<{
        readonly height: number
        readonly iconRight: number
        readonly headingLeft: number
        readonly descriptionTop: number
        readonly noteCount: number
        readonly retryHeight: number
        readonly retryTop: number
        readonly overflowing: boolean
      }>(`(() => {
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
      })()`)
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

  test("uses P10 group widths, P13 stacked cards, and P14 framed left-aligned status content", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/docs"))
    expect(await page.evaluate<readonly number[]>(`[...document.querySelectorAll(".docs--index .doc-section .card-grid")].map(grid => getComputedStyle(grid).gridTemplateColumns.split(" ").length)`)).toEqual([2, 2, 3, 1])
    await page.navigate(url("/changelog"))
    expect(await page.evaluate<{ readonly columns: number; readonly before: string }>(`(() => { const release = document.querySelector(".releases--timeline .release"); if (!(release instanceof HTMLElement)) throw new Error("release missing"); return { columns: getComputedStyle(release).gridTemplateColumns.split(" ").length, before: getComputedStyle(release, "::before").content } })()`)).toEqual({ columns: 1, before: "none" })
    await page.navigate(url("/not-a-route"))
    expect(await page.evaluate<{ readonly border: number; readonly justifyItems: string; readonly actions: string }>(`(() => { const card = document.querySelector(".not-found__card"); if (!(card instanceof HTMLElement)) throw new Error("not-found card missing"); const actions = card.querySelector(".not-found__actions"); return { border: Number.parseFloat(getComputedStyle(card).borderTopWidth), justifyItems: getComputedStyle(card).justifyItems, actions: actions instanceof HTMLElement ? getComputedStyle(actions).justifyContent : "" } })()`)).toEqual({ border: 1, justifyItems: "start", actions: "start" })
    await page.close()
  })

  test("renders P13 release status from the live changelog contract", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/changelog"))
    const releases = await page.evaluate<readonly { readonly version: string; readonly date: string; readonly tags: readonly string[] }[]>(`[...document.querySelectorAll(".releases--timeline .release")].map(release => ({ version: release.querySelector(".release__version")?.textContent?.trim() ?? "", date: release.querySelector(".release__date")?.textContent?.trim() ?? "", tags: [...release.querySelectorAll(".release__tags .tag")].map(tag => tag.textContent?.trim() ?? "") }))`)
    expect(releases).toEqual(RELEASES.map((release) => ({ version: `v${release.version}`, date: release.date, tags: release.tags })))
    expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll(".releases--timeline .tag")].map(tag => tag.textContent?.trim() ?? "").filter(tag => tag === "Latest" || tag === "Current")`)).toEqual([])
    await page.close()
  })

  test("keeps P09 and P14 touch controls visible without mobile overflow", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/"))
    const landing = await page.evaluate<{ readonly overflow: boolean; readonly copy: number }>(`({ overflow: document.documentElement.scrollWidth > innerWidth, copy: document.querySelector(".hero .code-block__copy")?.getBoundingClientRect().width ?? 0 })`)
    expect(landing.overflow).toBe(false)
    expect(landing.copy).toBeGreaterThan(0)
    await page.navigate(url("/not-a-route"))
    const actions = await page.evaluate<readonly { readonly width: number; readonly parent: number }[]>(`[...document.querySelectorAll(".not-found__actions .button")].map(button => { const box = button.getBoundingClientRect(); return { width: box.width, parent: button.parentElement?.getBoundingClientRect().width ?? 0 } })`)
    expect(actions).toHaveLength(2)
    expect(actions.every((action) => Math.abs(action.width - action.parent) < 1)).toBe(true)
    await page.close()
  })

  test("keeps P10 compact at mobile while retaining its tablet and desktop group grids", async () => {
    const page = await requireBrowser().openPage()
    const index = async (width: number) => {
      await page.setViewport(width, 900)
      await page.navigate(url("/docs"))
      return page.evaluate<{ readonly navGettingStarted: string | undefined; readonly navUsage: string | undefined; readonly navUsageVisible: boolean; readonly indexGettingStarted: string | undefined; readonly indexUsage: string | undefined; readonly configuration: { readonly tracks: number; readonly summaries: number; readonly targetHeights: readonly number[]; readonly hrefs: readonly string[] }; readonly gettingStarted: { readonly borderedCards: number; readonly targetHeights: readonly number[]; readonly hrefs: readonly string[] } }>(`(() => {
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
        return { navGettingStarted: navTitles.find(element => element.textContent?.trim() === "Getting started")?.textContent?.trim(), navUsage: navUsage?.textContent?.trim(), navUsageVisible: navUsage instanceof HTMLElement && getComputedStyle(navUsage).display !== "none", indexGettingStarted: [...document.querySelectorAll(".docs-topic-index h2")].map(element => element.textContent?.trim()).find(text => text === "Getting started"), indexUsage: [...document.querySelectorAll(".docs-topic-index h2")].map(element => element.textContent?.trim()).find(text => text === "Usage"), configuration: measure(group("configuration")), gettingStarted: { borderedCards: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card")].filter(card => getComputedStyle(card).borderTopWidth !== "0px").length : 0, targetHeights: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card__link")].map(link => link.getBoundingClientRect().height) : [], hrefs: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card__link")].map(link => link.getAttribute("href") ?? "") : [] } }
      })()`)
    }
    const mobile = await index(390)
    expect(mobile.navUsage).toBe("Usage")
    expect(mobile.indexUsage).toBe("Usage")
    expect(mobile.configuration.tracks).toBe(2)
    expect(mobile.configuration.summaries).toBe(0)
    expect(mobile.configuration.hrefs).toContain("/docs/configuration")
    expect(mobile.configuration.targetHeights.length).toBeGreaterThan(0)
    expect(mobile.configuration.targetHeights.every((height) => height >= 44)).toBe(true)
    expect(mobile.gettingStarted.borderedCards).toBe(0)
    expect(mobile.gettingStarted.hrefs).toContain("/docs/quickstart")
    expect(mobile.gettingStarted.targetHeights.length).toBeGreaterThan(0)
    expect(mobile.gettingStarted.targetHeights.every((height) => height >= 44)).toBe(true)
    expect((await index(768)).configuration.tracks).toBe(3)
    const desktop = await index(1440)
    expect(desktop.navGettingStarted).toBe("Getting started")
    expect(desktop.navUsage).toBe("Usage")
    expect(desktop.navUsageVisible).toBe(true)
    expect(desktop.indexGettingStarted).toBe("Getting started")
    expect(desktop.configuration.tracks).toBe(3)
    await page.close()
  })

  test("announces the current public route and documentation page in navigation", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(url("/docs/quickstart"))
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('.nav .nav__link--active, .docs-shell__nav .docs-nav__link--active')].map(link => link.getAttribute('aria-current') ?? '')`)).toEqual(["page", "page"])

      await page.setViewport(390, 900)
      await page.navigate(url("/changelog"))
      await page.evaluate(`document.querySelector('.app-header__menu')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('.primary-nav__routes .docs-nav__link--active')?.getAttribute('aria-current') ?? ''`)).toBe("page")
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
      expect(await page.evaluate<boolean>(`document.querySelector('.overlay--docs-search')?.hasAttribute('open') === true`)).toBe(true)
      for (let step = 0; step < 6; step += 1) {
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('.overlay--docs-search')?.contains(document.activeElement) === true`)).toBe(true)
      }
    } finally {
      await page.close()
    }
  }, 30_000)

  test("uses P12 state-specific navigation surfaces and approved public heading scales", async () => {
    const page = await requireBrowser().openPage()
    const heading = async (path: string, width: number, selector = "h1") => {
      await page.setViewport(width, 900)
      await page.navigate(url(path))
      return page.evaluate<{ readonly size: number; readonly line: number }>(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error("heading missing"); const style = getComputedStyle(element); return { size: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight) } })()`)
    }
    await page.setViewport(768, 900)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`document.querySelector(".docs-bar__nav-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    await page.evaluate<void>(`new Promise(resolve => setTimeout(resolve, 250))`)
    const drawer = await page.evaluate<{ readonly width: number; readonly left: number; readonly top: number; readonly height: number; readonly headerHeight: number; readonly close: number }>(`(() => { const dialog = document.querySelector(".overlay--docs-nav"); const surface = dialog?.querySelector(".overlay__surface"); const close = dialog?.querySelector(".overlay__close"); const header = document.querySelector(".app-header"); if (!(surface instanceof HTMLElement) || !(close instanceof HTMLElement) || !(header instanceof HTMLElement)) throw new Error("docs drawer missing"); const box = surface.getBoundingClientRect(); return { width: box.width, left: box.left, top: box.top, height: box.height, headerHeight: header.getBoundingClientRect().height, close: close.getBoundingClientRect().height } })()`)
    expect(drawer).toEqual({ width: 320, left: 0, top: drawer.headerHeight, height: 900 - drawer.headerHeight, headerHeight: drawer.headerHeight, close: 44 })
    await page.setViewport(1440, 900)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`document.querySelector(".docs-search-trigger")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    expect(await page.evaluate<number>(`Number.parseFloat(getComputedStyle(document.querySelector(".overlay--docs-search .overlay__surface")).inlineSize)`)).toBe(620)
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`document.querySelector(".app-header__menu")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    const primary = await page.evaluate<{ readonly width: number; readonly height: number; readonly brand: boolean; readonly routeBoxes: number; readonly activeRoute: string | undefined; readonly actionOrder: readonly string[]; readonly targets: readonly number[] }>(`(() => { const dialog = document.querySelector(".overlay--primary-nav"); const surface = dialog?.querySelector(".overlay__surface"); if (!(surface instanceof HTMLElement)) throw new Error("primary navigation missing"); const box = surface.getBoundingClientRect(); const targets = [...surface.querySelectorAll("a,button")].map(target => target.getBoundingClientRect().height); return { width: box.width, height: box.height, brand: !!surface.querySelector(".primary-nav__brand"), routeBoxes: surface.querySelectorAll(".primary-nav__routes .docs-nav__link").length, activeRoute: surface.querySelector(".primary-nav__routes .docs-nav__link--active")?.textContent?.trim(), actionOrder: [...surface.querySelectorAll(".primary-nav__actions > *")].map(action => action.textContent?.trim() ?? ""), targets } })()`)
    expect(primary.width).toBe(390)
    expect(primary.height).toBe(844)
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
    expect(await heading("/docs", 1440, ".docs-article > h1")).toEqual({ size: 24, line: 32 })
    expect(await heading("/docs/quickstart", 390, ".docs-article > h1")).toEqual({ size: 22, line: 22 })
    expect(await heading("/docs/quickstart", 768, ".docs-article > h1")).toEqual({ size: 24, line: 30 })
    expect(await heading("/docs/quickstart", 1440, ".docs-article > h1")).toEqual({ size: 26, line: 32 })
    expect(await heading("/changelog", 390, ".docs-article > h1")).toEqual({ size: 16, line: 24 })
    expect(await heading("/changelog", 768, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/changelog", 1440, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/not-a-route", 390, ".not-found h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/not-a-route", 768, ".not-found h1")).toEqual({ size: 18, line: 27 })
    expect(await heading("/not-a-route", 1440, ".not-found h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/offline.html", 390, ".offline-card h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/offline.html", 768, ".offline-card h1")).toEqual({ size: 18, line: 27 })
    expect(await heading("/offline.html", 1440, ".offline-card h1")).toEqual({ size: 20, line: 28 })
    await page.close()
  }, 10_000)

  test("keeps the P12 navigation search shortcut owned by its active dialog", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`(() => { const menu = document.querySelector(".app-header__menu"); if (!(menu instanceof HTMLButtonElement)) throw new Error("menu missing"); menu.dispatchEvent(new MouseEvent("click", { bubbles: true })); menu.focus(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })) })()`)
    const opened = await page.evaluate<{ readonly dialogs: number; readonly inputIds: readonly string[] }>(`({ dialogs: document.querySelectorAll(".overlay--docs-search[open]").length, inputIds: [...document.querySelectorAll("#docs-search-field")].map(input => input.id) })`)
    expect(opened.dialogs).toBe(1)
    expect(new Set(opened.inputIds).size).toBe(1)
    expect(opened.inputIds).toEqual(["docs-search-field"])
    await page.evaluate<void>(`(() => { const input = document.querySelector(".overlay--docs-search #docs-search-field"); if (!(input instanceof HTMLInputElement)) throw new Error("search input missing"); input.value = "quickstart"; input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "quickstart" })) })()`)
    await page.pressEscape()
    await page.evaluate<void>(`new Promise(resolve => setTimeout(resolve, 50))`)
    expect(await page.evaluate<number>(`document.querySelectorAll(".overlay--primary-nav[open]").length`)).toBe(1)
    expect(await page.evaluate<number>(`document.querySelectorAll(".overlay--docs-search[open]").length`)).toBe(0)
    expect(await page.evaluate<{ readonly tag: string; readonly className: string }>(`({ tag: document.activeElement?.tagName ?? "", className: document.activeElement instanceof HTMLElement ? document.activeElement.className : "" })`)).toEqual({ tag: "BUTTON", className: "docs-search-trigger" })
    await page.evaluate<void>(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`)
    await page.evaluate<void>(`document.querySelector(".overlay--docs-search .search__result")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    await page.evaluate<void>(`new Promise(resolve => setTimeout(resolve, 50))`)
    expect(await page.evaluate<{ readonly path: string; readonly dialogs: number }>(`({ path: location.pathname, dialogs: document.querySelectorAll("dialog[open]").length })`)).toEqual({ path: "/docs/quickstart", dialogs: 0 })
    await page.close()
  }, 10_000)
})

function requireBrowser() {
  if (!browser) throw new Error("Browser was not initialized")
  return browser
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
