import { expect, test } from "bun:test"
import { questionAnswers } from "./review-box"

test("question decisions send one answer list per question in question order, empty when unanswered", () => {
  expect(questionAnswers(3, { q0: "main", q1: ["a", "b"] })).toEqual([["main"], ["a", "b"], []])
  expect(questionAnswers(1, { q0: "" })).toEqual([[]])
})
