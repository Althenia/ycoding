/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { SessionRowView } from "../../../src/routes/session"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup?.renderer.destroy()
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

test("a message row for a message that does not exist renders nothing, not a blank line", async () => {
  const frame = await renderFrame(
    () => (
      <box flexDirection="column" width={40}>
        <text>before</text>
        <SessionRowView row={{ type: "message", messageID: "msg_missing" }} message={() => undefined} />
        <text>after</text>
      </box>
    ),
    { width: 40, height: 6 },
  )

  expect(frame).toBe("before\nafter")
  testSetup?.renderer.destroy()
  testSetup = undefined
})

test("assistant content rows without a resident message render no empty blocks", async () => {
  const frame = await renderFrame(
    () => (
      <box flexDirection="column" width={40}>
        <text>before</text>
        <SessionRowView
          row={{ type: "part", ref: { messageID: "msg_missing", partID: "text:0" } }}
          message={() => undefined}
        />
        <SessionRowView
          row={{
            type: "group",
            kind: "reasoning",
            refs: [{ messageID: "msg_missing", partID: "reasoning:0" }],
            completed: true,
          }}
          message={() => undefined}
        />
        <SessionRowView
          row={{
            type: "group",
            kind: "exploration",
            refs: [{ messageID: "msg_missing", partID: "tool_1" }],
            pending: [],
            completed: true,
          }}
          message={() => undefined}
        />
        <text>after</text>
      </box>
    ),
    { width: 40, height: 8 },
  )

  expect(frame).toBe("before\nafter")
  testSetup?.renderer.destroy()
  testSetup = undefined
})
