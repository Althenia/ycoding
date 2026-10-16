import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const preview = process.env.YCODING_SAFARI_PREVIEW
const driver = process.env.YCODING_SAFARI_DRIVER
if (!preview || !driver) throw new Error("Set YCODING_SAFARI_PREVIEW and YCODING_SAFARI_DRIVER to local origins")

let sessionID: string | undefined

beforeAll(async () => {
  const created = await command("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } })
  if (!isRecord(created) || typeof created.sessionId !== "string")
    throw new Error("Safari WebDriver did not create a session")
  sessionID = created.sessionId
  await command("POST", `/session/${sessionID}/timeouts`, { implicit: 5_000 })
})

afterAll(async () => {
  if (sessionID) await command("DELETE", `/session/${sessionID}`)
})

describe("built public pages in Safari", () => {
  test("fit the viewport at mobile, tablet, and desktop widths", async () => {
    if (!sessionID) throw new Error("Safari WebDriver session is unavailable")
    const sitemapResponse = await fetch(`${preview}/sitemap.xml`)
    expect(sitemapResponse.status).toBe(200)
    const routes = [...(await sitemapResponse.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => new URL(match[1] ?? "").pathname,
    )
    expect(routes).toContain("/")
    expect(routes).toContain("/docs")
    expect(routes).toContain("/changelog")
    for (const theme of ["light", "dark"]) {
      await navigate("/")
      await command("POST", `/session/${sessionID}/execute/sync`, {
        script: "localStorage.setItem('ycoding.theme', arguments[0])",
        args: [theme],
      })
      for (const width of [320, 390, 768, 1024, 1440]) {
        await command("POST", `/session/${sessionID}/window/rect`, { width, height: 844 })
        for (const route of [...routes, "/remote"]) {
          await navigate(route)
          const view = await command("POST", `/session/${sessionID}/execute/async`, {
            script: `const done = arguments[arguments.length - 1];
            const animations = document.getAnimations()
              .filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
            const settled = Promise.all([document.fonts.ready, ...animations.map(animation => animation.finished.catch(() => {}))])
              .then(() => ({ path: location.pathname, width: innerWidth, scroll: document.documentElement.scrollWidth,
                theme: document.documentElement.dataset.theme,
                main: !!document.querySelector("main"), entry: document.querySelector("script[type=module]")?.getAttribute("src") }));
            let timer;
            const stalled = new Promise(resolve => {
              timer = setTimeout(() => resolve({
                stalled: true,
                route: location.pathname,
                width: innerWidth,
                theme: document.documentElement.dataset.theme,
                visibilityState: document.visibilityState,
                readyState: document.readyState,
                fontsStatus: document.fonts.status,
                animations: animations.map(animation => {
                  const timing = animation.effect?.getComputedTiming();
                  const target = animation.effect?.target;
                  return {
                    id: animation.id,
                    animationName: animation.animationName ?? null,
                    playState: animation.playState,
                    currentTime: animation.currentTime,
                    effectTiming: {
                      duration: timing?.duration ?? null,
                      iterations: timing?.iterations ?? null,
                      delay: timing?.delay ?? null,
                      endTime: timing?.endTime ?? null,
                    },
                    targetSelector: target instanceof Element
                      ? target.id ? "#" + CSS.escape(target.id)
                        : target.tagName.toLowerCase() + Array.from(target.classList, name => "." + CSS.escape(name)).join("")
                      : null,
                  };
                }),
              }), 20_000);
            });
            Promise.race([settled, stalled]).then(view => {
              clearTimeout(timer);
              done(view);
            });`,
            args: [],
          })
          if (isRecord(view) && view.stalled === true) throw new Error(`Safari layout stalled: ${JSON.stringify(view)}`)
          if (!isRecord(view) || typeof view.width !== "number" || typeof view.scroll !== "number")
            throw new Error(`Safari returned no layout for ${route} at ${width}px`)
          expect(view.path, `${route} at ${width}px measures the requested document`).toBe(route)
          expect(view.theme, `${route} at ${width}px resolves ${theme}`).toBe(theme)
          expect(view.main, `${route} at ${width}px has a main landmark`).toBe(true)
          expect(
            typeof view.entry === "string" && view.entry.startsWith("/assets/index-"),
            `${route} at ${width}px loaded the built entry`,
          ).toBe(true)
          expect(view.scroll, `${route} at ${width}px overflows a ${view.width}px viewport`).toBeLessThanOrEqual(
            view.width,
          )
        }
      }
    }
  }, 120_000)

  test("navigates the landing actions", async () => {
    if (!sessionID) throw new Error("Safari WebDriver session is unavailable")
    await command("POST", `/session/${sessionID}/window/rect`, { width: 390, height: 844 })
    for (const [selector, destination] of [
      [".hero__actions .button--primary", "/docs/getting-started"],
      [".hero__actions .button--secondary", "/remote"],
    ] as const) {
      await navigate("/")
      const element = await command("POST", `/session/${sessionID}/element`, { using: "css selector", value: selector })
      const id = isRecord(element) ? element["element-6066-11e4-a52e-4f735466cecf"] : undefined
      if (typeof id !== "string") throw new Error(`Safari could not find ${selector}`)
      await command("POST", `/session/${sessionID}/element/${id}/click`, {})
      await waitForPage(destination)
      const path = await command("POST", `/session/${sessionID}/execute/sync`, {
        script: "return location.pathname",
        args: [],
      })
      expect(path).toBe(destination)
    }
  })
})

async function navigate(path: string) {
  const previousDocument = await command("POST", `/session/${sessionID}/execute/sync`, {
    script: "return performance.timeOrigin",
    args: [],
  })
  if (typeof previousDocument !== "number") throw new Error("Safari returned no document identity")
  await command("POST", `/session/${sessionID}/url`, { url: `${preview}${path}` })
  await waitForPage(path, previousDocument)
}

async function waitForPage(path: string, previousDocument?: number) {
  const deadline = Date.now() + 5_000
  do {
    const ready = await command("POST", `/session/${sessionID}/execute/sync`, {
      script: `return location.pathname === arguments[0] && document.readyState === 'complete'
        && !!document.querySelector('main') && performance.timeOrigin !== arguments[1]`,
      args: [path, previousDocument ?? null],
    })
    if (ready === true) return
  } while (Date.now() < deadline)
  throw new Error(`Safari did not finish loading ${path} into the requested document`)
}

async function command(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${driver}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  const result: unknown = await response.json()
  if (!response.ok || !isRecord(result) || !("value" in result))
    throw new Error(`Safari WebDriver ${method} ${path} failed (${response.status})`)
  if (isRecord(result.value) && typeof result.value.error === "string")
    throw new Error(
      `Safari WebDriver ${result.value.error}: ${typeof result.value.message === "string" ? result.value.message.slice(0, 160) : ""}`,
    )
  return result.value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
