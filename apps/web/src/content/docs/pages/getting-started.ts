import type { DocPage } from "../types"

export const gettingStartedPages: readonly DocPage[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    group: "Get started",
    description: "Understand where YCoding runs, install it, connect a model provider, and start your first session.",
    sections: [
      {
        heading: "What YCoding is",
        blocks: [
          {
            kind: "paragraph",
            text: "YCoding is a coding agent that runs in your terminal. Its agent, repository access, file edits, shell commands, tools, and model requests run in the local YCoding process on your machine.",
          },
          {
            kind: "paragraph",
            text: "The terminal interface is the primary product surface. A Session keeps its conversation and pending work so you can return to a project later. The optional remote workspace controls those same local Sessions from a browser; it is not a hosted agent runtime.",
          },
          {
            kind: "table",
            head: ["Concept", "What it means"],
            rows: [
              ["Session", "Durable conversation, pending input, and execution state for one piece of work."],
              ["Agent", "Configured behavior and model choice; subagents run as background child Sessions."],
              ["Permission", "An ordered rule that allows, denies, or asks about a tool action on a resource."],
              ["Guardrail", "A separate review of high-impact actions across the Session family."],
              ["Autonomy", "The Session's Autonomous modes (Manual, YOLO, or Auto for permissions, guardrails, and answers), sleep state, and any active goal."],
            ],
          },
        ],
      },
      {
        heading: "Before you begin",
        blocks: [
          {
            kind: "list",
            items: [
              "Use a supported release platform: macOS arm64 or x64, or Linux x64. Windows release builds are paused until the native runtime supports Windows.",
              "Have credentials for a model provider you can use. YCoding's `/connect` flow stores a provider profile; provider access and model availability come from that provider.",
              "Start YCoding in the repository or project folder you want to work in. The current directory supplies the local project context.",
            ],
          },
          { kind: "related", slugs: ["installation", "configuration/providers"] },
        ],
      },
      {
        heading: "Choose how to work",
        blocks: [
          {
            kind: "table",
            head: ["Surface", "Start with", "Use it for"],
            rows: [
              ["Terminal interface", "`ycoding`", "Interactive prompts, approvals, Sessions, and ongoing repository work."],
              ["Direct run", "`ycoding --model openai/gpt-4o-mini \"Explain this repository\"`", "A single non-interactive prompt with a selected model."],
              ["Remote workspace", "`ycoding remote connect`", "Browser access to existing and future Sessions on an enrolled local machine."],
            ],
          },
          {
            kind: "callout",
            tone: "info",
            title: "Run in the project folder",
            text: "For example, change to the repository directory before running `ycoding`. The remote workspace also works with Sessions created on that machine; it does not let a browser choose an arbitrary folder.",
          },
          {
            kind: "paragraph",
            text: "Open `/remote` for a device running Bun 0.12.x or `/remote/rust` for a device running Rust. Both remote workspaces use the same Web sign-in.",
          },
        ],
      },
      {
        heading: "Next steps",
        blocks: [
          {
            kind: "steps",
            items: [
              { title: "Install YCoding", text: "Choose your operating system in Installation and confirm `ycoding --version` reports an installed version." },
              { title: "Connect a provider", text: "Start `ycoding`, run `/connect`, and follow the provider's sign-in or credential prompts." },
              { title: "Send a focused task", text: "Describe a result, relevant files, and any constraints. Resolve any permission or guardrail review shown before work can continue." },
            ],
          },
          { kind: "related", slugs: ["installation", "quickstart", "usage/tui", "usage/sessions"] },
        ],
      },
      {
        heading: "Documentation for AI agents",
        blocks: [
          {
            kind: "paragraph",
            text: "The public site publishes its user documentation as Markdown as well as web pages. `https://ycoding.althenia.app/llms.txt` indexes every published documentation page with its description; `https://ycoding.althenia.app/llms-full.txt` contains the published pages in registry order. The documentation overview is `https://ycoding.althenia.app/docs/index.md`, and each page has a Markdown copy such as `https://ycoding.althenia.app/docs/quickstart.md`.",
          },
          {
            kind: "code",
            language: "text",
            label: "Give an AI agent the documentation index",
            code: "Read https://ycoding.althenia.app/llms.txt first. Follow its links to the pages relevant to my task, then use those pages as the source for YCoding commands and behavior.",
          },
          {
            kind: "paragraph",
            text: "Use the index when an agent needs to discover relevant topics; use the full file when it needs the complete published documentation in one fetch.",
          },
        ],
      },
    ],
  },
  {
    slug: "installation",
    title: "Installation",
    group: "Get started",
    description: "Install a verified YCoding release on macOS or Linux and learn how updates work.",
    sections: [
      {
        heading: "Requirements",
        blocks: [
          {
            kind: "table",
            head: ["Platform", "Release target", "Install method"],
            rows: [
              ["macOS Apple silicon", "arm64", "Shell installer or release archive."],
              ["macOS Intel", "x64", "Shell installer or release archive."],
              ["Linux", "x64", "Shell installer or release archive."],
            ],
          },
          {
            kind: "paragraph",
            text: "The macOS and Linux shell installer needs `curl`, `tar`, and either `shasum` or `sha256sum`. Release installation does not require Bun.",
          },
        ],
      },
      {
        heading: "Install on macOS or Linux",
        blocks: [
          {
            kind: "paragraph",
            text: "On a new installation, the installer selects the highest stable release version. It verifies the Rust archive checksum and installs `ycoding` in `~/.local/bin`. It adds that directory to a recognized shell profile only when needed; if your shell is not recognized, add it to PATH yourself.",
          },
          { kind: "code", language: "sh", label: "macOS or Linux x64", code: "curl -fsSL https://ycoding.althenia.app/install.sh | sh" },
          {
            kind: "steps",
            items: [
              { title: "Run the installer", text: "Paste the command above into a terminal. It supports macOS arm64/x64 and Linux x64; it prints the installed version and destination when it succeeds." },
              { title: "Apply PATH changes", text: "If the installer updated a shell profile, open a new terminal so it reads the updated PATH." },
              { title: "Verify the executable", text: "Run `ycoding --version`. The command prints the version of the installed release." },
            ],
          },
          {
            kind: "code",
            language: "text",
            label: "Expected installer output",
            code: "Installed ycoding <version> to <home>/.local/bin/ycoding",
          },
          { kind: "code", language: "sh", label: "Verify the installed version", code: "ycoding --version" },
          {
            kind: "paragraph",
            text: "Expected result: the command exits successfully and prints `ycoding` followed by the installed version. If the shell reports that `ycoding` is not found, open a new terminal after the PATH update or add `$HOME/.local/bin` to PATH, then retry.",
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Review the installer before running it",
            text: "The shell command downloads and runs the published installer. If you prefer to inspect or verify assets yourself, download the matching archive and checksum file from GitHub Releases and follow the release's published checksums.",
          },
          {
            kind: "paragraph",
            text: "The macOS release signs the CLI and the `YCoding Interaction.app` helper with the same YCoding release certificate. The shell installer verifies both before installing either. This self-signed certificate is not an Apple Developer ID, and the package is not notarized. For a browser download, verify the archive against the release checksum before clearing its quarantine attribute.",
          },
          { kind: "code", language: "sh", label: "Clear quarantine on a browser-downloaded macOS archive", code: "xattr -dr com.apple.quarantine <extracted-folder>" },
        ],
      },
      {
        heading: "Update an installation",
        blocks: [
          {
            kind: "callout",
            tone: "warning",
            title: "Keep an existing Bun installation",
            text: "The default installer refuses to replace an existing Bun executable or start over when it finds Bun data and no Rust store. GitHub Latest stays on Bun 0.12.2, so the existing Bun updater stays on Bun. You can also choose Bun explicitly with the downloaded shell installer.",
          },
          { kind: "code", language: "sh", label: "Stay on Bun", code: "YCODING_VERSION=0.12.2 sh install.sh" },
          {
            kind: "paragraph",
            text: "To switch to Rust, let active Sessions finish and pass `--replace-bun` to the downloaded installer. Rust uses its own `core.redb` store. It leaves Bun's SQLite database on disk and does not import its Sessions or Usage.",
          },
          { kind: "code", language: "sh", label: "Replace Bun with a clean Rust install", code: "sh install.sh --replace-bun" },
          {
            kind: "paragraph",
            text: "On macOS or Linux, use `ycoding update` to update an existing Rust installation. Without `--version` it does not install a release older than the one running. It verifies the archive checksum and contents before replacement. On macOS it also verifies the signatures on the CLI and the Interaction helper. On Windows, close YCoding and replace it with the contents of the release ZIP.",
          },
          { kind: "code", language: "sh", label: "Install the newest release", code: "ycoding update" },
          {
            kind: "code",
            language: "sh",
            label: "Install one published version",
            code: "ycoding update --version 0.13.0",
          },
          {
            kind: "paragraph",
            text: "Expected result: YCoding prints `Updated ycoding to <version>` after a successful replacement, or reports that the installed version is already up to date. After a replacement it restarts a running background server that has no Session work outstanding and prints `Restarted the background server`; with no server running it says there is nothing to restart, and with Sessions that have running work it leaves the server running and tells you to run `ycoding service restart` once they finish. If the restart fails, the update stays installed and the command reports the failure and exits with status 1. If the command says self-update is unavailable, the executable is a local development build; install a release build instead. If checksum validation or download fails, the installed executable is left in place; check network access and retry the explicit update command.",
          },
          {
            kind: "table",
            head: ["Update setting", "Effect"],
            rows: [
              ["`autoupdate` omitted, `true`, or `\"notify\"`", "A background check may announce an update; it does not install it."],
              ["`autoupdate: false`", "Disable the background update notice."],
              ["`YCODING_DISABLE_AUTOUPDATE=1`", "Disable update checks for the process."],
            ],
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Disable update notices in ycoding.jsonc",
            code: '{ "autoupdate": false }',
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Back up before changing editions",
            text: "Keep the Bun database and the Bun release package if you may need to switch back. Rust Sessions stay in the Rust store and do not appear in Bun.",
          },
          { kind: "related", slugs: ["getting-started", "quickstart", "configuration", "troubleshooting"] },
        ],
      },
      {
        heading: "Run from a source checkout",
        blocks: [
          {
            kind: "paragraph",
            text: "For development, install a current Bun release, change to the YCoding repository checkout, install the locked dependencies, and start the development command. This is a source run, not a native release installation.",
          },
          { kind: "code", language: "sh", label: "From the repository root", code: "bun install --frozen-lockfile\nbun run dev" },
          {
            kind: "paragraph",
            text: "Expected result: the YCoding terminal interface starts from the checkout. If the command reports a Bun or dependency error, use a current Bun release and run both commands from the repository root; rerun `bun install --frozen-lockfile` after changing Bun versions.",
          },
          { kind: "related", slugs: ["getting-started", "quickstart"] },
        ],
      },
    ],
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    group: "Get started",
    description: "Connect a provider, start an interactive Session, then make a direct run from your project folder.",
    sections: [
      {
        heading: "Before the first prompt",
        blocks: [
          {
            kind: "list",
            items: [
              "Install YCoding and open a terminal in the project folder you want it to work in.",
              "Have credentials for a model provider and choose a model available to your account.",
              "Keep the interactive terminal interface open while you review any requests that need your decision.",
            ],
          },
        ],
      },
      {
        heading: "Start an interactive Session",
        blocks: [
          {
            kind: "steps",
            items: [
              { title: "Open YCoding", text: "Run `ycoding` in the target project directory. The terminal interface opens a Session there." },
              { title: "Connect a provider", text: "Enter `/connect` in the composer and complete the provider connection flow. Credentials are stored as a named provider profile." },
              { title: "Send a task", text: "Describe the change or question in the composer and submit it. Prompts steer the current Session at a safe step boundary by default." },
              { title: "Resolve reviews", text: "If an action needs a permission or guardrail decision, inspect the request and choose an available response in the terminal interface." },
            ],
          },
          {
            kind: "paragraph",
            text: "Expected result: the Session transcript shows your prompt and the agent's response. Tool activity and reviews appear in the Session rather than being hidden in a separate console.",
          },
        ],
      },
      {
        heading: "Run one direct prompt",
        blocks: [
          {
            kind: "paragraph",
            text: "For a single non-interactive run, select an available model using the `provider/model` form and provide a prompt. This example uses the OpenAI model ID shown in the repository's provider tests; replace it with a model exposed by the provider profile you connected.",
          },
          { kind: "code", language: "sh", label: "Interactive and direct commands", code: 'ycoding\n\n# Or run one prompt and print the answer in this terminal\nycoding --model openai/gpt-4o-mini "Explain this repository"' },
          {
            kind: "paragraph",
            text: "Expected result: the assistant response is written to the terminal. Its text depends on the prompt and model, so YCoding does not promise a fixed response. Direct runs do not pause for interactive approval; a request left waiting for a permission, question, or guardrail answer is rejected and the run exits unsuccessfully.",
          },
          {
            kind: "table",
            head: ["Option", "Purpose"],
            rows: [
              ["`--model <[profile#]provider/model[#variant]>`", "Choose a model, optionally with a named profile and a model variant."],
              ["`--continue` or `-c`", "Continue the last Session."],
              ["`--session <id>` or `-s <id>`", "Continue a specific Session."],
              ["`--file <path>` or `-f <path>`", "Attach a file to the prompt; repeat for more files."],
              ["`--format json`", "Emit the result using the JSON output format."],
            ],
          },
        ],
      },
      {
        heading: "Continue learning",
        blocks: [
          {
            kind: "list",
            items: [
              "Use `/goal <text>` when you want to set an explicit objective for continued work; inspect and stop the goal through the Session controls.",
              "Use `/connect` to add or change a provider profile. A provider profile determines which stored credential is active for that provider.",
              "Use `ycoding run --help` to see the run command's options before writing a script around it.",
            ],
          },
          {
            kind: "callout",
            tone: "tip",
            title: "Steer or queue additional work",
            text: "Interactive prompts steer at the next safe step boundary by default. Use the Session's queue action when you want new input to wait until the Session would otherwise become idle.",
          },
          { kind: "related", slugs: ["usage/tui", "usage/sessions", "usage/cli", "configuration/providers", "configuration/permissions", "configuration/guardrails"] },
        ],
      },
    ],
  },
]
