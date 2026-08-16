import { describe, expect, test } from "bun:test"
import { parsePromptInfo } from "../../src/prompt/history"
import { promptSkillMentions, promptSkillMetadata, segmentPromptSkills } from "../../src/prompt/skill"
import { submitSessionPrompt } from "../../src/util/session-autonomy"
import { submitPromptWithSkills } from "../../src/component/prompt/skill-submission"

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

  test("admits the prompt before skills and never wakes after a partial activation", async () => {
    const calls: string[] = []
    const durable = new Set<string>()
    let failSecond = true
    const run = () =>
      submitSessionPrompt({
        prompt: async (resume) => calls.push(resume ? "wake" : "admit"),
        skills: ["msg_skill_1", "msg_skill_2"].map((id) => async () => {
          calls.push(id)
          durable.add(id)
          if (id === "msg_skill_2" && failSecond) {
            failSecond = false
            throw new Error("lost response")
          }
        }),
      })

    await expect(run()).rejects.toThrow("lost response")
    expect(calls).toEqual(["admit", "msg_skill_1", "msg_skill_2"])
    await run()

    expect(calls).toEqual(["admit", "msg_skill_1", "msg_skill_2", "admit", "msg_skill_1", "msg_skill_2", "wake"])
    expect([...durable]).toEqual(["msg_skill_1", "msg_skill_2"])
  })

  test("settles mentioned skill activations before admitting and waking the prompt", async () => {
    const calls: string[] = []
    let releaseSkill!: () => void
    const skillSettled = new Promise<void>((resolve) => (releaseSkill = resolve))

    const submission = submitPromptWithSkills({
      prompt: async (resume) => calls.push(resume ? "prompt:wake" : "prompt:admit"),
      skills: [
        async () => {
          calls.push("skill:review")
          await skillSettled
          calls.push("skill:settled")
        },
      ],
    })

    await Bun.sleep(0)
    expect(calls).toEqual(["skill:review"])
    releaseSkill()
    await submission
    expect(calls).toEqual(["skill:review", "skill:settled", "prompt:admit", "prompt:wake"])
  })

  test("returns the first durable admission and supplies it to the exact wake retry", async () => {
    const admitted = { files: [{ uri: `ycoding-attachment://sha256/${"a".repeat(64)}`, name: "clipboard.png" }] }
    const calls: Array<{ resume: boolean; admitted?: unknown }> = []

    const result = await submitPromptWithSkills({
      prompt: async (resume, durable) => {
        calls.push({ resume, admitted: durable })
        return resume ? { ignored: true } : admitted
      },
      skills: [],
    })

    expect(result).toBe(admitted)
    expect(calls).toEqual([
      { resume: false, admitted: undefined },
      { resume: true, admitted },
    ])
  })
})
