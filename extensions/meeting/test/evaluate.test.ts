import { expect, test } from "bun:test"
import { speechAccuracy } from "../src/evaluate"

test("Thai character error and English terminology are evaluated independently", () => {
  expect(speechAccuracy("ต้อง rollback API", "ต้อง API")).toMatchObject({ thaiCER: 0, technicalTermRecall: 0.5 })
  expect(speechAccuracy("กข", "กค")).toMatchObject({ thaiCharacters: 2, thaiEdits: 1, thaiCER: 0.5 })
  expect(speechAccuracy("", "abc")).toMatchObject({ thaiCER: null, technicalTermRecall: null })
  expect(speechAccuracy("Redis", "Rediscovery").technicalTermRecall).toBe(0)
  expect(speechAccuracy("มาตรฐาน 802.11n API.", "802.11 API")).toMatchObject({
    technicalTerms: ["802.11n", "API"],
    technicalTermRecall: 0.5,
  })
})
