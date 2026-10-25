import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { InputRenderable, type Renderable } from "@opentui/core"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { assertTestPaths } from "../preload"

const sessionID = "ses_delegation_fixture"
const directory = "/tmp/ycoding/delegation-fixture"
const attachment = {
  profile: "fixture",
  dotID: "dot_fixture",
  threadID: "thread_fixture",
  generation: "generation_fixture",
  label: "Fixture Dot",
}
const principal = {
  ownerID: "owner_fixture",
  deviceID: "device_fixture",
  clientID: "client_fixture",
  epoch: "epoch_fixture",
  grantID: "oauth_grant_fixture",
}
const task = {
  taskInputID: "msg_native_task",
  text:
    "Inspect the existing native task.\n" +
    Array.from({ length: 28 }, (_, index) => `Task line ${index + 1}: preserve native authority.`).join("\n") +
    "\nFINAL TASK LINE",
}
const candidates = () => ({ sources: [{ sourceExchangeID: "exchange_fixture", principal }], tasks: [task], grants: [] })
type Screen = Awaited<ReturnType<Awaited<typeof import("./harness")>["renderScreen"]>>

async function withDelegation(
  run: (view: {
    screen: Screen
    open: () => Promise<void>
    select: (title: string) => Promise<void>
    prepare: (presentation?: boolean) => Promise<void>
    wait: (predicate: () => boolean) => Promise<void>
    creates: Dots.DelegationCreate[]
    revokes: Dots.DelegationRevoke[]
    replies: unknown[]
    mutations: string[]
    setSources: (sources: Dots.DelegationStatus["sources"]) => void
    setAttachment: (value: Dots.Target) => void
    statusReads: () => number
    ask: (invalid?: boolean) => void
    askOrdinary: (kind: "permission" | "guardrail") => void
    holdStatus: () => { requested: Promise<void>; release: () => void }
    leaveSession: () => void
    permissionIDs: string[]
    replyEvent: (requestID: string, reply: "once" | "reject") => void
    observedReplies: () => number
    mismatchedRejection: (
      field: "proposal" | "principal" | "task" | "target" | "source" | "scope" | "expiry" | "attachment",
    ) => void
  }) => Promise<void>,
  options: {
    enabled?: boolean
    bound?: boolean
    unavailable?: boolean
    unknown?: "create" | "revoke"
    committedUnknown?: "match" | "mismatch"
    grant?: boolean
    width?: number
    height?: number
    mode?: "manual" | "auto" | "yolo"
    theme?: "dark" | "light"
  } = {},
) {
  const { renderScreen } = await import("./harness")
  const { Global } = await import("@ycoding-ai/core/global")
  assertTestPaths(Global.Path)
  const { useRoute } = await import("../../src/context/route")
  const { useClient } = await import("../../src/context/client")
  const { Keymap } = await import("../../src/context/keymap")
  let keymap: ReturnType<typeof Keymap.use> | undefined
  const keys: string[] = []
  let navigation: ReturnType<typeof useRoute> | undefined
  const location = { directory, project: { id: "proj_delegation", directory } }
  const session = {
    id: sessionID,
    title: "Native delegation",
    projectID: location.project.id,
    location: { directory },
    agent: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const creates: Dots.DelegationCreate[] = []
  const revokes: Dots.DelegationRevoke[] = []
  const replies: unknown[] = []
  const permissionIDs: string[] = []
  let observedReplies = 0
  const mutations: string[] = []
  let currentAttachment = attachment
  let status = Schema.decodeUnknownSync(Dots.DelegationStatus)(candidates())
  let statusReads = 0
  let finish: ((reply: string) => void) | undefined
  let permission = false
  let statusGate: (() => Promise<void>) | undefined
  const grant = Schema.decodeUnknownSync(Dots.DelegationInfo)({
    id: "grant_distinct_from_proposal",
    revision: 7,
    sourceExchangeID: "exchange_fixture",
    targetSessionID: sessionID,
    taskInputID: task.taskInputID,
    principal,
    scope: { operations: ["continue"] },
    expiresAt: Date.now() + 900000,
    active: true,
  })
  if (options.grant) status = { ...status, grants: [grant] }
  const screen = await renderScreen({
    width: options.width ?? 120,
    height: options.height ?? 40,
    kittyKeyboard: true,
    args: { sessionID },
    sessionReady: true,
    settle: "Message YCoding…",
    data: () => {
      navigation = useRoute()
      keymap = Keymap.use()
      keymap.intercept("key:after", (context) => {
        keys.push(`${context.event.name}:${context.handled}:${context.reason}:${keymap?.mode.current()}`)
      })
      const client = useClient()
      client.event.on("permission.replied", () => {
        observedReplies++
      })
    },
    config: {
      animations: false,
      theme: { name: "ycoding", mode: options.theme ?? "dark" },
      session: { sidebar: "hide" },
    },
    route: async (url, request) => {
      if (request.method !== "GET" && !url.pathname.endsWith("/delegation/status")) mutations.push(url.pathname)
      if (url.pathname.endsWith("/dots/delegation/status")) {
        expect(await request.json()).toEqual({ targetSessionID: sessionID, expectedAttachment: attachment })
        statusReads++
        const gate = statusGate
        statusGate = undefined
        await gate?.()
        return json({ data: status })
      }
      if (url.pathname.endsWith("/dots/delegation/revoke")) {
        revokes.push(Schema.decodeUnknownSync(Dots.DelegationRevoke)(await request.json()))
        if (options.unknown === "revoke") return json({ message: "Unknown dispatch" }, { status: 500 })
        status = { ...status, grants: [{ ...grant, active: false }] }
        return json({ data: status.grants[0] })
      }
      if (url.pathname.endsWith("/dots/delegation")) {
        const proposal = Schema.decodeUnknownSync(Dots.DelegationCreate)(await request.json())
        creates.push(proposal)
        if (options.unknown === "create") {
          if (options.committedUnknown)
            status = {
              ...status,
              grants: [
                {
                  ...grant,
                  id: proposal.proposalID,
                  revision: 1,
                  scope: proposal.scope,
                  expiresAt: proposal.expiresAt,
                  principal:
                    options.committedUnknown === "mismatch" ? { ...principal, clientID: "other_client" } : principal,
                },
              ],
            }
          return json({ message: "Unknown dispatch" }, { status: 500 })
        }
        permission = true
        ask(false, proposal)
        const reply = await new Promise<string>((resolve) => {
          finish = resolve
        })
        if (reply === "reject") return json({ message: "Denied" }, { status: 400 })
        const activated = {
          ...grant,
          id: proposal.proposalID,
          revision: 1,
          scope: proposal.scope,
          expiresAt: proposal.expiresAt,
        }
        status = { ...status, grants: [activated] }
        return json({ data: activated })
      }
      if (url.pathname.includes("/permission/per_delegation_") && url.pathname.endsWith("/reply")) {
        const requestID = url.pathname.split("/").at(-2)
        if (!requestID) throw new Error("Permission reply route requires a request ID")
        const reply = await request.json()
        replies.push(reply)
        permission = false
        screen.events.emit({
          id: "evt_delegation_replied",
          type: "permission.replied",
          created: 11,
          location: { directory },
          data: { sessionID, requestID, reply: reply.reply },
        })
        finish?.(reply.reply)
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith("/dots"))
        return options.unavailable
          ? json({}, { status: 503 })
          : json({
              data: {
                enabled: options.enabled !== false,
                state: "connected",
                ...(options.bound === false ? {} : { target: currentAttachment }),
              },
            })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname.endsWith("/snapshot")) return sessionSnapshot(sessionID, [], { session })
      if (url.pathname.endsWith("/autonomy"))
        return json({
          data: { mode: "normal", permissions: options.mode ?? "manual", guardrails: "manual", answers: "manual" },
        })
      if (url.pathname.endsWith("/subagent"))
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (["pending", "permission", "todo", "skills"].some((part) => url.pathname.endsWith(`/${part}`)))
        return json({ data: [] })
      return undefined
    },
  })
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (predicate()) {
        await screen.renderOnce()
        if (predicate()) return
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    throw new Error(
      `Delegation transition missing (mode ${keymap?.mode.current()}, focus ${screen.renderer.currentFocusedEditor?.id}; keys ${keys.slice(-4).join(", ")}; writes ${mutations.join(", ")}):\n${screen.frame()}`,
    )
  }
  const select = async (title: string) => {
    await wait(
      () =>
        screen.lines().some((line) => line.trim().startsWith(title)) &&
        !screen.frame().includes("Reading delegation status"),
    )
    const row = screen.lines().findIndex((line) => line.trim().startsWith(title))
    await screen.mouse.click(screen.lines()[row].indexOf(title) - 1, row)
    await screen.renderOnce()
  }
  const open = async () => {
    screen.input.pressKey("p", { ctrl: true })
    await wait(
      () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    await screen.input.typeText("Dots coordinator delegation")
    await screen.renderOnce()
    screen.input.pressEnter()
    await wait(() => screen.frame().includes("Coordinator delegation"))
  }
  const prepare = async (presentation = false) => {
    await select("Source exchange")
    await select("client_fixture")
    await select("Existing native task")
    await select("msg_native_task")
    if (presentation) {
      await select("Format · bullets")
      await select("Detail · concise")
    } else await select("Instruction · Continue")
    await select("Expiry")
    await select("15 minutes")
  }
  const ask = (invalid = false, proposal?: Dots.DelegationCreate) => {
    permission = true
    const requestID = `per_delegation_${permissionIDs.length + 1}`
    permissionIDs.push(requestID)
    const value = Schema.decodeUnknownSync(Dots.DelegationReview)({
      kind: "dots-task-delegation",
      proposalID: proposal?.proposalID ?? "proposal_fixture",
      sourceExchangeID: "exchange_fixture",
      principal,
      targetSessionID: sessionID,
      taskInputID: task.taskInputID,
      task: task.text,
      expectedAttachment: attachment,
      scope: proposal?.scope ?? { operations: ["continue"] },
      expiresAt: proposal?.expiresAt ?? Date.now() + 900000,
      lifetime: "binding",
      fingerprint: "fingerprint_fixture",
    })
    screen.events.emit({
      id: `evt_delegation_permission_${requestID}`,
      type: "permission.asked",
      created: 10,
      location: { directory },
      data: {
        id: requestID,
        sessionID,
        action: "dots_delegate",
        resources: ["exchange_fixture"],
        ...(invalid ? { save: ["*"] } : {}),
        metadata: invalid ? { task: "Pretend delegation" } : { ...value, requireHuman: true },
      },
    })
  }
  try {
    await screen.waitForEventStream()
    await run({
      screen,
      open,
      select,
      prepare,
      wait,
      creates,
      revokes,
      replies,
      mutations,
      ask,
      askOrdinary: (kind) => {
        if (kind === "permission")
          screen.events.emit({
            id: "evt_ordinary_permission",
            type: "permission.asked",
            created: 12,
            location: { directory },
            data: {
              id: "per_delegation_ordinary",
              sessionID,
              action: "shell",
              resources: [task.text],
              save: ["fixture command"],
              metadata: {},
            },
          })
        if (kind === "guardrail")
          screen.events.emit({
            id: "evt_ordinary_guardrail",
            type: "guardrail.asked",
            created: 12,
            location: { directory },
            data: {
              id: "grq_ordinary",
              sessionID,
              rootSessionID: sessionID,
              action: "shell",
              resources: ["fixture command"],
              reason: task.text,
              ruleIDs: ["standard.review.shell"],
              standard: true,
              hardReview: false,
            },
          })
      },
      permissionIDs,
      observedReplies: () => observedReplies,
      replyEvent: (requestID, reply) =>
        screen.events.emit({
          id: `evt_reply_${requestID}_${reply}`,
          type: "permission.replied",
          created: 12,
          location: { directory },
          data: { sessionID, requestID, reply },
        }),
      mismatchedRejection: (field) => {
        const proposal = creates.at(-1)!
        const requestID = `per_negative_${field}`
        const review = Schema.decodeUnknownSync(Dots.DelegationReview)({
          kind: "dots-task-delegation",
          proposalID: field === "proposal" ? "other_proposal" : proposal.proposalID,
          sourceExchangeID: field === "source" ? "other_exchange" : proposal.sourceExchangeID,
          principal: field === "principal" ? { ...principal, ownerID: "other_owner" } : principal,
          targetSessionID: field === "target" ? "ses_other_target" : sessionID,
          taskInputID: field === "task" ? "msg_other_task" : proposal.taskInputID,
          task: task.text,
          expectedAttachment: field === "attachment" ? { ...attachment, generation: "other_generation" } : attachment,
          scope: field === "scope" ? { operations: ["presentation"], format: ["bullets"] } : proposal.scope,
          expiresAt: proposal.expiresAt + (field === "expiry" ? 1 : 0),
          lifetime: "binding",
          fingerprint: "fingerprint_fixture",
        })
        screen.events.emit({
          id: `evt_ask_${field}`,
          type: "permission.asked",
          created: 12,
          location: { directory },
          data: {
            id: requestID,
            sessionID,
            action: "dots_delegate",
            resources: [proposal.sourceExchangeID],
            metadata: review,
          },
        })
        screen.events.emit({
          id: `evt_reject_${field}`,
          type: "permission.replied",
          created: 13,
          location: { directory },
          data: { sessionID, requestID, reply: "reject" },
        })
      },
      holdStatus: () => {
        const requested = Promise.withResolvers<void>()
        const released = Promise.withResolvers<void>()
        statusGate = () => {
          requested.resolve()
          return released.promise
        }
        return { requested: requested.promise, release: () => released.resolve() }
      },
      leaveSession: () => navigation?.navigate({ type: "home" }),
      setSources: (sources) => {
        status = { ...status, sources }
      },
      setAttachment: (value) => {
        currentAttachment = value
      },
      statusReads: () => statusReads,
    })
  } finally {
    if (permission) finish?.("reject")
    await screen.dispose()
  }
}

test("native proposal has no defaults and requests only native permission after explicit choices", async () => {
  await withDelegation(async ({ screen, open, select, prepare, wait, creates, replies, mutations }) => {
    await open()
    await wait(() => screen.frame().includes("Source exchange · not selected"))
    expect(screen.frame()).toContain("Source exchange · not selected")
    expect(screen.frame()).toContain("Existing native task · not selected")
    expect(screen.frame()).toContain("Expiry · not selected")
    expect(screen.frame()).not.toContain("Request native approval")
    expect(creates).toEqual([])
    await prepare()
    expect(creates).toEqual([])
    await select("Request native approval")
    await wait(() => screen.frame().includes("Permission required"))
    expect(screen.frame()).not.toContain("Source exchange ·")
    expect(screen.frame()).not.toContain("Always")
    expect(replies).toEqual([])
    expect(creates).toHaveLength(1)
    expect(creates[0].scope).toEqual({ operations: ["continue"] })
    expect(creates[0].expectedAttachment).toEqual(attachment)
    expect(creates[0].expiresAt).toBeGreaterThan(Date.now())
    expect(creates[0].expiresAt).toBeLessThanOrEqual(Date.now() + 3600000)
    screen.input.pressEscape()
    await wait(() => replies.length === 1)
    expect(mutations.filter((url) => /prompt|interrupt|question|form|review/.test(url))).toEqual([])
  })
}, 30000)

for (const mode of ["auto", "yolo"] as const)
  test(`presentation allowlists still require native approval under ${mode}`, async () => {
    await withDelegation(
      async ({ screen, open, select, prepare, wait, creates, replies }) => {
        await open()
        await prepare(true)
        await select("Request native approval")
        await wait(() => screen.frame().includes("Permission required"))
        expect(replies).toEqual([])
        expect(creates[0].scope).toEqual({ operations: ["presentation"], format: ["bullets"], detail: ["concise"] })
        screen.input.pressEscape()
        await wait(() => replies.length === 1)
      },
      { mode },
    )
  }, 30000)

for (const action of ["create", "revoke"] as const)
  test(`unknown ${action} stays locked after read-only refresh and reopening`, async () => {
    await withDelegation(
      async ({ screen, open, select, prepare, wait, creates, revokes, statusReads }) => {
        await open()
        if (action === "create") {
          await prepare()
          await select("Request native approval")
        }
        if (action === "revoke") {
          await select("Revoke delegation")
          screen.input.pressEnter()
        }
        await wait(() => screen.frame().includes("outcome unknown"))
        const before = statusReads()
        await select("Refresh status")
        await wait(() => statusReads() > before)
        expect(screen.frame()).not.toContain("Request native approval")
        expect(screen.frame()).not.toContain("Revoke delegation")
        screen.input.pressEscape()
        await open()
        expect(screen.frame()).toContain("outcome unknown")
        expect(action === "create" ? creates.length : revokes.length).toBe(1)
      },
      { unknown: action, grant: action === "revoke" },
    )
  }, 30000)

test("revoke carries the exact grant revision and binding without interrupting native execution", async () => {
  await withDelegation(
    async ({ screen, open, select, wait, revokes, mutations }) => {
      await open()
      await select("Revoke delegation")
      expect(screen.frame()).toContain("Already executing")
      expect(revokes).toEqual([])
      screen.input.pressEnter()
      await wait(() => revokes.length === 1)
      expect(revokes).toEqual([{ id: "grant_distinct_from_proposal", revision: 7, expectedAttachment: attachment }])
      expect(mutations.filter((url) => /interrupt|prompt|question|form|review/.test(url))).toEqual([])
    },
    { grant: true },
  )
}, 30000)

test("owner and attachment changes reject the captured proposal before dispatch", async () => {
  for (const change of ["owner", "attachment"])
    await withDelegation(async ({ screen, open, select, prepare, wait, creates, setSources, setAttachment }) => {
      await open()
      await prepare()
      if (change === "owner")
        setSources([{ sourceExchangeID: "exchange_fixture", principal: { ...principal, ownerID: "other_owner" } }])
      if (change === "attachment") setAttachment({ ...attachment, generation: "replacement_generation" })
      await select("Request native approval")
      if (change === "owner") await wait(() => screen.frame().includes("context changed"))
      if (change === "attachment") await wait(() => !screen.frame().includes("Coordinator delegation"))
      expect(creates).toEqual([])
    })
}, 30000)

for (const option of [{ enabled: false }, { bound: false }, { unavailable: true }])
  test(`delegation command is absent for ${JSON.stringify(option)}`, async () => {
    await withDelegation(async ({ screen, creates, revokes, wait }) => {
      screen.input.pressKey("p", { ctrl: true })
      await wait(() => screen.renderer.currentFocusedEditor instanceof InputRenderable)
      await screen.input.typeText("Dots coordinator delegation")
      await wait(() => screen.frame().includes("No results found"))
      expect(creates).toEqual([])
      expect(revokes).toEqual([])
    }, option)
  }, 30000)

test("known activation survives the native permission composer remount without replay", async () => {
  await withDelegation(async ({ screen, open, select, prepare, wait, creates, replies }) => {
    await open()
    await prepare()
    await select("Request native approval")
    await wait(() => screen.frame().includes("Permission required"))
    screen.input.pressEnter()
    await wait(() => replies.length === 1 && !screen.frame().includes("Permission required"))
    await open()
    await wait(() => screen.frame().includes("Revoke delegation"))
    expect(screen.frame()).not.toContain("outcome unknown")
    expect(creates).toHaveLength(1)
  })
}, 30000)

test("exact native Deny settles rejection and permits only a new explicit proposal", async () => {
  await withDelegation(async ({ screen, open, prepare, select, wait, creates, replies }) => {
    await open()
    await prepare()
    await select("Request native approval")
    await wait(() => screen.frame().includes("Permission required"))
    expect(screen.frame()).not.toContain("Coordinator delegation")
    screen.input.pressEscape()
    await wait(() => replies.length === 1 && !screen.frame().includes("Permission required"))
    await open()
    await wait(() => screen.frame().includes("Native delegation denied"))
    expect(screen.frame()).not.toContain("Mutations locked")
    expect(screen.frame()).not.toContain("Request native approval")
    expect(creates).toHaveLength(1)
    await prepare()
    await select("Request native approval")
    await wait(() => screen.frame().includes("Permission required"))
    expect(creates).toHaveLength(2)
    expect(creates[1].proposalID).not.toBe(creates[0].proposalID)
    expect(replies).toHaveLength(1)
    screen.input.pressEscape()
    await wait(() => replies.length === 2)
  })
}, 30000)

test("unrelated or mismatched native rejection cannot unlock an uncertain proposal", async () => {
  await withDelegation(
    async ({ screen, open, prepare, select, wait, creates, mismatchedRejection, observedReplies }) => {
      await open()
      await prepare()
      await select("Request native approval")
      await wait(() => screen.frame().includes("outcome unknown"))
      for (const field of [
        "proposal",
        "principal",
        "task",
        "target",
        "source",
        "scope",
        "expiry",
        "attachment",
      ] as const) {
        const before = observedReplies()
        mismatchedRejection(field)
        await wait(() => observedReplies() > before)
        screen.input.pressEscape()
        await wait(() => !screen.frame().includes("Coordinator delegation"))
        await open()
        await wait(() => screen.frame().includes("outcome unknown"))
        expect(screen.frame()).not.toContain("Native delegation denied")
        expect(screen.frame()).not.toContain("Request native approval")
      }
      expect(creates).toHaveLength(1)
    },
    { unknown: "create" },
  )
}, 30000)

test("late rejection of an earlier native permission cannot settle the next proposal", async () => {
  await withDelegation(
    async ({ screen, open, prepare, select, wait, creates, replies, permissionIDs, replyEvent, observedReplies }) => {
      await open()
      await prepare()
      await select("Request native approval")
      await wait(() => screen.frame().includes("Permission required"))
      screen.input.pressEscape()
      await wait(() => replies.length === 1 && !screen.frame().includes("Permission required"))
      await open()
      await prepare()
      await select("Request native approval")
      await wait(() => screen.frame().includes("Permission required"))
      const before = observedReplies()
      replyEvent(permissionIDs[0], "reject")
      replyEvent(permissionIDs[1], "once")
      await wait(() => observedReplies() >= before + 2 && !screen.frame().includes("Permission required"))
      await open()
      await wait(() => screen.frame().includes("Delegation pending"))
      expect(screen.frame()).not.toContain("Native delegation denied")
      expect(screen.frame()).not.toContain("Request native approval")
      expect(creates).toHaveLength(2)
      expect(replies).toHaveLength(1)
    },
  )
}, 30000)

for (const match of ["match", "mismatch"] as const)
  test(`unknown activation reconciles only an exact authoritative grant: ${match}`, async () => {
    await withDelegation(
      async ({ screen, open, prepare, select, wait, creates }) => {
        await open()
        await prepare()
        await select("Request native approval")
        await wait(() => screen.frame().includes(match === "match" ? "Revoke delegation" : "outcome unknown"))
        expect(creates).toHaveLength(1)
        if (match === "match") expect(screen.frame()).not.toContain("Mutations locked")
        if (match === "mismatch") {
          await select("Refresh status")
          expect(screen.frame()).not.toContain("Revoke delegation")
        }
      },
      { unknown: "create", committedUnknown: match },
    )
  }, 30000)

test("optional presentation fields remain absent and removing every operation blocks submission", async () => {
  await withDelegation(async ({ screen, open, prepare, select, wait, creates, replies }) => {
    await open()
    await prepare(true)
    await select("Detail · concise")
    await select("Format · bullets")
    expect(screen.frame()).not.toContain("Request native approval")
    await select("Format · prose")
    await select("Request native approval")
    await wait(() => screen.frame().includes("Permission required"))
    expect(creates[0].scope).toEqual({ operations: ["presentation"], format: ["prose"] })
    screen.input.pressEscape()
    await wait(() => replies.length === 1)
  })
}, 30000)

for (const minutes of [30, 60])
  test(`expiry preset ${minutes} minutes is explicit and bounded`, async () => {
    await withDelegation(async ({ screen, open, prepare, select, wait, creates, replies }) => {
      await open()
      await prepare()
      await select("Expiry")
      await select(`${minutes} minutes`)
      const before = Date.now()
      await select("Request native approval")
      await wait(() => screen.frame().includes("Permission required"))
      expect(creates[0].expiresAt).toBeGreaterThanOrEqual(before + minutes * 60000)
      expect(creates[0].expiresAt).toBeLessThanOrEqual(Date.now() + minutes * 60000)
      screen.input.pressEscape()
      await wait(() => replies.length === 1)
    })
  }, 30000)

test("closing or disconnecting during a status read cannot reopen obsolete UI", async () => {
  for (const disconnect of [false, true])
    await withDelegation(async ({ screen, open, wait, holdStatus, creates }) => {
      const gate = holdStatus()
      const opening = open()
      await gate.requested
      await opening
      if (disconnect) screen.events.disconnect()
      if (!disconnect) screen.input.pressEscape()
      await wait(() => !screen.frame().includes("Coordinator delegation"))
      gate.release()
      await screen.renderOnce()
      expect(screen.frame()).not.toContain("Coordinator delegation")
      expect(creates).toEqual([])
    })
}, 30000)

test("leaving the Session during preflight prevents dispatch and late dialog updates", async () => {
  await withDelegation(async ({ screen, open, prepare, select, wait, holdStatus, leaveSession, creates }) => {
    await open()
    await prepare()
    const gate = holdStatus()
    await select("Request native approval")
    await gate.requested
    leaveSession()
    await wait(() => !screen.frame().includes("Native delegation"))
    gate.release()
    await screen.renderOnce()
    expect(creates).toEqual([])
    expect(screen.frame()).not.toContain("Coordinator delegation")
    expect(screen.frame()).not.toContain("Delegation context changed")
  })
}, 30000)

test("malformed native delegation metadata is reject-only even with save patterns", async () => {
  await withDelegation(async ({ screen, ask, wait, replies }) => {
    ask(true)
    await wait(() => screen.frame().includes("Delegation review unavailable"))
    expect(screen.frame()).not.toContain("Allow once")
    expect(screen.frame()).not.toContain("Always")
    screen.input.pressEscape()
    await wait(() => replies.length === 1)
    expect(replies[0]).toMatchObject({ reply: "reject" })
  })
}, 30000)

for (const theme of ["dark", "light"] as const)
  for (const [width, height] of [
    [32, 16],
    [50, 18],
    [120, 40],
  ])
    test(`canonical native review pages complete task text at ${width}x${height} in ${theme}`, async () => {
      await withDelegation(
        async ({ screen, ask, wait, replies }) => {
          ask()
          await wait(() => screen.frame().includes("Permission required"))
          const seen = new Set<string>()
          for (let index = 0; index < 80; index++) {
            const frame = screen.frame().replace(/\s+/g, " ")
            for (const fact of [
              "owner_fixture",
              "device_fixture",
              "client_fixture",
              "oauth_grant_fixture",
              "exchange_fixture",
              "msg_native_task",
              "FINAL TASK LINE",
              "fingerprint_fixture",
              "expires",
              "continues",
            ])
              if (frame.toLowerCase().includes(fact.toLowerCase())) seen.add(fact)
            expect(frame, JSON.stringify(approvalGeometry(screen.renderer.root))).toContain("Allow once")
            expect(frame, JSON.stringify(approvalGeometry(screen.renderer.root))).toContain("Deny")
            expect(frame).not.toContain("Always")
            if (seen.size === 10) break
            screen.input.pressKey("\u001b[6~")
            await screen.renderOnce()
          }
          expect([...seen].sort()).toEqual(
            [
              "owner_fixture",
              "device_fixture",
              "client_fixture",
              "oauth_grant_fixture",
              "exchange_fixture",
              "msg_native_task",
              "FINAL TASK LINE",
              "fingerprint_fixture",
              "expires",
              "continues",
            ].sort(),
          )
          expect(replies).toEqual([])
          screen.input.pressEscape()
          await wait(() => replies.length === 1)
        },
        { width, height, theme },
      )
    }, 30000)

for (const kind of ["permission", "guardrail"] as const)
  test(`ordinary ${kind} keeps every decision and complete details at 32x16`, async () => {
    await withDelegation(
      async ({ screen, askOrdinary, wait, mutations }) => {
        askOrdinary(kind)
        await wait(() => screen.frame().includes(kind === "permission" ? "Permission required" : "Guardrail blocked"))
        let complete = false
        for (let page = 0; page < 100; page++) {
          const frame = screen.frame().replace(/\s+/g, " ")
          for (const label of ["Deny", "Allow once", "Allow for this session", "pgup/pgdn"])
            expect(frame, JSON.stringify(approvalGeometry(screen.renderer.root))).toContain(label)
          if (process.env.YCODING_TUI_CAPTURE_DIR && (page === 0 || frame.includes("FINAL TASK LINE"))) {
            const file = path.join(
              process.env.YCODING_TUI_CAPTURE_DIR,
              `${kind}-32x16-${page === 0 ? "first" : "last"}`,
            )
            if ((await Bun.file(`${file}.txt`).exists()) || (await Bun.file(`${file}.json`).exists()))
              throw new Error("Capture output already exists")
            await Bun.write(`${file}.txt`, screen.frame())
            await Bun.write(
              `${file}.json`,
              JSON.stringify(
                screen
                  .spans()
                  .lines.map((line) =>
                    line.spans.map((span) => ({ text: span.text, fg: span.fg.toInts(), bg: span.bg.toInts() })),
                  ),
              ),
            )
          }
          if (frame.includes("FINAL TASK LINE")) {
            complete = true
            break
          }
          screen.input.pressKey("\u001b[6~")
          await screen.renderOnce()
        }
        expect(complete).toBe(true)
        expect(mutations).toEqual([])
      },
      { width: 32, height: 16 },
    )
  }, 30000)

function approvalGeometry(node: Renderable): { id: string; y: number; height: number; parentHeight?: number }[] {
  return [
    ...(node.id.startsWith("session.permission") || node.id.startsWith("session.guardrail")
      ? [{ id: node.id, y: node.y, height: node.height, parentHeight: node.parent?.height }]
      : []),
    ...node.getChildren().flatMap(approvalGeometry),
  ]
}
