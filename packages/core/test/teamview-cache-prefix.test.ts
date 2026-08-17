import { expect, test } from "bun:test"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"

const input = {
  projectID: "project",
  directory: "/repo",
  workspaceID: "workspace",
  providerID: "github-copilot",
  modelID: "gpt-5.6",
  apiModelID: "gpt-5.6",
  variant: "default",
  policyRevision: CACHE_POLICY_REVISION,
  permissions: [{ action: "read", resource: "**", effect: "allow" }] satisfies PermissionV2.Ruleset,
  system: [],
  tools: [],
  sessionID: "session",
  routeID: "github-copilot-responses",
}

test("rotates Copilot prompt-cache keys by generation", () => {
  const first = SessionRunnerCache.providerOptions({ ...input, generation: 0 })
  const second = SessionRunnerCache.providerOptions({ ...input, generation: 1 })

  expect(second.promptCacheKey).not.toBe(first.promptCacheKey)
  expect(second.providerOptions.openai.promptCacheKey).toBe(second.promptCacheKey)
})
