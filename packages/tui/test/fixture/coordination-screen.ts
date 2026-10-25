import type { useData } from "../../src/context/data"
import { useRoute } from "../../src/context/route"
import { backend, docsID, leadID, type FixtureProject, type FixtureSession } from "./coordination-backend"
import { json, sessionSnapshot } from "./tui-client"
import { renderScreen } from "../screen/harness"

export async function mountCoordination(
  input: {
    width?: number
    height?: number
    backend?: Parameters<typeof backend>[0]
    leadMessages?: readonly unknown[]
    respond?: (url: URL, request: Request) => Response | undefined
  } = {},
) {
  const width = input.width ?? 120
  const server = backend(input.backend)
  let router!: ReturnType<typeof useRoute>
  let data!: ReturnType<typeof useData>
  const requests: string[] = []
  const route = async (url: URL, request: Request) => {
    requests.push(`${request.method} ${url.pathname}`)
    const answer = input.respond?.(url, request)
    if (answer) return answer
    if (/^\/api\/session\/[^/]+\/todo$/.test(url.pathname)) return json({ data: [] })
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? server.state.sessions[leadID]!.directory
      return json({ directory, project: { id: "proj_test", directory } })
    }
    const match = /^\/api\/session\/([^/]+)(\/snapshot)?$/.exec(url.pathname)
    if (request.method === "GET" && match && server.state.sessions[match[1]!]) {
      const source = server.state.sessions[match[1]!]!
      const session = {
        id: match[1]!,
        title: source.title,
        location: { directory: source.directory },
        projectID: "proj_test",
        agent: "build",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      }
      const messages = [
        {
          id: "msg_instruction",
          type: "user",
          text: "Draft the release notes and report the result.",
          files: [],
          agents: [],
          time: { created: 10, consumed: 11 },
        },
        ...(session.id === leadID ? (input.leadMessages ?? []) : []),
      ]
      return match[2] ? sessionSnapshot(session.id, messages, { session }) : json({ data: session })
    }
    return server.route(url, request)
  }
  const screen = await renderScreen({
    width,
    height: input.height ?? (width < 100 ? 24 : 40),
    args: { sessionID: leadID },
    route,
    config: { animations: false },
    data: (value) => {
      router = useRoute()
      data = value
    },
    settle: (screen) => {
      const frame = screen.captureCharFrame()
      return frame.includes("Draft the release")
    },
    sessionReady: true,
    kittyKeyboard: true,
  })
  return { screen, server, requests, router: () => router, data: () => data }
}

export async function waitForFrame(screen: Awaited<ReturnType<typeof mountCoordination>>["screen"], text: string) {
  for (let i = 0; i < 250; i++) {
    await screen.renderOnce()
    if (screen.frame().includes(text) && !screen.frame().includes("Loading session…")) return
    await Bun.sleep(10)
  }
  throw new Error(`Missing ${text}:\n${screen.frame()}`)
}

export async function openProjectsTab(screen: Awaited<ReturnType<typeof mountCoordination>>["screen"], roster: string) {
  await waitForFrame(screen, "⌃x p")
  screen.input.pressKey("x", { ctrl: true })
  screen.input.pressKey("p")
  await waitForFrame(screen, roster)
}

export type { FixtureProject, FixtureSession }
export { docsID, leadID }
