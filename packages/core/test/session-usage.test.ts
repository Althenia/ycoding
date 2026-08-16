import { Usage } from "@ycoding-ai/ai"
import { SessionUsage } from "@ycoding-ai/core/session/usage"
import { expect, test } from "bun:test"

test("preserves whether provider cache categories were reported", () => {
  expect(SessionUsage.providerCache(undefined)).toEqual({ readReported: false, writeReported: false })
  expect(
    SessionUsage.providerCache(
      new Usage({
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: undefined,
      }),
    ),
  ).toEqual({ readReported: true, writeReported: false })
  expect(
    SessionUsage.providerCache(
      new Usage({
        cacheReadInputTokens: undefined,
        cacheWriteInputTokens: 0,
      }),
    ),
  ).toEqual({ readReported: false, writeReported: true })
})
