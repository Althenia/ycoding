/// <reference path="../markdown.d.ts" />

export * as AgentPlugin from "./agent"

import path from "path"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { PermissionV2 } from "../permission"
import tldrContent from "./agent/TLDR.md" with { type: "text" }
import architechContent from "./agent/architech.md" with { type: "text" }
import godContent from "./agent/god.md" with { type: "text" }
import occamContent from "./agent/occam.md" with { type: "text" }
import omoikaneContent from "./agent/omoikane.md" with { type: "text" }
import wittgensteinContent from "./agent/wittgenstein.md" with { type: "text" }
import yangiContent from "./agent/yangi.md" with { type: "text" }
import zeusContent from "./agent/zeus.md" with { type: "text" }

// Combined output files written by the Shell service, e.g. `<data>/shell/<projectID>/<shellID>.out`.
// Whitelisted so agents can read a command's full captured output without an external-directory prompt.
const SHELL_OUTPUT_GLOB = path.join(Global.Path.data, "shell", "*", "*")
const builtIns = () => [
  {
    id: "TLDR",
    description:
      "Aggressively lazy but competent builder that refuses unnecessary work, silently finishes the smallest correct solution, and answers briefly.",
    mode: "primary",
    temperature: 0.1,
    color: "#95a5a6",
    system: sourceSystem(tldrContent, "primary"),
  },
  {
    id: "architech",
    description:
      "Pragmatic evidence-led architect that finds material system gaps, connects every relevant boundary, and implements sound trade-offs.",
    mode: "primary",
    temperature: 0.3,
    color: "#3498db",
    system: sourceSystem(architechContent, "primary"),
  },
  {
    id: "god",
    description:
      "Calm, sovereign, evidence-led builder that identifies the real need, corrects false premises, and delivers exceptional work.",
    mode: "primary",
    temperature: 0.2,
    color: "#f1c40f",
    system: sourceSystem(godContent, "primary"),
  },
  {
    id: "yangi",
    description:
      "Seasoned old master who speaks concisely, decides precisely, and completes engineering work without wasted motion.",
    mode: "primary",
    temperature: 0.1,
    color: "#2ecc71",
    system: sourceSystem(yangiContent, "primary"),
  },
  {
    id: "occam",
    description: "Pragmatic minimalist that completes one bounded task precisely with minimum waste.",
    mode: "subagent",
    temperature: 0.1,
    color: "#2ecc71",
    system: sourceSystem(occamContent, "subagent"),
  },
  {
    id: "omoikane",
    description: "Systems-minded designer and implementer that connects the wider context for one bounded task.",
    mode: "subagent",
    temperature: 0.3,
    color: "#3498db",
    system: sourceSystem(omoikaneContent, "subagent"),
  },
  {
    id: "wittgenstein",
    description: "Silent executor that completes one bounded task and reports only essential evidence.",
    mode: "subagent",
    temperature: 0.1,
    color: "#95a5a6",
    system: sourceSystem(wittgensteinContent, "subagent"),
  },
  {
    id: "zeus",
    description:
      "Evidence-led autonomous implementer that corrects false premises and completes one bounded task with exceptional quality.",
    mode: "subagent",
    temperature: 0.2,
    color: "#f1c40f",
    system: sourceSystem(zeusContent, "subagent"),
  },
] as const

const PROMPT_COMPACTION = `Summarize only the supplied coding-session history for continued work.

- Preserve the current objective, constraints, decisions, exact paths and identifiers, completed work, validation state, blockers, unanswered questions, and next steps.
- Focus on older context because the newest messages may remain verbatim outside the summary.
- If a <previous-summary> block exists, update it: retain still-true facts, remove stale facts, and merge new facts.
- Follow the requested output structure exactly. Keep every requested section and prefer terse bullets.

Do not answer the conversation or mention summarization, compaction, or merging. Use the conversation's language.`

const PROMPT_TITLE = `Output exactly one natural thread title that helps the user find the conversation later.

Requirements:
- Use the same language as the user's message.
- Use one line of at most 50 characters.
- Name the main retrievable topic, question, or requested action.
- Preserve exact technical terms, numbers, filenames, and HTTP status codes.
- For a referenced file, title the requested action, not the file alone.
- Do not infer an unstated technology, mention tools, answer the user, explain the title, or use "summarizing" or "generating".

Output only the title. For minimal or conversational input, still provide a meaningful title that reflects its intent or tone.`

const PROMPT_GOAL = `Synthesize the user's current autonomous-work goal from the request and recent context. Include the intended outcome and observable completion condition.

Output exactly one concise imperative sentence, or two only when required for clarity. Do not use Markdown, a preamble, an explanation, or quotation marks.`

const PROMPT_BTW = `Act as a read-only advisor to the parent session. Inspect the available context and give concise, evidence-based guidance.

Do not mutate files, state, or external systems unless the user explicitly requests and approves that mutation.`

const PROMPT_SUMMARY = `Write a pull-request-style summary of this conversation.

- Use two or three first-person sentences unless preserving the final question or request requires one more.
- Describe the resulting changes, not the process or the user's request.
- Omit tests, builds, and other validation steps.
- Add no new question.
- If the conversation ends with an unanswered question or imperative request to the user, preserve it verbatim.`

// ── Standardized YCoding project prompt (empirical, shared by primary + subagent) ──
const YCODING_PROJECT_PROMPT = `YCoding is the TUI-only V2 runtime (Schema → Core/Protocol → Server, durable SessionV2 events, Location-scoped runner).

Follow the user's prompt or inquiry strictly. Do not perform work the user did not request or introduce ideas the user did not ask for. Do not state details without concrete evidence.

For requests to answer, explain, review, diagnose, or plan, inspect the relevant material and report. Do not make changes unless the request also asks for them.
For requests to change, build, or fix, make the requested in-scope local changes and run relevant non-destructive checks without asking first.
Require confirmation before external writes, purchases, destructive or irreversible actions, dependency changes, data or schema migrations, CI/CD changes, public-contract breaks, or material scope expansion.
If your permission ceiling prevents asking for confirmation, do not act; report the blocker.

Keep prompts cache-stable within each per-model namespace; never invent provider cache semantics. Preserve provider quota and usage reporting, including Meta Llama thought content as 'reasoning'.`
const SUBAGENT_NOTICE = "Subagents always run in the background and notify you when they finish. Do not poll them."
// Goal: dual-state reconciliation – durable system goal (autonomy.goal) vs agent goal (inferred from prompt/steer). User enables, agent synthesizes/owns text.
const MAINCHAT_CAPABILITIES = `Main-session controls:
- The user alone enables goal mode through /goal or the UI. Once enabled, own the goal text: use goal actions 'get', 'update', 'complete', 'stop', or 'clear'; never use 'set'. Reconcile the goal after each prompt or steer. A completed or stopped goal disappears from the sidebar.
- Keep autonomy explicit. YOLO 0 is manual; 1 auto-answers questions and forms; 2 also auto-approves ask permissions. Active goal mode grants those question and ask-permission approvals at YOLO 0. Explicit permission denies remain denied. Only effective YOLO 3 auto-approves guardrail reviews. Change YOLO only through /yolo or the UI toggle.
- Use durable subagents only for isolated work. Choose the model variant that fits task difficulty, and use stronger variants only when required.`
const SUBAGENT_CAPABILITIES = `Subagent controls:
- You are a durable child Session assigned one bounded task. Complete only that task. Do not spawn child agents, expand scope, or ask the user; return any blocker with the largest useful verified result.
- The main session owns any active family goal. Never use goal action 'set'; use 'get', 'update', or 'complete' only when the assigned task requires it.
- Report the outcome, changed paths, exact checks, assumptions, and remaining risk with self-contained evidence.`

function sourceSystem(content: string, mode: "primary" | "subagent") {
  const base = content.slice(content.indexOf("\n---\n\n") + "\n---\n\n".length).trim()
  const capabilities = mode === "primary" ? [SUBAGENT_NOTICE, MAINCHAT_CAPABILITIES] : [SUBAGENT_CAPABILITIES]
  return [YCODING_PROJECT_PROMPT, base, ...capabilities].join("\n\n")
}

export const Plugin = define({
  id: "ycoding.agent",
  effect: Effect.fn(function* (ctx) {
    const whitelistedDirs = [SHELL_OUTPUT_GLOB, path.join(Global.Path.tmp, "*")]
    const readonlyExternalDirectory: PermissionV2.Ruleset = [
      { action: "external_directory", resource: "*", effect: "ask" },
      ...whitelistedDirs.map(
        (resource): PermissionV2.Rule => ({ action: "external_directory", resource, effect: "allow" }),
      ),
    ]
    const defaults: PermissionV2.Ruleset = [
      { action: "*", resource: "*", effect: "allow" },
      ...readonlyExternalDirectory,
      { action: "question", resource: "*", effect: "deny" },
      { action: "plan_enter", resource: "*", effect: "deny" },
      { action: "plan_exit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]

    yield* ctx.agent.transform((draft) => {
      for (const definition of builtIns()) {
        draft.update(AgentV2.ID.make(definition.id), (item) => {
          item.name = AgentV2.Name.make(definition.id)
          item.description = definition.description
          item.mode = definition.mode
          item.request.body = { temperature: definition.temperature }
          item.color = definition.color
          item.system = definition.system
          item.permissions.splice(
            0,
            item.permissions.length,
            ...PermissionV2.merge(
              defaults,
              definition.mode === "subagent"
                ? [
                    { action: "subagent", resource: "*", effect: "deny" },
                    { action: "shell", resource: "*", effect: "allow" },
                  ]
                : [
                    { action: "question", resource: "*", effect: "allow" },
                    { action: "plan_enter", resource: "*", effect: "allow" },
                    { action: "shell", resource: "*", effect: "allow" },
                  ],
            ),
          )
        })
      }

      draft.update(AgentV2.ID.make("btw"), (item) => {
        item.name = AgentV2.Name.make("BTW")
        item.mode = "subagent"
        item.hidden = false
        item.system = PROMPT_BTW
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "read", resource: "*", effect: "allow" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "question", resource: "*", effect: "allow" },
              { action: "edit", resource: "*", effect: "ask" },
              { action: "write", resource: "*", effect: "ask" },
              { action: "patch", resource: "*", effect: "ask" },
              { action: "shell", resource: "*", effect: "ask" },
              { action: "subagent", resource: "*", effect: "deny" },
            ],
            readonlyExternalDirectory,
          ),
        )
      })

      draft.update(AgentV2.ID.make("compaction"), (item) => {
        item.name = AgentV2.Name.make("Compaction")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_COMPACTION
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("title"), (item) => {
        item.name = AgentV2.Name.make("Title")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("goal"), (item) => {
        item.name = AgentV2.Name.make("Goal")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_GOAL
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("summary"), (item) => {
        item.name = AgentV2.Name.make("Summary")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })
    })
  }),
})
