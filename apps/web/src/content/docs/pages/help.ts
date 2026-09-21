import type { DocPage } from "../types"

export const helpPages: readonly DocPage[] = [
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    group: "Help",
    description: "Resolve configuration discovery, provider, database, and terminal problems with concrete checks.",
    sections: [
      {
        heading: "A setting has no effect",
        blocks: [
          {
            kind: "list",
            ordered: true,
            items: [
              "Check that the file is a supported source: runtime settings belong in `ycoding.json` or `ycoding.jsonc`, terminal preferences in `cli.json`.",
              "Check for a rejected key. A document containing one rejected key is ignored in full, so nothing in that file applies.",
              "Check precedence. A project file overrides a global file, and inline configuration overrides both.",
              "Check that the process is reading the file you edited when `YCODING_CONFIG` or `YCODING_CONFIG_DIR` is set.",
            ],
          },
          {
            kind: "callout",
            tone: "tip",
            title: "See the discovery warnings",
            text: "Run with `--log-level all` and `YCODING_PRINT_LOGS=1` to print each accepted and rejected configuration document.",
          },
        ],
      },
      {
        heading: "A model request fails",
        blocks: [
          {
            kind: "list",
            items: [
              "Confirm the provider's credential variable name is listed in `providers.<id>.env` and that the variable holds a value.",
              "Confirm the selected model exists in the effective catalog; a model selector that cannot resolve fails before any request.",
              "A rate limit or transport failure is retried up to ten physical attempts with backoff while no output exists. After output, the step closes and a new one continues instead of replaying.",
              "A context overflow rebuilds the request once after compaction. A second overflow closes the step as an error, and the message names the cause.",
            ],
          },
        ],
      },
      {
        heading: "The terminal looks stuck",
        blocks: [
          {
            kind: "list",
            items: [
              "A pending permission or guardrail review pauses the composer and renders a row; answer or reject it to continue.",
              "A shell command is bounded: a foreground command still running after 300,000 ms moves to the background and still reports its eventual result.",
              "A tool that never settles can be cancelled, and interruption closes the active step durably.",
            ],
          },
        ],
      },
      {
        heading: "Database and startup problems",
        blocks: [
          {
            kind: "list",
            items: [
              "The first start after an upgrade may rebuild or reclaim database space; this needs free disk space and can take time.",
              "If startup cannot obtain the database lock within its busy timeout it fails rather than silently skipping the step, and the next start retries.",
              "A managed-service port conflict is not fixed by deleting session data. Change the port in the channel service file or use `ycoding --standalone`.",
              "Keep a backup before a large upgrade, and close other writers during the first start.",
            ],
          },
        ],
      },
      {
        heading: "Remote workspace is empty",
        blocks: [
          {
            kind: "paragraph",
            text: "The remote workspace shows real sessions only. Check whether your account is signed in, your machine is enrolled, and `ycoding remote connect` is running there. Select an online machine to see its sessions. If that backend has no sessions yet, start YCoding in your project folder on that machine. An offline device does not mean its sessions were deleted.",
          },
          {
            kind: "list",
            ordered: true,
            items: [
              "Sign in and confirm the account has an enrolled device.",
              "Start YCoding on that machine and confirm it reports as connected.",
              "Select the device in the workspace header, then choose a session from the list.",
            ],
          },
          { kind: "related", slugs: ["usage/remote", "configuration", "configuration/tools"] },
        ],
      },
    ],
  },
]
