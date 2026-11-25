import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { launchBrowser } from "../../../apps/web/verify/cdp"
import { createDesktopRPC } from "../src/rpc"
import { syntheticDesktop } from "./synthetic-desktop"

const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME to the repository-provisioned Chrome for Testing executable.")

const captureDir = process.env.YCODING_INTELLIGENT_UI_CAPTURE_DIR
const captureMode = process.env.YCODING_INTELLIGENT_UI_CAPTURE_MODE

const fixtureFallback = [
  "Desktop release readiness",
  "- Tests passing: 142 / 142 (positive)",
  "- Bundle size: 418 KiB (default)",
  "- Open warnings: 2 (warning)",
  "Note: Renderer CSP blocks embedded frames; fallback text remains available in plain transcripts.",
  "Checks:",
  "| Check | Status | Duration |",
  "| Schema contract | Passing | 133ms |",
  "| Design tokens | Passing | 20ms |",
  "| Typecheck | Passing | 748ms |",
].join("\n")

const fixtureSpec = {
  version: 1,
  title: "Desktop release readiness",
  summary: "Core build and renderer checks for the current candidate.",
  reservedHeight: 480,
  fallback: fixtureFallback,
  blocks: [
    {
      id: "kpis",
      kind: "metrics",
      items: [
        { label: "Tests passing", value: "142 / 142", detail: "All selected checks", tone: "positive" },
        { label: "Bundle size", value: "418 KiB", detail: "Within budget", tone: "default" },
        { label: "Open warnings", value: "2", detail: "Non-blocking lint notes", tone: "warning" },
      ],
    },
    {
      id: "csp-note",
      kind: "callout",
      tone: "default",
      title: "Plain fallback preserved",
      body: "Renderer CSP blocks embedded frames; fallback text remains available in plain transcripts.",
    },
    {
      id: "checks-table",
      kind: "table",
      title: "Verification summary",
      columns: [
        { key: "check", label: "Check", sortable: true },
        { key: "status", label: "Status", sortable: true },
        { key: "duration", label: "Duration", align: "right", sortable: true },
      ],
      rows: [
        { id: "row-schema", cells: { check: "Schema contract", status: "Passing", duration: 133 } },
        { id: "row-tokens", cells: { check: "Design tokens", status: "Passing", duration: 20 } },
        { id: "row-typecheck", cells: { check: "Typecheck", status: "Passing", duration: 748 } },
      ],
    },
  ],
}

let server: ViteDevServer | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let owned: Awaited<ReturnType<typeof syntheticDesktop>> | undefined
let origin = ""
let currentMessages: unknown[] = []

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const session = {
  id: "ses_test",
  projectID: "global",
  title: "Desktop Intelligent UI verification",
  location: { directory: "/synthetic/repo" },
  model: { id: "synthetic", providerID: "synthetic" },
  time: { created: 1, updated: 2 },
  tokens,
  cost: 0,
}
const model = {
  id: "synthetic",
  modelID: "synthetic",
  providerID: "synthetic",
  name: "Synthetic Model",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "low" }, { id: "high" }],
  profiles: [],
  time: { released: 1 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200000, output: 32000 },
}
const location = { directory: "/synthetic/repo", project: { id: "global", directory: "/synthetic/repo" } }

const inject = `(() => {
  const events = new Set(), states = new Set(), resyncs = new Set(), menus = new Set();
  const subscriptions = { onEvent: events, onState: states, onResync: resyncs, onMenuAction: menus };
  window.__desktopFixture = {
    errors: [],
    emit: event => events.forEach(cb => cb({ id: 'evt_' + Date.now(), created: 1, ...event })),
    resync: () => resyncs.forEach(cb => cb()),
  };
  window.addEventListener('error', e => window.__desktopFixture.errors.push(e.error?.stack ?? e.message));
  window.addEventListener('unhandledrejection', e => window.__desktopFixture.errors.push(String(e.reason?.stack ?? e.reason)));
  window.__ycodingDesktop = new Proxy({}, { get: (_, method) => {
    if (subscriptions[method]) return cb => { subscriptions[method].add(cb); return () => subscriptions[method].delete(cb); };
    return async (...args) => {
      while (args.length && args.at(-1) === undefined) args.pop();
      const response = await fetch('/__desktop/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
      const result = await response.json();
      if (result.error) throw new Error(result.error);
      return result.value;
    };
  } });
})()`

beforeAll(async () => {
  owned = await syntheticDesktop((call) => {
    if (call.route === "/api/session") return { data: [session], cursor: {} }
    if (call.route === "/api/session/ses_test") return { data: session }
    if (call.route === "/api/session/ses_test/snapshot") {
      return {
        sourceEpoch: "synthetic",
        session,
        messages: currentMessages,
        watermark: { type: "log.synced", aggregateID: "ses_test", seq: 1000 },
      }
    }
    if (call.route === "/api/session/ses_test/message") return { data: currentMessages }
    if (call.route === "/api/session/ses_test/subagent") return { data: [], summary: { total: 0, active: 0 }, cursor: {} }
    if (call.route === "/api/session/ses_test/captured-inputs") return { data: [] }
    if (call.route === "/api/session/active") return { data: {} }
    if (call.route === "/api/model") return { location, data: [model] }
    if (call.route === "/api/model/default") return { location, data: { selection: { id: "synthetic", providerID: "synthetic" } } }
    if (call.route === "/api/agent") return { location, data: [{ id: "build", name: "Build", mode: "all" }] }
    if (call.route === "/api/command") return { location, data: [] }
    if (call.route === "/api/skill") return { location, data: [] }
    if (call.route === "/api/workspace") return { data: [{ directory: "/synthetic/repo", name: "repo" }] }
    if (call.route === "/api/server/telemetry/consent") return { consent: { enabled: false, noticeVersion: 1, decidedAt: 1 }, noticeVersion: 1 }
    if (call.route === "/api/form/request") return { location, data: [] }
    if (call.route === "/api/mcp/request") return { location, data: [] }
    if (call.route === "/api/review") return { data: [] }
    if (call.route === "/api/question") return { data: [] }
    if (call.route === "/api/permission") return { data: [] }
    if (call.route === "/api/form") return { data: [] }
    if (call.route === "/api/guardrail/request") return { data: [] }
    if (call.route === "/api/session/ses_test/autonomy") return { data: { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", goal: null, defer: null, effective: { permissions: "manual", guardrails: "manual", answers: "manual", inherited: {}, deferred: false, guardrailsEnabled: true } } }
    if (call.method === "GET" && ["/permission", "/form", "/guardrail/request", "/file-change", "/active", "/pending", "/todo", "/review", "/question"].some((s) => call.route.endsWith(s))) return { data: [] }
    return undefined
  })

  const rpc = createDesktopRPC(owned.controller, { path: path.join(owned.resources, "preferences"), read: async () => ({}), save: async () => {}, validate: () => ({ mode: "shared" }) })
  server = await createServer({
    root: path.resolve(import.meta.dir, ".."),
    configFile: path.resolve(import.meta.dir, "../vite.config.ts"),
    plugins: [{
      name: "desktop-synthetic-rpc",
      configureServer(srv) {
        srv.middlewares.use("/__desktop/rpc", (req, res, next) => {
          void (async () => {
            res.setHeader("content-type", "application/json")
            try {
              let body = ""
              for await (const chunk of req) body += String(chunk)
              const input = JSON.parse(body)
              const handler = Reflect.get(rpc, input.method)
              res.end(JSON.stringify({ value: (await Reflect.apply(handler, rpc, input.args)) ?? null }))
            } catch (error) {
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            }
          })().catch(next)
        })
      },
    }],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  })
  await server.listen()
  const addr = server.httpServer?.address()
  if (!addr || typeof addr === "string") throw new Error("No port")
  origin = `http://127.0.0.1:${addr.port}`
  browser = await launchBrowser(chrome, 1280, 900)
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  await owned?.close()
})

beforeEach(() => {
  if (owned) owned.calls.length = 0
})

type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>
async function wait(page: Page, expression: string) {
  await page.evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    const check = () => {
      if (${expression}) return resolve(true);
      if (performance.now() >= deadline) return reject(new Error('Timed out waiting for: ' + ${JSON.stringify(expression)}));
      requestAnimationFrame(check);
    };
    check();
  })`)
}

async function openSession(ready: string) {
  if (!browser) throw new Error("Browser not ready")
  const page = await browser.openPage()
  await page.injectOnNewDocument(inject)
  await page.navigate(`${origin}/#/sessions/ses_test`)
  await wait(page, `document.querySelector('.rl-session-row-title') && (${ready}) && document.fonts.status === 'loaded'`)
  return page
}

test("renders valid Intelligent UI fixture card with metrics, callout, and sortable table without submitting turns", async () => {
  const response = (spec: typeof fixtureSpec) => ({
    id: "msg_response",
    type: "assistant",
    agent: "build",
    model: { id: "synthetic", providerID: "synthetic" },
    content: [
      {
        id: "part_ui_release",
        type: "tool",
        name: "ui",
        state: {
          status: "completed",
          input: spec,
          structured: { ui: spec },
          content: [{ type: "text", text: fixtureFallback }],
        },
        time: { created: 200, completed: 250 },
      },
      { type: "text", text: "Summary attached above.", time: { created: 260 } },
    ],
    time: { created: 200, completed: 270 },
  })
  currentMessages = [
    { id: "msg_user", type: "user", text: "Summarize the Desktop release readiness checks.", files: [], agents: [], time: { created: 100 } },
    response(fixtureSpec),
  ]

  const page = await openSession(`document.querySelector('#turn-msg_response')`)
  try {
    if (captureDir && captureMode === "before") {
      await page.evaluate(`document.querySelector('#turn-msg_response .transcript-tools__button')?.click()`)
      await wait(page, `!!document.querySelector('#turn-msg_response .desktop-tool-evidence')`)
      await Bun.write(path.join(captureDir, "before-plain-fallback.png"), Buffer.from(await page.screenshot(), "base64"))
    }

    await wait(page, `!!document.querySelector('#turn-msg_response [data-intelligent-ui="ready"]')`)

    if (captureDir && captureMode === "after") {
      await Bun.write(path.join(captureDir, "after-rendered-card.png"), Buffer.from(await page.screenshot(), "base64"))
    }

    const summary = await page.evaluate(`({
      metrics: [...document.querySelectorAll('[data-intelligent-ui="ready"] [data-ui-block="metrics"] [data-ui-metric]')].map(el => el.textContent?.trim()),
      callout: document.querySelector('[data-intelligent-ui="ready"] [data-ui-block="callout"]')?.textContent?.trim(),
      rowsBefore: [...document.querySelectorAll('[data-intelligent-ui="ready"] tbody tr td:first-child')].map(el => el.textContent?.trim()),
      errors: window.__desktopFixture.errors,
    })`) as { metrics: string[]; callout: string; rowsBefore: string[]; errors: string[] }

    expect(summary.errors).toEqual([])
    expect(summary.metrics).toHaveLength(3)
    expect(summary.callout).toContain("Plain fallback preserved")
    expect(summary.rowsBefore).toEqual(["Schema contract", "Design tokens", "Typecheck"])

    await page.evaluate(`(() => { const sort = document.querySelector('[data-intelligent-ui="ready"] th button[data-sort-key="duration"]'); sort.focus(); sort.click() })()`)
    const rowsAfterSort = await page.evaluate(`[...document.querySelectorAll('[data-intelligent-ui="ready"] tbody tr td:first-child')].map(el => el.textContent?.trim())`) as string[]
    expect(rowsAfterSort).toEqual(["Design tokens", "Schema contract", "Typecheck"])

    const blocks = fixtureSpec.blocks.map((block) => block.columns ? {
      ...block,
      columns: block.columns.map((column) => column.key === "duration" ? { ...column, label: "Wall time" } : column),
    } : block)
    currentMessages = [currentMessages[0], response({ ...fixtureSpec, blocks })]
    await page.evaluate(`window.__desktopFixture.resync()`)
    await wait(page, `document.querySelector('[data-intelligent-ui="ready"] [data-sort-key="duration"]')?.textContent.includes('Wall time')`)
    expect(await page.evaluate(`({
      rows: [...document.querySelectorAll('[data-intelligent-ui="ready"] tbody tr td:first-child')].map(el => el.textContent.trim()),
      focusedSort: document.activeElement?.getAttribute('data-sort-key'),
      sort: document.activeElement?.closest('th')?.getAttribute('aria-sort'),
    })`)).toEqual({ rows: rowsAfterSort, focusedSort: "duration", sort: "ascending" })

    const submissions = owned!.calls.filter((call) => call.method === "POST" && (call.route.endsWith("/prompt") || call.route.endsWith("/decide") || call.route.endsWith("/autonomy")))
    expect(submissions).toEqual([])
  } finally {
    await page.close()
  }
}, 30_000)

test("renders escaped plain fallback with no partial card on invalid spec and escapes control/bidi text", async () => {
  const badSpec = {
    ...fixtureSpec,
    fallback: "Invalid fallback\u0007\u202e safe text",
    blocks: [
      { id: "dup", kind: "callout", body: "One" },
      { id: "dup", kind: "callout", body: "Two" },
    ],
  }
  const escapedValid = {
    version: 1,
    title: "Escaped \u202eTitle",
    fallback: "Escaped fallback",
    blocks: [{ id: "c1", kind: "callout", body: "Body \u001b[31m\u2066Alert" }],
  }
  currentMessages = [
    { id: "msg_user", type: "user", text: "Check invalid and bidi handling.", files: [], agents: [], time: { created: 100 } },
    {
      id: "msg_response",
      type: "assistant",
      agent: "build",
      model: { id: "synthetic", providerID: "synthetic" },
      content: [
        {
          id: "part_invalid",
          type: "tool",
          name: "ui",
          state: { status: "completed", input: badSpec, structured: { ui: badSpec }, content: [{ type: "text", text: badSpec.fallback }] },
          time: { created: 200, completed: 210 },
        },
        {
          id: "part_escaped",
          type: "tool",
          name: "ui",
          state: { status: "completed", input: escapedValid, structured: { ui: escapedValid }, content: [{ type: "text", text: escapedValid.fallback }] },
          time: { created: 220, completed: 230 },
        },
      ],
      time: { created: 200, completed: 240 },
    },
  ]

  const page = await openSession(`document.querySelector('#turn-msg_response [data-intelligent-ui="fallback"]')`)
  try {
    const state = await page.evaluate(`({
      fallbackText: document.querySelector('[data-intelligent-ui="fallback"]')?.textContent ?? "",
      fallbackBlocks: document.querySelectorAll('[data-intelligent-ui="fallback"] [data-ui-block]').length,
      readyText: document.querySelector('[data-intelligent-ui="ready"]')?.textContent ?? "",
      errors: window.__desktopFixture.errors,
    })`) as { fallbackText: string; fallbackBlocks: number; readyText: string; errors: string[] }

    expect(state.errors).toEqual([])
    expect(state.fallbackBlocks).toBe(0)
    expect(state.fallbackText).toContain("\\u0007")
    expect(state.fallbackText).toContain("\\u202e")
    expect(state.readyText).toContain("Escaped \\u202eTitle")
    expect(state.readyText).toContain("Body \\u001b[31m\\u2066Alert")
  } finally {
    await page.close()
  }
}, 30_000)

test("reserves final height while streaming so subsequent transcript rows do not shift after resync settle", async () => {
  currentMessages = [
    { id: "msg_user", type: "user", text: "Stream readiness card.", files: [], agents: [], time: { created: 100 } },
    {
      id: "msg_response",
      type: "assistant",
      agent: "build",
      model: { id: "synthetic", providerID: "synthetic" },
      content: [
        {
          id: "part_ui_stream",
          type: "tool",
          name: "ui",
          state: { status: "streaming", input: '{"version":1,"reservedHeight":480,"title":"Desktop release' },
          time: { created: 200 },
        },
      ],
      time: { created: 200 },
    },
    { id: "msg_after", type: "user", text: "Follow-up turn anchor", files: [], agents: [], time: { created: 300 } },
  ]

  const page = await openSession(`document.querySelector('#turn-msg_response [data-intelligent-ui="streaming"]') && document.querySelector('#turn-msg_after')`)
  try {
    const before = await page.evaluate(`({
      cardHeight: document.querySelector('[data-intelligent-ui="streaming"]').getBoundingClientRect().height,
      turnHeight: document.querySelector('#turn-msg_response').getBoundingClientRect().height,
      afterOffsetTop: document.querySelector('#turn-msg_after').offsetTop,
    })`) as { cardHeight: number; turnHeight: number; afterOffsetTop: number }

    expect(before.cardHeight).toBeGreaterThanOrEqual(480)

    currentMessages = [
      currentMessages[0],
      {
        id: "msg_response",
        type: "assistant",
        agent: "build",
        model: { id: "synthetic", providerID: "synthetic" },
        content: [
          {
            id: "part_ui_stream",
            type: "tool",
            name: "ui",
            state: {
              status: "completed",
              input: fixtureSpec,
              structured: { ui: fixtureSpec },
              content: [{ type: "text", text: fixtureFallback }],
            },
            time: { created: 200, completed: 250 },
          },
        ],
        time: { created: 200, completed: 260 },
      },
      currentMessages[2],
    ]

    await page.evaluate(`window.__desktopFixture.resync()`)
    await wait(page, `!!document.querySelector('#turn-msg_response [data-intelligent-ui="ready"]')`)

    const after = await page.evaluate(`({
      cardHeight: document.querySelector('[data-intelligent-ui="ready"]').getBoundingClientRect().height,
      turnHeight: document.querySelector('#turn-msg_response').getBoundingClientRect().height,
      afterOffsetTop: document.querySelector('#turn-msg_after').offsetTop,
      errors: window.__desktopFixture.errors,
    })`) as { cardHeight: number; turnHeight: number; afterOffsetTop: number; errors: string[] }

    expect(after.errors).toEqual([])
    expect(after.cardHeight).toBeGreaterThanOrEqual(480)
    expect(Math.abs(after.cardHeight - before.cardHeight)).toBeLessThanOrEqual(4)
    expect(Math.abs(after.afterOffsetTop - before.afterOffsetTop)).toBeLessThanOrEqual(4)
  } finally {
    await page.close()
  }
}, 30_000)

test("preserves 1440x900 normal and 1000x600 minimum layout, keyboard sort focus, theme tokens, and reduced motion", async () => {
  const wideTableSpec = {
    ...fixtureSpec,
    blocks: [
      fixtureSpec.blocks[0]!,
      fixtureSpec.blocks[1]!,
      {
        id: "wide-table",
        kind: "table",
        title: "Wide comparison matrix",
        columns: [
          { key: "check", label: "Check", sortable: true },
          { key: "owner", label: "Owner", sortable: true },
          { key: "status", label: "Status", sortable: true },
          { key: "budget", label: "Budget", align: "right", sortable: true },
          { key: "duration", label: "Duration", align: "right", sortable: true },
          { key: "notes", label: "Verification notes" },
        ],
        rows: [
          { id: "r1", cells: { check: "Schema contract", owner: "packages/schema", status: "Passing", budget: "14.0 KiB", duration: 133, notes: "Validates 16 KiB spec limit and 16,384-byte host forwarding resync budget" } },
          { id: "r2", cells: { check: "Design tokens", owner: "packages/desktop", status: "Passing", budget: "0 raw colors", duration: 20, notes: "Uses Field Notes light and dark semantic roles exclusively" } },
          { id: "r3", cells: { check: "Typecheck", owner: "workspace", status: "Passing", budget: "0 errors", duration: 748, notes: "Covers schema and desktop renderer sources without errors" } },
        ],
      },
    ],
  }

  currentMessages = [
    { id: "msg_user", type: "user", text: "Verify layout, focus, palette, and motion.", files: [], agents: [], time: { created: 100 } },
    {
      id: "msg_response",
      type: "assistant",
      agent: "build",
      model: { id: "synthetic", providerID: "synthetic" },
      content: [
        {
          id: "part_ui_wide",
          type: "tool",
          name: "ui",
          state: {
            status: "completed",
            input: wideTableSpec,
            structured: { ui: wideTableSpec },
            content: [{ type: "text", text: fixtureFallback }],
          },
          time: { created: 200, completed: 250 },
        },
        {
          id: "part_ui_loading",
          type: "tool",
          name: "ui",
          state: { status: "streaming", input: '{"version":1,"reservedHeight":220' },
          time: { created: 260 },
        },
      ],
      time: { created: 200 },
    },
  ]

  const page = await openSession(`document.querySelector('#turn-msg_response [data-intelligent-ui="ready"]') && document.querySelector('#turn-msg_response [data-intelligent-ui="streaming"]')`)
  try {
    for (const [width, height] of [[1440, 900], [1000, 600]] as const) {
      await page.setViewport(width, height)
      await new Promise((r) => setTimeout(r, 100))
      const layout = await page.evaluate(`({
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        scrollOverflow: (document.querySelector('.conversation__scroll')?.scrollWidth ?? 0) > (document.querySelector('.conversation__scroll')?.clientWidth ?? 0),
        cardWidth: document.querySelector('[data-intelligent-ui="ready"]').getBoundingClientRect().width,
        composerWidth: document.querySelector('.composer form')?.getBoundingClientRect().width ?? 0,
      })`) as { docOverflow: boolean; scrollOverflow: boolean; cardWidth: number; composerWidth: number }

      expect(layout.docOverflow).toBe(false)
      expect(layout.scrollOverflow).toBe(false)
      expect(layout.cardWidth).toBeGreaterThan(200)
    }

    await page.evaluate(`document.querySelector('[data-intelligent-ui="ready"] th button[data-sort-key="duration"]').focus()`)
    const focusedBefore = await page.evaluate(`document.activeElement?.getAttribute('data-sort-key')`) as string
    expect(focusedBefore).toBe("duration")
    await page.pressKey("Enter", "Enter", 13, "\r")
    const ariaSortAfter = await page.evaluate(`document.querySelector('[data-intelligent-ui="ready"] th button[data-sort-key="duration"]').closest('th')?.getAttribute('aria-sort')`) as string
    expect(ariaSortAfter).toBe("ascending")

    const darkBg = await page.evaluate(`getComputedStyle(document.querySelector('[data-intelligent-ui="ready"]')).backgroundColor`) as string
    await page.evaluate(`document.documentElement.dataset.theme = 'light'`)
    const lightBg = await page.evaluate(`getComputedStyle(document.querySelector('[data-intelligent-ui="ready"]')).backgroundColor`) as string
    expect(darkBg).not.toBe(lightBg)

    await page.setReducedMotion(true)
    const reducedAnimation = await page.evaluate(`getComputedStyle(document.querySelector('[data-intelligent-ui="streaming"] .iui-skeleton__tile')).animationName`) as string
    expect(reducedAnimation).toBe("none")
  } finally {
    await page.close()
  }
}, 30_000)
