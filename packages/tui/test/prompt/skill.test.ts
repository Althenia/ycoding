import { describe, expect, test } from "bun:test"
import { parsePromptInfo } from "../../src/prompt/history"
import { promptSkillMentions, promptSkillMetadata, segmentPromptSkills } from "../../src/prompt/skill"
import { submitPrompt } from "../../src/component/prompt/prompt-admission"

describe("prompt skills", () => {
  test("keeps only valid selected skill metadata", () => {
    expect(
      promptSkillMetadata([
        { id: "review", name: "Code review" },
        { id: "", name: "Missing" },
        { id: "broken", name: "" },
      ]),
    ).toEqual({ skills: [{ id: "review", name: "Code review" }] })
  })

  test("replaces only selected skill tokens", () => {
    expect(
      segmentPromptSkills("Use $review then $plan and $reviewer", [{ id: "review", name: "Code review" }]),
    ).toEqual([
      { type: "text", value: "Use " },
      { type: "skill", value: "✦ Code review" },
      { type: "text", value: " then $plan and $reviewer" },
    ])
  })

  test("replaces selected skill IDs with punctuation and spaces at token boundaries", () => {
    expect(
      segmentPromptSkills("Use $review.v2 then $code review and keep $review.v2x raw", [
        { id: "review.v2", name: "Review v2" },
        { id: "code review", name: "Code review" },
      ]),
    ).toEqual([
      { type: "text", value: "Use " },
      { type: "skill", value: "✦ Review v2" },
      { type: "text", value: " then " },
      { type: "skill", value: "✦ Code review" },
      { type: "text", value: " and keep $review.v2x raw" },
    ])
  })

  test("matches the longest selected ID and leaves unselected dollar text unchanged", () => {
    expect(
      segmentPromptSkills("$reviewer $review $plan", [
        { id: "review", name: "Review" },
        { id: "reviewer", name: "Reviewer" },
      ]),
    ).toEqual([
      { type: "skill", value: "✦ Reviewer" },
      { type: "text", value: " " },
      { type: "skill", value: "✦ Review" },
      { type: "text", value: " $plan" },
    ])
  })

  test("resolves typed skill mentions against the available skills", () => {
    expect(
      promptSkillMentions("$review then $plan and $reviewers", [
        { id: "review", name: "Review" },
        { id: "plan", name: "Planning" },
        { id: "reviewer", name: "Reviewer" },
      ]),
    ).toEqual([
      { id: "review", name: "Review" },
      { id: "plan", name: "Planning" },
    ])
  })

  test("preserves typed $skill admission order", () => {
    expect(
      promptSkillMentions("$plan then $review", [
        { id: "review", name: "Review" },
        { id: "plan", name: "Plan" },
      ]),
    ).toEqual([
      { id: "plan", name: "Plan" },
      { id: "review", name: "Review" },
    ])
  })

  test("keeps menu-selected skills that no longer match a text mention", () => {
    expect(
      promptSkillMentions(
        "$review and pasted text",
        [
          { id: "review", name: "Review" },
          { id: "plan", name: "Planning" },
        ],
        [
          { id: "plan", name: "Planning" },
          { id: "review", name: "Review" },
        ],
      ),
    ).toEqual([
      { id: "review", name: "Review" },
      { id: "plan", name: "Planning" },
    ])
  })

  test("accepts historical prompt entries without skills", () => {
    expect(parsePromptInfo({ text: "Existing prompt", pasted: [] })).toEqual({ text: "Existing prompt", pasted: [] })
  })

  test("settles admission before waking the prompt", async () => {
    const calls: string[] = []
    let releaseAdmission!: () => void
    const admitted = new Promise<void>((resolve) => (releaseAdmission = resolve))

    const submission = submitPrompt({
      prompt: async (resume) => {
        calls.push(resume ? "prompt:wake" : "prompt:admit")
        if (!resume) await admitted
      },
    })

    expect(calls).toEqual(["prompt:admit"])
    releaseAdmission()
    await submission
    expect(calls).toEqual(["prompt:admit", "prompt:wake"])
  })

  test("returns the first durable admission and supplies it to the exact wake retry", async () => {
    const admitted = { files: [{ uri: `ycoding-attachment://sha256/${"a".repeat(64)}`, name: "clipboard.png" }] }
    const calls: Array<{ resume: boolean; admitted?: unknown }> = []

    const result = await submitPrompt({
      prompt: async (resume, durable) => {
        calls.push({ resume, admitted: durable })
        return resume ? { ignored: true } : admitted
      },
    })

    expect(result).toEqual({ admitted })
    expect(calls).toEqual([
      { resume: false, admitted: undefined },
      { resume: true, admitted },
    ])
  })

  test("captures the durable admission before a failed wake settles", async () => {
    const admitted = { files: [{ uri: `ycoding-attachment://sha256/${"b".repeat(64)}`, name: "clipboard.png" }] }
    const captured: (typeof admitted)[] = []

    const result = await submitPrompt({
      prompt: async (resume) => {
        if (resume) throw new Error("wake disconnected")
        return admitted
      },
      onAdmitted: (receipt) => void captured.push(receipt),
    })

    expect(captured).toEqual([admitted])
    expect(result.admitted).toBe(admitted)
    expect(result.wakeError).toBeInstanceOf(Error)
    expect(result.wakeError?.message).toBe("wake disconnected")
  })
})
