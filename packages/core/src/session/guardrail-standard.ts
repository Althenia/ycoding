export * as SessionGuardrailStandard from "./guardrail-standard"

export interface Match {
  readonly id: string
  readonly decision: "ask" | "deny"
  readonly reason: string
}

const catastrophic: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp; readonly reason: string }> = [
  {
    id: "standard.catastrophic.rm-root",
    pattern: /^\s*(?:sudo\s+)?rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:--\s+)?(?:\/|~|\$HOME)(?:\s|$)/i,
    reason: "Recursive deletion of a filesystem root or home directory",
  },
  {
    id: "standard.catastrophic.format-disk",
    pattern: /(?:^|\s)(?:mkfs(?:\.[a-z0-9]+)?|diskutil\s+eraseDisk|format\s+[a-z]:)(?:\s|$)/i,
    reason: "Filesystem or disk formatting",
  },
  {
    id: "standard.catastrophic.block-device-write",
    pattern: /(?:^|\s)dd\s+[^\n]*\bof=\/dev\/(?:disk|sd|nvme|vd)[^\s]*/i,
    reason: "Raw block-device write",
  },
  {
    id: "standard.catastrophic.fork-bomb",
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Unbounded process spawning",
  },
]

const reviews: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp; readonly reason: string }> = [
  {
    id: "standard.review.git-destructive",
    pattern: /(?:^|\s)git\s+(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--\s+\.|restore\s+[^\n]*--worktree)/i,
    reason: "Destructive Git operation",
  },
  {
    id: "standard.review.force-push",
    pattern: /(?:^|\s)git\s+push\s+[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)/i,
    reason: "Force push",
  },
  {
    id: "standard.review.publish",
    pattern: /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:publish|release)(?:\s|$)|(?:^|\s)docker\s+push(?:\s|$)/i,
    reason: "Package, release, or image publication",
  },
  {
    id: "standard.review.production",
    pattern: /(?:^|\s)(?:kubectl\s+[^\n]*(?:production|prod)|terraform\s+apply|helm\s+(?:install|upgrade)\s+[^\n]*(?:production|prod))/i,
    reason: "Production infrastructure mutation",
  },
  {
    id: "standard.review.database-destructive",
    pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table|delete\s+from\s+[^\s;]+\s*;?\s*$)/i,
    reason: "Destructive database operation",
  },
  {
    id: "standard.review.security-mutation",
    pattern: /(?:^|\s)(?:security\s+(?:add|delete)-generic-password|chmod\s+[^\n]*(?:777|a\+w)|ufw\s+(?:disable|reset)|iptables\s+-F)(?:\s|$)/i,
    reason: "Credential, access-control, or security-policy mutation",
  },
]

export function match(action: string, resource: string): Match | undefined {
  if (action === "mcp_execute")
    return {
      id: "standard.review.mcp-execute",
      decision: "ask",
      reason: `MCP process execution: ${resource}`,
    }
  if (action !== "shell") return
  const command = resource.replace(/\s+/g, " ").trim()
  const denied = catastrophic.find((rule) => rule.pattern.test(command))
  if (denied) return { ...denied, decision: "deny" }
  const review = reviews.find((rule) => rule.pattern.test(command))
  return review ? { ...review, decision: "ask" } : undefined
}
