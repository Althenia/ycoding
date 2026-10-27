/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Dots } from "@ycoding-ai/schema/dots"
import type { PermissionRequest } from "@ycoding-ai/client"
import { Schema } from "effect"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { LocationProvider } from "../src/context/location"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { PermissionPrompt } from "../src/routes/session/permission"
import { createApi, createFetch } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const common = {
  proposalID: "proposal_fixture", sourceExchangeID: "exchange_fixture", targetSessionID: "ses_target",
  principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture", epoch: "epoch_fixture", grantID: "oauth_grant_fixture" },
  expectedAttachment: { profile: "profile_fixture", dotID: "dot_fixture", threadID: "thread_fixture", generation: "generation_fixture", label: "Fixture" },
  expiresAt: 2000000000000, lifetime: "binding", fingerprint: "fingerprint_fixture",
}

async function render(metadata: PermissionRequest["metadata"], width: number, height: number, mode: "dark" | "light") {
  const replies: unknown[] = []
  const transport = createFetch(async (url, request) => {
    if (url.pathname === "/api/session/ses_target/permission/per_fixture/reply") {
      replies.push(await request.json())
      return new Response(null, { status: 204 })
    }
    return undefined
  })
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
      <ClientProvider api={createApi(transport.fetch)}><DataProvider><LocationProvider><Keymap.Provider>
        <box height="100%"><box flexGrow={1}><text>Transcript remains visible</text></box>
          <PermissionPrompt request={{ id: "per_fixture", sessionID: "ses_target", action: "dots_delegate", resources: ["exchange_fixture"], save: ["*"], metadata }} />
        </box>
      </Keymap.Provider></LocationProvider></DataProvider></ClientProvider>
    </ThemeProvider></ConfigProvider></TestTuiContexts>
  ), { width, height, kittyKeyboard: true })
  app.renderer.start()
  return { app, replies }
}

test("malformed delegation remains reject-only even with save patterns", async () => {
  const { app, replies } = await render({ task: "Unverified delegation" }, 80, 24, "dark")
  try {
    await app.waitForFrame((frame) => frame.includes("Delegation review unavailable"))
    expect(app.captureCharFrame()).not.toContain("Allow once")
    expect(app.captureCharFrame()).not.toContain("Always")
    app.mockInput.pressEscape()
    await app.waitForFrame(() => replies.length === 1)
    expect(replies).toEqual([{ reply: "reject" }])
  } finally { app.renderer.destroy() }
})

for (const mode of ["dark", "light"] as const)
  for (const [width, height] of [[32, 16], [50, 18], [120, 40]])
    test(`retained native task review pages provenance and task at ${width}x${height} in ${mode}`, async () => {
      const metadata = {
        ...common, kind: "dots-task-delegation", taskInputID: "msg_native_task",
        task: Array.from({ length: 28 }, (_, index) => `Task line ${index}: preserve authority.`).join("\n") + "\nFINAL TASK LINE",
        scope: { operations: ["continue"] },
      } satisfies PermissionRequest["metadata"]
      Schema.decodeUnknownSync(Dots.DelegationReview)(metadata)
      const { app, replies } = await render(metadata, width!, height!, mode)
      try {
        await app.waitForFrame((frame) => frame.includes("Permission required"))
        const facts = ["owner_fixture", "device_fixture", "client_fixture", "oauth_grant_fixture", "exchange_fixture", "msg_native_task", "FINAL TASK LINE", "fingerprint_fixture", "Expires", "continues"]
        const seen = new Set<string>()
        for (let page = 0; page < 80; page++) {
          const frame = app.captureCharFrame().replace(/\s+/g, " ")
          for (const fact of facts) if (frame.includes(fact)) seen.add(fact)
          expect(frame).toContain("Allow once")
          expect(frame).toContain("Deny")
          expect(frame).not.toContain("Always")
          if (seen.size === facts.length) break
          app.mockInput.pressKey("\u001b[6~")
          await app.renderOnce()
        }
        expect([...seen].sort()).toEqual(facts.toSorted())
        expect(replies).toEqual([])
      } finally { app.renderer.destroy() }
    })

test("retained Session delegation review identifies its source and exact scope", async () => {
  const metadata = { ...common, kind: "dots-session-delegation", scope: { operations: ["task", "decision"] } } satisfies PermissionRequest["metadata"]
  Schema.decodeUnknownSync(Dots.SessionDelegationReview)(metadata)
  const { app, replies } = await render(metadata, 120, 55, "dark")
  try {
    await app.waitForFrame((frame) => frame.includes("fingerprint_fixture"))
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    for (const fact of ["OAuth client", "owner_fixture", "exchange_fixture", "task, decision", "fingerprint_fixture", "already executing native work continues"])
      expect(frame).toContain(fact)
    expect(frame).not.toContain("Always")
    expect(replies).toEqual([])
  } finally { app.renderer.destroy() }
})
