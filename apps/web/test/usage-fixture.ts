import type { RemoteUsageBreakdown, RemoteUsageTaskCost } from "@ycoding-ai/remote"

export function accountedTask(sessionID = "ses_child", cost = 0.25, tokens = 20): RemoteUsageTaskCost {
  const total: RemoteUsageBreakdown = { requests: 1, tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { total: cost, known: cost, pricedRequests: 1, unpricedRequests: 0, provenance: "recorded" } }
  return { sessionID, status: "settled", attribution: "complete", history: "retained", total, main: total,
    children: { requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { pricedRequests: 0, unpricedRequests: 0 } }, helpers: [] }
}
