import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { createServer } from "vite"
import { SessionID } from "../../../packages/schema/src/session-id"
import { SwarmBoard, type SwarmBoardView } from "../src/remote/ui/swarm-board"
import { launchBrowser } from "./cdp"

const view: SwarmBoardView = {
  participants: [
    { id: "ses_master", role: "master", title: "Main", state: "supervising", agent: "main", model: "provider/model" },
    { id: "ses_supervisor", parentID: "ses_master", role: "supervisor", title: "Lead", state: "running" },
    { id: "ses_member", parentID: "ses_supervisor", role: "member", title: "Builder", state: "waiting" },
    { id: "ses_child", parentID: "ses_member", role: "subagent", title: "Tester", state: "running", agent: "tester" },
    { id: "ses_unowned", role: "member", title: "Independent member", state: "idle" },
  ],
  tasks: [
    { id: "msg_one", title: "Build", sessionID: "ses_child", ownerID: "ses_member", dependencies: [], state: "running" },
    { id: "msg_two", title: "Review", sessionID: "ses_supervisor", ownerID: "ses_supervisor", dependencies: ["msg_one"], state: "blocked", result: { messageID: "msg_result", summary: "Awaiting checks" } },
  ],
  handoffs: [{ sessionID: "ses_member", fromID: "ses_supervisor", toID: "ses_child", time: "10:30" }],
  reviews: [
    { sessionID: "ses_member", request: { kind: "permission", requestID: "per_1", fingerprint: "fp", summary: "Allow read", requestSessionID: SessionID.make("ses_child") } },
    { sessionID: "ses_supervisor", request: { kind: "review", requestID: "rvw_1", fingerprint: "fp2", summary: "Check output" } },
  ],
}

test("board renders hierarchy, explicit owners, dependencies, handoffs and results", () => {
  const html = renderToString(() => createComponent(SwarmBoard, { view: () => view, onOpenSession: () => {} }))
  for (const text of ["Master · main agent", "supervisor", "member", "subagent", "Independent member", "Owner: Builder · Session ses_member", "Task Session: Tester · ses_child", "Dependencies: Independent", "Dependencies: Build", "Awaiting checks", "msg_result", "From: Lead · To: Tester", "10:30", "Request Session unreported."]) expect(html).toContain(text)
  expect(html.indexOf('data-session-id="ses_master"')).toBeLessThan(html.indexOf('data-session-id="ses_supervisor"'))
  expect(html.indexOf('data-session-id="ses_supervisor"')).toBeLessThan(html.indexOf('data-session-id="ses_member"'))
  expect(html.indexOf('data-session-id="ses_member"')).toBeLessThan(html.indexOf('data-session-id="ses_child"'))
})

test("board distinguishes empty collections and unknown dependencies", () => {
  const empty = renderToString(() => createComponent(SwarmBoard, { view: () => ({ participants: [], tasks: [], handoffs: [], reviews: [] }), onOpenSession: () => {} }))
  for (const text of ["No participants reported.", "No tasks reported.", "No handoffs reported.", "No pending reviews."]) expect(empty).toContain(text)
  const unknown = renderToString(() => createComponent(SwarmBoard, { view: () => ({ ...view, tasks: [{ ...view.tasks[0]!, dependencies: ["msg_missing"] }] }), onOpenSession: () => {} }))
  expect(unknown).toContain("Dependencies: msg_missing")
})

test("board keeps review target, keyboard controls and narrow layout in the browser", async () => {
  const executable = process.env.YCODING_WEB_CHROME
  if (!executable) throw new Error("YCODING_WEB_CHROME must name the daemon-selected pinned Chrome")
  const fixture = `import { render } from 'solid-js/web'; import { createComponent } from 'solid-js'; import { SwarmBoard } from '/src/remote/ui/swarm-board.tsx'; import '/src/styles/tokens.css'; import '/src/styles/base.css'; const view = ${JSON.stringify(view)}; render(() => createComponent(SwarmBoard, { view: () => view, onOpenSession: (id) => { document.body.dataset.opened = id } }), document.getElementById('app'));`
  const server = await createServer({ root: new URL("..", import.meta.url).pathname, configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "swarm-fixture", resolveId: (id) => id === "/swarm-fixture.js" ? "\0swarm-fixture.js" : undefined, load: (id) => id === "\0swarm-fixture.js" ? fixture : undefined, configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/swarm-fixture") return next(); res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="app"></main><script type="module" src="/swarm-fixture.js"></script></body></html>') }) } }, (await import("vite-plugin-solid")).default()] })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string") throw new Error("Fixture server did not start")
  const browser = await launchBrowser(executable, 320, 700)
  try {
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${address.port}/swarm-fixture`)
      for (let index = 0; index < 80 && !await page.evaluate(`!!document.querySelector('.swarm-board')`); index++) await Bun.sleep(50)
      expect(await page.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      expect(await page.evaluate(`document.querySelector('[data-session-id="ses_master"] > ul > [data-session-id="ses_unowned"]') !== null`)).toBe(true)
      await page.evaluate(`document.querySelector('[aria-label="Reviews"] button').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      expect(await page.evaluate(`document.body.dataset.opened`)).toBe("ses_child")
      expect(await page.evaluate(`document.querySelectorAll('[aria-label="Reviews"] button').length`)).toBe(1)
    } finally { await page.close() }
  } finally { await browser.close(); await server.close() }
}, 30_000)
