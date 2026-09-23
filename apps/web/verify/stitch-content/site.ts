import { SITE } from "../../src/content/site"

// P09, export-adaptation/p09.html: landing hero and the four capability cards.
export const stitchSite = {
  ...SITE,
  hero: {
    ...SITE.hero,
    headline: "Your coding agent. Your machine.",
    support: "Work in the terminal. Continue from your browser.",
  },
  features: [
    {
      title: "Durable Sessions",
      text: "Long-running agent workflows persist seamlessly across connection drops, device switches, and system restarts.",
    },
    {
      title: "Explicit autonomy",
      text: "Set precise guardrails and permission tiers so your agent only takes actions you explicitly authorize.",
    },
    {
      title: "Tools and approvals",
      text: "Review and approve tool calls, code modifications, and terminal executions with clear interactive inspection.",
    },
    {
      title: "Remote access",
      text: "Securely monitor and control your agent execution environment from any browser wherever you are.",
    },
  ],
} as const

export { stitchSite as SITE }
