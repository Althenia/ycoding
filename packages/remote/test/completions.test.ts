import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  CompletionsSchema,
  BlockedSchema,
  encodeLossless,
  decodeLossless,
} from "@ycoding-ai/protocol/v5"

test("typed completions preserve exact uint64 sequence, title and baseline paging", () => {
  const value = create(CompletionsSchema, {
    items: [
      {
        id: "evt_1",
        sequence: 18446744073709551615n,
        createdMs: 123n,
        sessionId: "ses_root",
        title: encodeLossless("Approval"),
      },
    ],
    more: true,
  })
  const result = decodeStrict(CompletionsSchema, encodeStrict(CompletionsSchema, value))
  expect(result.items[0]!.sequence).toBe(18446744073709551615n)
  expect(decodeLossless(result.items[0]!.title!)).toBe("Approval")
  expect(result.more).toBe(true)
  expect(() =>
    encodeStrict(
      CompletionsSchema,
      create(CompletionsSchema, { items: Array.from({ length: 201 }, () => value.items[0]!), more: false }),
    ),
  ).toThrow()
})

test("blocked controls retain optional bounded titles and reject controls/bidi", () => {
  expect(
    decodeStrict(BlockedSchema, encodeStrict(BlockedSchema, create(BlockedSchema, { sessionId: "ses_root" }))).title,
  ).toBeUndefined()
  for (const title of [" ", "x".repeat(121), "unsafe\ntext", "unsafe\u202etext"])
    expect(() =>
      encodeStrict(BlockedSchema, create(BlockedSchema, { sessionId: "ses_root", title: encodeLossless(title) })),
    ).toThrow()
})
