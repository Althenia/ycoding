import { expect, test } from "bun:test"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_message_actions"
const messageID = "msg_message_actions"
const text = "Synthetic message action target"

for (const state of ["queued", "steered", "unread", "read", "peer"] as const) {
  test(`message actions respect ${state} ownership and consumption`, async () => {
    const writes: string[] = []
    const metadata = { inputOrigin: state === "peer" ? "plugin" : "direct" }
    const pending = state === "queued" || state === "steered"
      ? [{ id: messageID, sessionID, type: "user", delivery: state === "queued" ? "queue" : "steer", admittedSeq: 1, timeCreated: 1, data: { text, metadata } }]
      : []
    const message = { id: messageID, type: "user", text, metadata, time: { created: 1, ...(state === "read" ? { consumed: 2 } : {}) } }
    const screen = await renderScreen({
      width: 100,
      height: 30,
      args: { sessionID },
      sessionReady: true,
      settle: text,
      config: { animations: false },
      route: (url, request) => {
        if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [message])
        if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: pending })
        if (request.method === "DELETE" || url.pathname.endsWith("/steer")) {
          writes.push(`${request.method} ${url.pathname}`)
          if (state === "unread") return json({ _tag: "MessageDeleteRefusedError", sessionID, messageID, reason: "read", message: "YCoding has already read this message." }, { status: 409 })
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000
      while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
      if (!predicate()) throw new Error(`Message actions did not settle:\n${screen.frame()}`)
    }
    try {
      const row = screen.lines().findIndex((line) => line.includes(text))
      await screen.mouse.click(screen.lines()[row].indexOf(text) + 3, row)
      await wait(() => screen.frame().includes("Message actions"))
      expect(screen.frame().includes("Steer now")).toBe(state === "queued")
      expect(screen.frame().includes("Delete")).toBe(state !== "read" && state !== "peer")
      if (state === "read" || state === "peer") {
        expect(writes).toEqual([])
        return
      }
      await screen.input.typeText(state === "queued" ? "Steer now" : "Delete")
      screen.input.pressEnter()
      await wait(() => writes.length === 1)
      expect(writes).toEqual([state === "queued"
        ? `POST /api/session/${sessionID}/pending/${messageID}/steer`
        : `DELETE /api/session/${sessionID}/${state === "steered" ? "pending" : "message"}/${messageID}`])
      if (state === "unread") {
        await wait(() => screen.frame().includes("YCoding has already read this message."))
        screen.input.pressEscape()
        await wait(() => screen.frame().includes(text))
        expect(writes).toHaveLength(1)
      }
    } finally {
      await screen.dispose()
    }
  })
}
