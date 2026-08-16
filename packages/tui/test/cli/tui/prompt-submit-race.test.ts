import { describe, expect, test } from "bun:test"
import {
  confirmSessionCreation,
  restoreSessionSubmission,
  retainSessionSubmission,
  submitSessionPrompt,
} from "../../../src/util/session-autonomy"

// Regression test for the prompt submit race in
// packages/tui/src/component/prompt/index.tsx (`submit`).
//
// Before the fix, two concurrent `submit()` calls (e.g. a double-pressed
// Enter, or the input's native onSubmit racing another dispatch) each
// passed the `if (!store.prompt.text) return false` guard, each
// `await client.api.session.create(...)`, and each only captured
// `inputText = store.prompt.text` AFTER that await. The first invocation
// finished, sent the prompt, and cleared the store; the second invocation,
// now past its await, read the cleared store and sent an empty prompt to a
// second freshly-created session - leaving an orphaned session with the
// user's actual text and a phantom session visible to the user containing
// only an assistant reply.
//
// `submitMirror` below has the exact shape of the production `submit()`
// after the fix: an in-flight `submitting` guard wraps the original body.
// Two concurrent invocations must result in exactly one submission carrying
// the user's text, with no empty-text submission.

type Store = { input: string }

type SubmitResult = { sessionID: string; text: string }

type Harness = {
  store: Store
  submissions: SubmitResult[]
  createSession(): Promise<string>
  sendPrompt(sessionID: string, text: string): Promise<void>
}

function createHarness(opts: { sessionCreateDelayMs: number }): Harness {
  let sessionCounter = 0
  const submissions: SubmitResult[] = []

  return {
    store: { input: "" },
    submissions,
    async createSession() {
      sessionCounter += 1
      const id = `ses_${sessionCounter}`
      await Bun.sleep(opts.sessionCreateDelayMs)
      return id
    },
    async sendPrompt(sessionID, text) {
      submissions.push({ sessionID, text })
    },
  }
}

function createSubmit() {
  let submitting = false
  return async function submit(h: Harness) {
    if (submitting) return false
    submitting = true
    try {
      if (!h.store.input) return false
      const sessionID = await h.createSession()
      const inputText = h.store.input
      await h.sendPrompt(sessionID, inputText)
      h.store.input = ""
      return true
    } finally {
      submitting = false
    }
  }
}

describe("Prompt.submit race", () => {
  test("concurrent submits must not lose the user's text", async () => {
    const submit = createSubmit()
    const h = createHarness({ sessionCreateDelayMs: 5 })
    h.store.input = "Hello there."

    // Two invocations back-to-back, mimicking a double-Enter.
    await Promise.all([submit(h), submit(h)])

    // Every submission that did make it through must carry the actual user
    // text, and no submission may have an empty text payload.
    expect(h.submissions.every((s) => s.text === "Hello there.")).toBe(true)
    expect(h.submissions.some((s) => s.text === "")).toBe(false)
  })

  test("a sequential second submit after clear is a no-op, not a phantom session", async () => {
    const submit = createSubmit()
    const h = createHarness({ sessionCreateDelayMs: 1 })
    h.store.input = "Hello there."

    await submit(h)
    // After the first submission completes, the store is cleared; a second
    // Enter on an empty input must not create a phantom session.
    await submit(h)

    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0].text).toBe("Hello there.")
  })

  test("retains one session and stable message IDs for an unchanged failed submission", () => {
    const first = retainSessionSubmission(
      undefined,
      "same input",
      2,
      { text: "same input", skills: ["one", "two"] },
      "ses_1",
    )
    const retry = retainSessionSubmission(first, "same input", 2, { text: "same input", skills: ["one", "two"] })

    expect(retry).toBe(first)
    expect(retry.sessionID).toBe("ses_1")
    expect(retry.promptID).toMatch(/^msg_/)
    expect(retry.syntheticID).toMatch(/^msg_/)
    expect(retry.skillIDs).toHaveLength(2)
    expect(new Set(retry.skillIDs).size).toBe(2)

    const changed = retainSessionSubmission(retry, "changed input", 0, { text: "changed input", skills: [] })
    expect(changed).toBe(retry)
    expect(changed.sessionID).toBe("ses_1")
    expect(changed.promptID).toBe(retry.promptID)
    expect(changed.payload).toEqual({ text: "same input", skills: ["one", "two"] })
  })

  test("retries a lost Home create response with one preallocated session identity", async () => {
    const submission = retainSessionSubmission(undefined, "same input", 0, { text: "same input" })
    const calls: string[] = []
    let loseResponse = true
    const create = async (sessionID: string) => {
      calls.push(sessionID)
      if (loseResponse) {
        loseResponse = false
        throw new Error("lost create response")
      }
      return { id: sessionID }
    }

    expect(submission.sessionID).toMatch(/^ses_/)
    expect(submission.creationConfirmed).toBe(false)
    await expect(confirmSessionCreation(submission, create)).rejects.toThrow("lost create response")
    expect(submission.creationConfirmed).toBe(false)

    const created = await confirmSessionCreation(submission, create)
    expect(created).toEqual({ id: submission.sessionID })
    expect(submission.creationConfirmed).toBe(true)
    expect(calls).toEqual([submission.sessionID, submission.sessionID])
    expect(new Set(calls).size).toBe(1)

    const prompts: string[] = []
    await submitSessionPrompt({
      prompt: async (resume) => void prompts.push(`${submission.promptID}:${resume ? "wake" : "admit"}`),
      skills: [],
    })
    expect(prompts).toEqual([`${submission.promptID}:admit`, `${submission.promptID}:wake`])
  })

  test("existing sessions never invoke create", async () => {
    const submission = retainSessionSubmission(undefined, "same input", 0, { text: "same input" }, "ses_existing")
    const calls: string[] = []

    const created = await confirmSessionCreation(submission, async (sessionID) => {
      calls.push(sessionID)
      return { id: sessionID }
    })

    expect(submission.sessionID).toBe("ses_existing")
    expect(submission.creationConfirmed).toBe(true)
    expect(created).toBeUndefined()
    expect(calls).toEqual([])
  })

  test("retry action stashes a changed draft and restores the exact retained prompt and IDs", async () => {
    const retained = {
      text: "original @agent #file [Skill] [Pasted text]",
      files: [{ path: "src/original.ts", mention: { start: 16, end: 21, text: "#file" } }],
      agents: [{ name: "agent", mention: { start: 9, end: 15, text: "@agent" } }],
      skills: [{ id: "review", mention: { start: 22, end: 29, text: "[Skill]" } }],
      pasted: [{ text: "pasted data", source: { start: 30, end: 43, text: "[Pasted text]" } }],
      mode: "normal" as const,
    }
    const changed = {
      text: "keep this changed draft",
      files: [],
      agents: [],
      skills: [],
      pasted: [],
      mode: "normal" as const,
    }
    const submission = retainSessionSubmission(
      undefined,
      "original-key",
      1,
      { history: retained, cursor: 12 },
      "ses_existing",
    )
    const identity = {
      sessionID: submission.sessionID,
      promptID: submission.promptID,
      syntheticID: submission.syntheticID,
      skillIDs: submission.skillIDs,
    }
    const stashed: Array<typeof retained> = []

    const restored = restoreSessionSubmission<typeof retained>(
      submission,
      changed,
      (prompt) => stashed.push(structuredClone(prompt)),
      (prompt) =>
        !prompt.text && !prompt.files.length && !prompt.agents.length && !prompt.skills.length && !prompt.pasted.length,
    )

    expect(stashed).toEqual([changed])
    expect(restored.prompt).toEqual(retained)
    expect(restored.prompt).not.toBe(retained)
    expect(restored.cursor).toBe(12)
    expect(submission).toMatchObject(identity)
    const exact = retainSessionSubmission(submission, submission.key, 1, submission.payload, "ses_other")
    expect(exact).toBe(submission)

    const unstashed: Array<typeof retained> = []
    restoreSessionSubmission<typeof retained>(
      submission,
      retained,
      (prompt) => unstashed.push(prompt),
      (prompt) =>
        !prompt.text && !prompt.files.length && !prompt.agents.length && !prompt.skills.length && !prompt.pasted.length,
    )
    expect(unstashed).toEqual([])

    const calls: string[] = []
    await submitSessionPrompt({
      prompt: async (resume) => void calls.push(`${exact.sessionID}:${exact.promptID}:${resume ? "wake" : "admit"}`),
      skills: [async () => void calls.push(`${exact.sessionID}:${exact.skillIDs[0]}:review`)],
    })
    expect(calls).toEqual([
      `${identity.sessionID}:${identity.promptID}:admit`,
      `${identity.sessionID}:${identity.skillIDs[0]}:review`,
      `${identity.sessionID}:${identity.promptID}:wake`,
    ])
  })

  test("retry restoration preserves display-cell cursor offsets for wide characters", () => {
    const retained = { text: "中文", files: [], agents: [], skills: [], pasted: [], mode: "normal" as const }
    const submission = retainSessionSubmission(
      undefined,
      "wide input",
      0,
      { history: retained, cursor: 4 },
      "ses_existing",
    )

    const restored = restoreSessionSubmission<typeof retained>(
      submission,
      { text: "changed draft", files: [], agents: [], skills: [], pasted: [], mode: "normal" },
      () => {},
      (prompt) => !prompt.text,
    )

    expect(restored.prompt.text).toBe("中文")
    expect(restored.cursor).toBe(4)
  })

  test("holds changed selected skills behind exact reconciliation of partial admission", async () => {
    const first = retainSessionSubmission(
      undefined,
      "first",
      2,
      {
        text: "first",
        skills: ["review.v2", "code review"],
      },
      "ses_1",
    )
    const calls: string[] = []
    let failSecond = true
    const run = (submission: typeof first) =>
      import("../../../src/util/session-autonomy").then(({ submitSessionPrompt }) =>
        submitSessionPrompt({
          prompt: async (resume) => {
            calls.push(`${submission.sessionID}:${submission.promptID}:${resume ? "wake" : "admit"}`)
          },
          skills: submission.payload.skills.map((skill, index) => async () => {
            calls.push(`${submission.sessionID}:${submission.skillIDs[index]}:${skill}`)
            if (index === 1 && failSecond) {
              failSecond = false
              throw new Error("lost response")
            }
          }),
        }),
      )

    await expect(run(first)).rejects.toThrow("lost response")
    const beforeChanged = calls.slice()
    const changed = retainSessionSubmission(first, "changed", 1, { text: "changed", skills: ["plan"] })

    expect(changed).toBe(first)
    expect(changed.sessionID).toBe("ses_1")
    expect(changed.promptID).toBe(first.promptID)
    expect(changed.skillIDs).toEqual(first.skillIDs)
    expect(changed.payload).toEqual({ text: "first", skills: ["review.v2", "code review"] })
    expect(calls).toEqual(beforeChanged)
    expect(calls.some((call) => call.endsWith(":wake"))).toBe(false)

    await run(changed)
    expect(calls.at(-1)).toBe(`ses_1:${first.promptID}:wake`)
  })
})
