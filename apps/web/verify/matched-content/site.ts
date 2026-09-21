import { SITE } from "../../src/content/site"

const matchedSite = {
  ...SITE,
  descriptor: "terminal coding agent",
  description:
    "An agent that runs on your machine. Sessions, prompts, tool calls, and file edits all happen where the code already is.",
  hero: {
    ...SITE.hero,
    eyebrow: ["AI agents", "your machine", "anywhere"],
    headline: "Your coding agent, wherever you are.",
    support: [
      "Work with AI agents on your own machine. Same environment. Same tools. Same session history.",
      "Pick up the same session from a phone or another machine through Remote.",
    ],
  },
  installing: { ...SITE.installing, command: "brew install ycoding" },
  trust: [
    { title: "Your data stays local", text: "Sessions, prompts, and file edits stay in the directory you started in." },
    { title: "Durable sessions", text: "History, pending input, and orchestration survive restarts." },
    { title: "Explicit autonomy", text: "Guardrail reviews keep high-impact actions with a human." },
  ],
  remoteStatus: {
    title: "Remote access",
    body: "the same session, from another device. Nothing is mirrored, and nothing leaves your machine.",
    cta: { label: "How it works", href: "/docs/usage/remote" },
  },
  footerColumns: [
    {
      title: "Product",
      links: [
        { label: "Docs", href: "/docs" },
        { label: "Changelog", href: "/changelog" },
        { label: "Open Remote", href: "/remote" },
      ],
    },
    {
      title: "Install",
      links: [
        { label: "macOS", href: "/docs/installation" },
        { label: "Linux", href: "/docs/installation" },
        { label: "Windows", href: "/docs/installation" },
      ],
    },
    {
      title: "Repository",
      links: [
        { label: "Source", href: SITE.repositoryURL },
        { label: "Releases", href: SITE.releasesURL },
        { label: "Issues", href: `${SITE.repositoryURL}/issues` },
      ],
    },
  ],
} as const

export { matchedSite as SITE }
