import { expect, test } from "bun:test"
import { remoteWebSocketURL } from "./endpoint"

test.each(["https://ycoding.althenia.app", "https://beta.ycoding.althenia.app"])(
  "the %s site uses its own v5 relay, separate from hosted HTTP",
  (origin) => {
    expect(remoteWebSocketURL(origin, "dev_browser")).toBe(
      `${origin.replace("https:", "wss:")}/ws/v5/client?device=dev_browser`,
    )
  },
)

test("local development retains its origin and encodes device identity", () => {
  expect(remoteWebSocketURL("http://localhost:5173", "device & test")).toBe(
    "ws://localhost:5173/ws/v5/client?device=device+%26+test",
  )
})
