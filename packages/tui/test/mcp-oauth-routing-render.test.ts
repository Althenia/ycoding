import { expect, test } from "bun:test"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const directory = "/tmp/ycoding/mcp-oauth-routing"
const location = { directory, project: { id: "proj_mcp_oauth", directory } }
const integration = {
  id: "private-mcp",
  name: "Private MCP",
  methods: [{ id: "oauth", type: "oauth", label: "Authorize Private MCP" }],
  connections: [],
}

test.each(["enter", "space"])(
  "%s opens the registered MCP OAuth method rather than reconnecting",
  async (key) => {
    const oauth: unknown[] = []
    const reconnect: unknown[] = []
    const screen = await renderScreen({
      width: 100,
      height: 35,
      settle: "What should we build?",
      route: async (url, request) => {
        if (url.pathname === "/api/location") return json(location)
        if (url.pathname === "/api/mcp")
          return json({
            location,
            data: [{ name: "private-server", integrationID: integration.id, status: { status: "needs_auth" } }],
          })
        if (url.pathname === "/api/integration") return json({ location, data: [integration] })
        if (url.pathname === "/api/integration/private-mcp/connect/oauth" && request.method === "POST") {
          oauth.push(await request.json())
          return json({ message: "authorization unavailable in this test" }, { status: 400 })
        }
        if (url.pathname === "/api/mcp/private-server/connect" && request.method === "POST") {
          reconnect.push(url.search)
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    try {
      const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
      await screen.mouse.click(3, promptRow)
      await screen.input.typeText("/mcps")
      screen.input.pressEnter()
      const deadline = Date.now() + 10_000
      while (!screen.frame().includes("enter or space to authorize in browser") && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect(screen.frame()).toContain("enter or space to authorize in browser")
      if (key === "enter") screen.input.pressEnter()
      if (key === "space") screen.input.pressKey(" ")
      while (oauth.length === 0 && reconnect.length === 0 && Date.now() < deadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
      expect(reconnect).toEqual([])
      expect(oauth).toEqual([expect.objectContaining({ methodID: "oauth", inputs: {} })])
      while (screen.frame().includes("Starting authorization") && Date.now() < deadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      await screen.dispose()
    }
  },
  30_000,
)
