import { describe, expect, test } from "bun:test"
import {
  autocompleteTriggerIndex,
  displayCharAt,
  displaySlice,
  mentionTriggerIndex,
  promptCommandPalette,
  skillTriggerIndex,
} from "../../src/prompt/display"

describe("prompt display", () => {
  test("uses display-width offsets for mentions", () => {
    expect(mentionTriggerIndex("@")).toBe(0)
    expect(mentionTriggerIndex("test @")).toBe(5)
    expect(mentionTriggerIndex("中文 @")).toBe(5)
    expect(mentionTriggerIndex("こんにちは @")).toBe(11)
    expect(mentionTriggerIndex("한국어 @")).toBe(7)
    expect(mentionTriggerIndex("🙂 @")).toBe(3)
    expect(mentionTriggerIndex("中文 @src file", Bun.stringWidth("中文 @src"))).toBe(5)
    expect(displayCharAt("中文 @src", Bun.stringWidth("中文 @"))).toBe("s")
    expect(displaySlice("中文 @src", 5, Bun.stringWidth("中文 @src"))).toBe("@src")
    expect(displaySlice("中文 @src", 6, Bun.stringWidth("中文 @src"))).toBe("src")
    expect(mentionTriggerIndex("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe(3)
    expect(displayCharAt("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @"))).toBe("s")
    expect(displaySlice("👨‍👩‍👧‍👦 @src", 3, Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe("@src")
    expect(mentionTriggerIndex("@file1\n@file2", 13)).toBe(7)
    expect(displayCharAt("@file1\n@file2", 6)).toBe("\n")
    expect(displaySlice("@file1\n@file2", 8, 13)).toBe("file2")
    expect(mentionTriggerIndex("@file1\nfoo @file2", 17)).toBe(11)
    expect(mentionTriggerIndex("中文 @one\n@two", 14)).toBe(10)
    expect(displaySlice("中文 @one\n@two", 11, 14)).toBe("two")
    expect(mentionTriggerIndex("中文@")).toBeUndefined()
    expect(mentionTriggerIndex("こんにちは@")).toBeUndefined()
    expect(mentionTriggerIndex("한국어@")).toBeUndefined()
    expect(mentionTriggerIndex("🙂@")).toBeUndefined()
    expect(mentionTriggerIndex("hello@")).toBeUndefined()
    expect(mentionTriggerIndex("foo@bar.com")).toBeUndefined()
    expect(mentionTriggerIndex("中文 @src file")).toBeUndefined()
  })

  test("recognizes triggers after opening punctuation", () => {
    expect(mentionTriggerIndex("see (@src")).toBe(5)
    expect(mentionTriggerIndex("see [@src")).toBe(5)
    expect(mentionTriggerIndex('see "@src')).toBe(5)
    expect(mentionTriggerIndex("diff: @src")).toBe(6)
    expect(skillTriggerIndex("run ($review")).toBe(5)
    // Word characters, path separators, and emoji must still not open a menu.
    expect(mentionTriggerIndex("hello@")).toBeUndefined()
    expect(mentionTriggerIndex("🙂@")).toBeUndefined()
    expect(mentionTriggerIndex("src/@")).toBeUndefined()
    expect(mentionTriggerIndex("foo.@")).toBeUndefined()
  })
  test("recognizes skill triggers only at token boundaries", () => {
    expect(skillTriggerIndex("$review")).toBe(0)
    expect(skillTriggerIndex("use $review")).toBe(4)
    expect(skillTriggerIndex("use $review now")).toBeUndefined()
    expect(skillTriggerIndex("email$review")).toBeUndefined()
    expect(skillTriggerIndex("$review\n$plan", 12)).toBe(8)
  })

  test("revalidates mention and skill menus from the cursor", () => {
    expect(autocompleteTriggerIndex("$skill", 6, "$")).toBe(0)
    expect(autocompleteTriggerIndex("$skill", 0, "$")).toBeUndefined()
    expect(autocompleteTriggerIndex("$skill later", 12, "$")).toBeUndefined()
    expect(autocompleteTriggerIndex("use @file", 9, "@")).toBe(4)
    expect(autocompleteTriggerIndex("use @file", 4, "@")).toBeUndefined()
  })

  test("defaults omitted palette visibility while preserving explicit hidden values", () => {
    expect(promptCommandPalette({})).toBe(true)
    expect(promptCommandPalette({ palette: true })).toBe(true)
    expect(promptCommandPalette({ palette: false })).toBeUndefined()
    expect(promptCommandPalette({ palette: undefined })).toBeUndefined()
  })
})
