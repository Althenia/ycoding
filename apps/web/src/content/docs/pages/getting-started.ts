import type { DocPage } from "../types"

export const gettingStartedPages: readonly DocPage[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    group: "Get started",
    description: "What YCoding is, where it runs, and which surfaces belong to the product today.",
    sections: [
      {
        heading: "What YCoding is",
        blocks: [
          {
            kind: "paragraph",
            text: "YCoding is a coding agent that runs in your terminal. Sessions, prompts, tool calls, file edits, shell commands, and model requests all happen on your machine, in the directory you started it from.",
          },
          {
            kind: "paragraph",
            text: "The terminal application is the primary surface. Sessions are durable: history, pending input, and orchestration survive restarts, so you can stop working and continue later.",
          },
        ],
      },
      {
        heading: "Core concepts",
        blocks: [
          {
            kind: "table",
            head: ["Concept", "What it means"],
            rows: [
              ["Session", "Durable intent, history, pending input, and execution state for one line of work."],
              ["Agent", "Configured behavior and model choice. Agents can be primary or run as background subagents."],
              ["Autonomy", "Whether YCoding asks before acting: standard, tiered YOLO levels, or an active goal."],
              ["Permission", "Ordered rules that allow, deny, or ask about one tool action on one resource."],
              ["Guardrail", "A session-family review of high-impact actions, independent of tool permissions."],
              ["Skill", "Reusable instructions you load into a session, from the repository or a shared source."],
              ["Project artifact", "Managed, versioned customization such as a skill, command, agent, or plugin."],
            ],
          },
        ],
      },
      {
        heading: "Where things live",
        blocks: [
          {
            kind: "table",
            head: ["Surface", "Files"],
            rows: [
              ["Runtime configuration", "`ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, `.ycoding/ycoding.jsonc`"],
              ["Terminal preferences", "`cli.json` in the YCoding config directory"],
              ["Managed service", "`service.json` (or the channel-specific file) in the YCoding config directory"],
              ["Repository customization", "`.ycoding/agents`, `.ycoding/commands`, `.ycoding/plugins`, `.ycoding/guardrails`, `.ycoding/themes`"],
              ["Instructions", "`AGENTS.md` at the project root and above the current directory"],
            ],
          },
          {
            kind: "callout",
            tone: "info",
            title: "One current format",
            text: "`tui.json`, `kv.json`, and `config.json` are not read. Runtime settings belong in the runtime files and terminal preferences in `cli.json`.",
          },
        ],
      },
      {
        heading: "Next steps",
        blocks: [
          {
            kind: "list",
            items: [
              "Install a release build and verify the checksum.",
              "Connect at least one provider so model requests can run.",
              "Start your first session and send a prompt.",
            ],
          },
          { kind: "related", slugs: ["installation", "quickstart", "usage/tui"] },
        ],
      },
    ],
  },
  {
    slug: "installation",
    title: "Installation",
    group: "Get started",
    description: "Install a checksum-verified YCoding release on macOS, Linux, or Windows and keep it updated.",
    sections: [
      {
        heading: "Install a release build",
        blocks: [
          {
            kind: "paragraph",
            text: "On macOS and Linux, the installer downloads the newest release, verifies its SHA-256 checksum, and installs the `ycoding` executable into `~/.local/bin`.",
          },
          { kind: "code", language: "sh", label: "macOS and Linux", code: "curl -fsSL https://ycoding.althenia.app/install.sh | sh" },
          {
            kind: "steps",
            items: [
              { title: "Open a new terminal", text: "The installer adds the binary directory to your shell PATH only when it is missing." },
              { title: "Check the version", text: "Run `ycoding --version` to confirm the installed release." },
              { title: "Connect a provider", text: "Add credentials for at least one provider before the first request." },
            ],
          },
          {
            kind: "paragraph",
            text: "On Windows x64, download the release ZIP from the repository releases page, extract `ycoding.exe`, and run it from a terminal.",
          },
        ],
      },
      {
        heading: "Run from source",
        blocks: [
          {
            kind: "paragraph",
            text: "A checkout runs directly with Bun 1.4.2. Source runs share the durable session database with an installed release only when they resolve the same data directory.",
          },
          { kind: "code", language: "sh", label: "From a checkout", code: "bun install --frozen-lockfile\nbun run dev" },
        ],
      },
      {
        heading: "Updates",
        blocks: [
          {
            kind: "paragraph",
            text: "`ycoding update` checks the release page, verifies the archive checksum and exact contents, and replaces an installed release.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Automatic update policy",
            code: '{ "autoupdate": "notify" }',
          },
          {
            kind: "table",
            head: ["Value", "Behavior"],
            rows: [
              ["`true`", "Install new releases automatically after the background service is running."],
              ["`notify`", "Report that an update exists without installing it."],
              ["`false`", "Disable the update check."],
            ],
          },
          {
            kind: "paragraph",
            text: "Major releases are never installed automatically. Development builds are rebuilt locally, and Windows binaries are replaced manually from the release ZIP.",
          },
        ],
      },
      {
        heading: "Requirements",
        blocks: [
          {
            kind: "list",
            items: [
              "macOS arm64 or x64, Linux x64, or Windows x64 for release builds.",
              "`curl`, `tar`, and `shasum` or `sha256sum` for the shell installer.",
              "Git for repository features such as worktrees and snapshots.",
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Keep a backup before major upgrades",
            text: "The first start after an upgrade may rebuild or reclaim database space, which needs free disk space and can take time on a large database.",
          },
          { kind: "related", slugs: ["getting-started", "quickstart", "configuration", "troubleshooting"] },
        ],
      },
    ],
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    group: "Get started",
    description: "Go from an installed binary to a first answer, then learn the prompts and reviews you will use most.",
    sections: [
      {
        heading: "First run",
        blocks: [
          { kind: "steps", items: [
            { title: "Start the terminal interface", text: "Run `ycoding` in the directory you want the agent to work in." },
            { title: "Connect a provider", text: "Use `/connect` or the command palette to store credentials for a provider." },
            { title: "Choose a model", text: "Pick a model when your provider exposes more than one." },
            { title: "Send a prompt", text: "Describe the outcome you want. Approvals appear inline when an action needs a decision." },
          ] },
        ],
      },
      {
        heading: "One direct run",
        blocks: [
          {
            kind: "paragraph",
            text: "For a single non-interactive answer, pass the model and the prompt on the command line. Direct runs share the same session execution and permission handling as the terminal interface.",
          },
          { kind: "code", language: "sh", label: "Direct run", code: 'ycoding --model <provider/model> "Explain this repository"' },
          {
            kind: "paragraph",
            text: "Non-interactive runs do not approve requests for you: anything still waiting for a permission, question, or guardrail answer is rejected and the run exits unsuccessfully.",
          },
        ],
      },
      {
        heading: "The prompts you will use first",
        blocks: [
          {
            kind: "table",
            head: ["Prompt", "Purpose"],
            rows: [
              ["`/goal <text>`", "Start tracked work toward one objective."],
              ["`/connect`", "Store credentials for a provider profile."],
              ["`/mcps`", "Inspect configured MCP servers and their status."],
            ],
          },
          {
            kind: "callout",
            tone: "tip",
            title: "Steer instead of waiting",
            text: "Send and steer now admits your prompt and interrupts the active step so the next boundary is immediate. The admitted prompt runs in the successor execution instead of waiting for a long step to finish.",
          },
        ],
      },
      {
        heading: "Where to go next",
        blocks: [
          { kind: "list", items: [
            "Learn the terminal surface: sessions, composer, approvals, and transcripts.",
            "Configure permissions before working in an unfamiliar repository.",
            "Add repository customization for agents, commands, and skills.",
          ] },
          { kind: "related", slugs: ["usage/tui", "usage/sessions", "configuration/permissions", "configuration/guardrails"] },
        ],
      },
    ],
  },
]
