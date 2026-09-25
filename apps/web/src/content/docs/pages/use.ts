import type { DocPage } from "../types"

export const usePages: readonly DocPage[] = [
  {
    slug: "usage",
    title: "Using YCoding",
    group: "Use",
    description: "Choose between the terminal interface and direct runs, and understand how work is tracked.",
    sections: [
      {
        heading: "Two ways to run",
        blocks: [
          {
            kind: "table",
            head: ["Surface", "Command", "When to use it"],
            rows: [
              ["Terminal interface", "`ycoding`", "Interactive work: prompts, approvals, terminals, subagents, and review."],
              ["Direct run", "`ycoding --model <provider/model> \"prompt\"`", "One prompt with no interactive approvals."],
              ["Run command", "`ycoding run`", "Scripted runs with explicit options such as `--yolo`."],
            ],
          },
          {
            kind: "paragraph",
            text: "Both paths share durable sessions, permission handling, and provider integration. A direct run can adopt an existing session by ID, so scripted work continues the same history.",
          },
        ],
      },
      {
        heading: "How work is tracked",
        blocks: [
          {
            kind: "list",
            items: [
              "One step is one logical model request. A step that overflows context may be rebuilt once after compaction.",
              "Tool activity has explicit start, running, and completed states, so a long command is visible instead of looking hung.",
              "Background subagents are durable child sessions. Their progress and questions reach the parent session.",
              "A pending guardrail review blocks the whole session family until you answer it, and it renders wherever it can block work.",
            ],
          },
        ],
      },
      {
        heading: "Context and compaction",
        blocks: [
          {
            kind: "paragraph",
            text: "YCoding estimates the model-visible input before each request. Soft pressure admits background compaction once at each advisory threshold; the hard cap admits mandatory compaction. Checkpoints replace covered history for the model while the stored transcript keeps every message.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Advisory thresholds",
            code: '{\n  "compaction": {\n    "keep_recent_messages": 20,\n    "context_safety_margin_tokens": 4096,\n    "advisory": { "consider_percent": 70, "strongly_advised_percent": 90 },\n  },\n}',
          },
        ],
      },
      {
        heading: "Related",
        blocks: [{ kind: "related", slugs: ["usage/tui", "usage/cli", "usage/sessions", "usage/remote"] }],
      },
    ],
  },
  {
    slug: "usage/tui",
    title: "Working in the terminal",
    group: "Use",
    description: "Sessions, the composer, approvals, terminals, and transcript behavior in the terminal interface.",
    sections: [
      {
        heading: "The session view",
        blocks: [
          {
            kind: "paragraph",
            text: "One session owns the screen: the transcript in the center, the rail for context and orchestration, and the composer at the bottom. The header reports the active model, autonomy state, and operational status.",
          },
          {
            kind: "list",
            items: [
              "The rail expands session, context, and todo sections by default; other sections stay collapsed until opened.",
              "Expand state is preserved when you navigate between the main transcript and a subagent chat.",
              "Assistant and compaction rows render Markdown; tool output collapses separately from message text.",
            ],
          },
        ],
      },
      {
        heading: "The composer",
        blocks: [
          {
            kind: "list",
            items: [
              "Prompts steer by default: they promote at the next safe step boundary while the current execution continues.",
              "Queued input waits until the session would otherwise become idle, then promotes one item at a time.",
              "Pasting an image attaches it as a managed attachment; a pasted file path that resolves to a supported type becomes an attachment too.",
              "While an admitted prompt is pending it shows a clock receipt; after promotion it shows one check; after a model request consumes it, two checks.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            title: "Cancelling a preparation is local",
            text: "`Cancel pending action` and Escape stop the local operation, such as reading the clipboard or waking an admitted prompt. They do not interrupt session execution.",
          },
        ],
      },
      {
        heading: "Approvals and reviews",
        blocks: [
          {
            kind: "paragraph",
            text: "A permission request asks about one tool action. A guardrail review asks about one high-impact action across the session family. Both keep their labels in a fixed row and accept keyboard or mouse selection.",
          },
          {
            kind: "table",
            head: ["Review", "Replies"],
            rows: [
              ["Permission", "`once`, `always` for the current session, or `reject`."],
              ["Guardrail", "`once`, `always` for exact matching asks in this process, or `reject`."],
              ["Hard guardrail", "`once` or `reject` only. Autonomy level and reusable approvals cannot settle it."],
            ],
          },
        ],
      },
      {
        heading: "Terminals, files, and browsers",
        blocks: [
          {
            kind: "list",
            items: [
              "Session-owned terminals open from the session command palette. Inspection is read-only until you take control explicitly.",
              "File changes are recorded per session with a diff summary.",
              "An optional Chrome extension attaches only to tabs you explicitly share; pairing is bound to one session.",
              "An isolated browser mode starts a temporary, credential-free browser for a session on supported machines.",
            ],
          },
          { kind: "related", slugs: ["usage/sessions", "configuration/permissions", "configuration/appearance"] },
        ],
      },
    ],
  },
  {
    slug: "usage/cli",
    title: "Command line",
    group: "Use",
    description: "Non-interactive runs, autonomy flags, update commands, and environment variables.",
    sections: [
      {
        heading: "Commands",
        blocks: [
          {
            kind: "table",
            head: ["Command", "Purpose"],
            rows: [
              ["`ycoding`", "Open the interactive terminal interface."],
              ["`ycoding --model <provider/model> \"prompt\"`", "Run one prompt without interaction."],
              ["`ycoding run --help`", "List explicit options for scripted runs."],
              ["`ycoding update`", "Verify and install the newest release."],
            ],
          },
        ],
      },
      {
        heading: "Autonomy flags",
        blocks: [
          {
            kind: "paragraph",
            text: "`ycoding run --yolo <0-3>` sets the durable session level before admitting the prompt. Omitting the flag preserves the autonomy of an adopted session.",
          },
          { kind: "code", language: "sh", label: "Explicit level", code: "ycoding run --yolo 2 \"Migrate the storage layer\"" },
          {
            kind: "callout",
            tone: "warning",
            title: "Non-interactive runs fail closed",
            text: "A run that still has a permission, question, or guardrail blocker rejects or cancels it and exits unsuccessfully. Hard guardrail reviews always require a human decision.",
          },
        ],
      },
      {
        heading: "Environment variables",
        blocks: [
          {
            kind: "table",
            head: ["Variable", "Effect"],
            rows: [
              ["`YCODING_CONFIG`", "Use one explicit runtime configuration file."],
              ["`YCODING_CONFIG_CONTENT`", "Inline runtime configuration with the highest priority."],
              ["`YCODING_CONFIG_DIR`", "Override the global configuration directory."],
              ["`YCODING_CONFIG_PROJECT_DISABLE`", "Disable project configuration discovery."],
              ["`YCODING_DB`", "Override the session database path."],
              ["`YCODING_LOG_LEVEL`", "Set the logging threshold."],
              ["`YCODING_PRINT_LOGS`", "Print logs to the terminal."],
              ["`YCODING_DISABLE_AUTOUPDATE`", "Disable update checks."],
            ],
          },
          {
            kind: "paragraph",
            text: "Build, packaging, and diagnostic variables are not user configuration, and their names may change between releases.",
          },
        ],
      },
      {
        heading: "Scripting advice",
        blocks: [
          {
            kind: "list",
            items: [
              "Pin the model explicitly so a session does not inherit a different default.",
              "Set the autonomy level explicitly instead of relying on an adopted session's state.",
              "Treat a non-zero exit as a blocking review rather than a completed run.",
            ],
          },
          { kind: "related", slugs: ["usage", "configuration/yolo", "configuration/permissions"] },
        ],
      },
    ],
  },
  {
    slug: "usage/remote",
    title: "Remote workspace",
    group: "Use",
    description: "What the remote workspace needs, what it can do once connected, and how its alerts behave.",
    sections: [
      {
        heading: "Current availability",
        blocks: [
          {
            kind: "callout",
            tone: "info",
            title: "What remote access does today",
            text: "The workspace at `/remote` controls sessions running on your own machine. Connecting an enrolled machine gives its signed-in owner access to all existing and future sessions on that backend. Select a session to work in its existing project folder. The workspace streams the conversation, sends prompts, answers permission, guardrail, and question requests, changes autonomy and goal state, and raises in-app and desktop alerts for live events. It needs a signed-in account and a connected device running YCoding; without them it shows the relevant account or connection state and never sample conversations.",
          },
          {
            kind: "paragraph",
            text: "Local execution stays authoritative: the agent, shell, files, tools, and model calls always run on your machine. A relay coordinates connections and forwards commands; it never runs your session.",
          },
        ],
      },
      {
        heading: "Prerequisites",
        blocks: [
          {
            kind: "list",
            items: [
              "YCoding running on the machine that owns the work.",
              "The device enrolled to your account with its own device key.",
              "A browser session signed in to the same account.",
            ],
          },
        ],
      },
      {
        heading: "Enrolling a machine",
        blocks: [
          {
            kind: "paragraph",
            text: "Sign in, open `/remote/settings`, and create an enrollment code. The page then shows the enrollment ID, the command to run on the machine, and the one-use code that command will ask for.",
          },
          {
            kind: "steps",
            items: [
              {
                title: "Run the enrollment command",
                text: "On the machine that owns the work, run the command shown in settings: `ycoding remote enroll <enrollmentID> --relay <origin>`. It includes this site's relay origin, so no prior relay configuration is required.",
              },
              {
                title: "Enter the one-use code",
                text: "The command prompts for the code, which is never a command argument: it stays out of your shell history, and it cannot be displayed again.",
              },
              {
                title: "Connect your sessions",
                text: "Run `ycoding remote connect` on the machine, then select that device and a session in the web workspace. All existing and future sessions on the connected backend are available to your account. Keep the command running while you work remotely.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "The workspace reports the account and the connection separately. No machine enrolled means the account is signed in and nothing is paired yet; a machine enrolled but not connected asks you to choose one. Neither state signs you out.",
          },
        ],
      },
      {
        heading: "What the workspace does",
        blocks: [
          {
            kind: "table",
            head: ["Area", "Behavior"],
            rows: [
              ["Devices", "List enrolled machines, their connection state, and last activity."],
              ["Session list", "Show all sessions on the connected backend, including running and archived state. New sessions appear while the device remains connected."],
              ["Conversation", "Load the canonical conversation for a session and stream new output as it arrives. The browser shows the first 4,000 characters of available tool text; device truncation is labeled separately, and shell captures can be loaded in pages."],
              ["Composer", "Send a prompt with an explicit delivery mode, and interrupt the active step."],
              ["Requests", "Answer permission, guardrail, question, and form requests. Forms support typed fields, defaults, conditional fields, and cancellation. External steps require your acknowledgement. Hard guardrail reviews accept only one-time approval or rejection."],
              ["Autonomy", "Read and change the session's autonomy state, including setting or stopping a goal."],
              ["Alerts", "Show an in-app notice for each enabled category, and a desktop alert when this browser is permitted."],
            ],
          },
        ],
      },
      {
        heading: "Notifications",
        blocks: [
          {
            kind: "paragraph",
            text: "The workspace alerts you to five categories: agent completed, approval requested, guardrail block, error or failure, and device disconnected. In `/remote/settings` each category has one switch for notices in the workspace and one for desktop alerts.",
          },
          {
            kind: "list",
            items: [
              "Alerts cover events that arrive while a session is subscribed. Loading history, reopening a session, or reconnecting never replays an alert for work that already happened.",
              "Desktop alerts use fixed, generic wording, so a notification that appears on a locked screen never shows a session title, command, file path, or error message.",
              "This browser is asked for notification permission only when you press the request button in settings, and desktop alerts stay silent until that permission is granted.",
              "Alerts appear only while this page is open: the workspace has no background push, so a closed browser tab receives nothing.",
              "The workspace keeps the newest notice for each category, and every notice can be dismissed.",
            ],
          },
        ],
      },
      {
        heading: "Reconnecting",
        blocks: [
          {
            kind: "list",
            items: [
              "A reconnect reloads the conversation read-only and re-subscribes to the session. Nothing is replayed automatically.",
              "An action that was in flight when the connection dropped is reported as an unknown outcome. Retry it deliberately if you want it sent again.",
              "Your unsent prompt stays with its Session when you switch conversations or reconnect; it does not appear in another Session's composer.",
            ],
          },
          { kind: "related", slugs: ["usage/sessions", "configuration/yolo", "configuration/notifications"] },
        ],
      },
    ],
  },
  {
    slug: "usage/sessions",
    title: "Sessions",
    group: "Use",
    description: "Durable admission, archive and unarchive, compaction, revert, and attachments.",
    sections: [
      {
        heading: "Durable admission",
        blocks: [
          {
            kind: "paragraph",
            text: "A prompt is written durably before execution is scheduled. The pending row represents work that has not been promoted yet; promotion into the visible transcript happens at a safe execution boundary.",
          },
          {
            kind: "list",
            items: [
              "Reusing a session ID adopts that session instead of creating another one.",
              "Reusing a prompt ID is accepted only for an exact retry with matching session, content, and delivery mode.",
              "A settled step that produced no assistant text and no tool continuation gets one bounded text-only recovery step.",
            ],
          },
        ],
      },
      {
        heading: "Managing the session list",
        blocks: [
          {
            kind: "paragraph",
            text: "Archive keeps a session visible with an `Archived` label and never deletes history or changes last-activity time. Unarchive clears the label.",
          },
          {
            kind: "callout",
            tone: "info",
            title: "No automatic deletion",
            text: "YCoding does not delete archived sessions on a timer. Startup may reclaim freed database pages, which never removes records.",
          },
        ],
      },
      {
        heading: "Compaction and revert",
        blocks: [
          {
            kind: "list",
            items: [
              "Compaction replaces covered history with a checkpoint for the model. Stored messages are never modified or deleted by selective compaction.",
              "The newest messages stay protected according to `compaction.keep_recent_messages`.",
              "Revert stages a boundary, optionally applies its file changes, and commits or clears the staged state.",
            ],
          },
        ],
      },
      {
        heading: "Attachments and terminals",
        blocks: [
          {
            kind: "list",
            items: [
              "Images and supported files are imported into a content-addressed attachment store with a 20 MiB input limit.",
              "Images are re-read for the provider; other file types are represented by their metadata and resolved path.",
              "Session-owned terminals keep their emulator across output reconnects, and input stays disabled until the replay is synchronized.",
            ],
          },
          { kind: "related", slugs: ["usage/tui", "usage/remote", "configuration/tools"] },
        ],
      },
    ],
  },
]
