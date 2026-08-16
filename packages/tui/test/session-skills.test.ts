import { describe, expect, test } from "bun:test"
import { filterSessionSkills, groupSessionSkills, sessionSkillContent, sessionSkillLabel } from "../src/util/session-skills"

const dialogSessionSkills = await Bun.file(new URL("../src/component/dialog-session-skills.tsx", import.meta.url)).text()
const sessionRoute = await Bun.file(new URL("../src/routes/session/index.tsx", import.meta.url)).text()

const skills = [
  {
    id: "review",
    name: "Code Review",
    activatedBy: "reference" as const,
    activationMessageID: "msg_1",
    content: "Review instructions",
    conflicts: [],
    declarations: {},
    state: "inactive" as const,
    inactiveReason: "compacted" as const,
  },
  {
    id: "plan",
    name: "Plan",
    activatedBy: "tool" as const,
    activationMessageID: "msg_2",
    content: "Plan instructions",
    conflicts: [{ type: "skill" as const, id: "review", name: "Code Review" }],
    declarations: {},
    state: "active" as const,
  },
  {
    id: "test",
    name: "Testing",
    activatedBy: "tool" as const,
    activationMessageID: "msg_3",
    content: "Test instructions",
    conflicts: [],
    declarations: {},
    state: "inactive" as const,
    inactiveReason: "agent_switched" as const,
  },
]

describe("session skill presentation", () => {
  test("groups active skills before inactive skills while preserving server order", () => {
    expect(groupSessionSkills(skills)).toEqual({
      active: [skills[1]],
      inactive: [skills[0], skills[2]],
    })
  })

  test("filters skill IDs and names without case sensitivity", () => {
    expect(filterSessionSkills(skills, "CODE")).toEqual([skills[0]])
    expect(filterSessionSkills(skills, "missing")).toEqual([])
  })

  test("formats active conflicts and inactive boundaries", () => {
    expect(sessionSkillLabel(skills[1])).toBe("ACTIVE - CONFLICT")
    expect(sessionSkillLabel(skills[0])).toBe("INACTIVE - COMPACTED")
    expect(sessionSkillLabel(skills[2])).toBe("INACTIVE - AGENT SWITCH")
  })

  test("keeps exact string content and discards non-string tool output", () => {
    expect(sessionSkillContent("\nExact skill content\n")).toBe("\nExact skill content\n")
    expect(sessionSkillContent(undefined)).toBe("")
  })

  test("renders skill details in a bounded scrollbox with keyboard expansion", () => {
    expect(dialogSessionSkills).toContain("<scrollbox")
    expect(dialogSessionSkills).toContain('height={height()}')
    expect(dialogSessionSkills).toContain('bind: "return"')
    expect(dialogSessionSkills).toContain('bind: "space"')
  })

  test("highlights loaded skill badges with the skill accent", () => {
    expect(sessionRoute).toContain("status={<StatusBadge color={accent()}>Loaded</StatusBadge>}")
    expect(sessionRoute).toContain(
      'status={props.part.state.status === "completed" ? <StatusBadge color={accent()}>Loaded</StatusBadge> : undefined}',
    )
    expect(sessionRoute).toContain("function StatusBadge(props: { children: string; color?: RGBA })")
  })

  test("hides only completed duplicate Skill tool parts", () => {
    expect(sessionRoute).toContain(
      'recordValue(recordValue((content as SessionMessageAssistantTool).state)?.structured)?.alreadyActive !== true',
    )
  })
})
