import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"
import { collapseToolOutput } from "../../src/util/collapse-tool-output"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const orphanMark = (value: string) =>
  Array.from(graphemes.segment(value), (item) => item.segment).filter((segment) =>
    /^[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]$/.test(segment),
  )

describe("thai combining-mark safety", () => {
  test("truncate never isolates a Thai vowel or tone mark", () => {
    for (const value of ["สวัสดีครับทุกคน", "น้ำที่ผู้ไม้เป็นข้าว", "เก้าไม้"]) {
      for (let len = 1; len <= 12; len++) {
        expect(orphanMark(Locale.truncate(value, len))).toEqual([])
        expect(orphanMark(Locale.truncateLeft(value, len))).toEqual([])
        expect(orphanMark(Locale.truncateMiddle(value, len))).toEqual([])
      }
    }
  })

  test("truncateMiddle keeps whole graphemes at the cut", () => {
    expect(Locale.truncateMiddle("สวัสดีครับทุกคน", 10)).toBe("สวัสดีค…ทุกคน")
  })

  test("truncateWidth and collapsed tool output keep whole graphemes", () => {
    expect(orphanMark(Locale.truncateWidth("สวัสดีครับทุกคน", 10))).toEqual([])
    expect(orphanMark(collapseToolOutput("สวัสดีครับทุกคนยินดีต้อนรับ", 4, 10).output)).toEqual([])
  })
})
