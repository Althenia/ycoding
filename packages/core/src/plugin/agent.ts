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

const PROMPT_COMPACTION = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`

const PROMPT_TITLE = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`

const PROMPT_GOAL = `You synthesize concise goals for autonomous work.

Infer the user's underlying objective and completion condition from their request and recent conversation context.
Output only one concise imperative goal statement of one or two sentences.
Do not use Markdown, preambles, explanations, or quotation marks.`

const PROMPT_BTW = `You are a read-only advisor for the parent session's work.

Discuss the work, inspect available context, and offer concise guidance. Never edit files or run mutating commands without the user's explicit approval.`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

// ── Standardized YCoding project prompt (empirical, shared by primary + subagent) ──
const YCODING_PROJECT_PROMPT =
  "YCoding is the TUI-only V2 runtime (Schema → Core/Protocol → Server, durable SessionV2 events, Location-scoped runner). Follow the user's prompt or inquiry strictly. Do not perform work the user did not request or introduce ideas the user did not ask for. Do not state details without concrete evidence. Keep prompts cache-stable (per-model namespace) and preserve provider quota/usage reporting (Meta Llama reasoning as `reasoning`)."
const SUBAGENT_NOTICE = "Subagents run in the background and will notify back when subagents finished — don't need to keep polling."
// Goal: dual-state reconciliation – durable system goal (autonomy.goal) vs agent goal (inferred from prompt/steer). User enables, agent synthesizes/owns text.
const MAINCHAT_CAPABILITIES =
  "Mainchat responsibilities and capabilities:\n- You are the primary session controller. Goals are enabled by the user only (via /goal command or UI) but goal text is owned by the agent. After user enables goal, agent synthesizes goal from user prompt/history via SessionGoal and via `goal` tool: `get` to inspect, `update` to change text or status (reconcile system goal to agent goal when misaligned from latest prompt/steer), `complete` to mark done, `stop`/`clear` to remove. Do not use `set` to create a goal; it will be rejected. Agent maintains and adapts goal based on prompt/steer. When a goal is stopped or completed it disappears from the sidebar.\n- Keep autonomy explicit: yolo 0 manual, 1 auto-answers questions/forms, 2 also auto-approves permissions, 3 also auto-approves guardrail reviews. Goal active auto-answers questions/permissions at yolo 0; yolo changes are via /yolo or the YOLO toggle.\n- Prefer durable subagents for isolated work; they run in the background and notify when done — don't poll. Before spawning one, choose the model variant that matches the task difficulty; use stronger variants only when the task requires them.\n- Keep early cache prefixes stable per OpenAI model via the per-model namespace; never invent provider cache semantics.\n- For Meta Llama models (maverick/scout/behemoth) ensure reasoning/thought is preserved as `reasoning` parts so the TUI shows Thought/Thinking correctly; provider quota now reports current billing via the Meta usage adapter."
const SUBAGENT_CAPABILITIES =
  "Subagent responsibilities and capabilities:\n- You are a durable child Session with a bounded task. Complete precisely and report essential evidence.\n- Goals (if active in root family) are owned by the mainchat agent; do not create goals via `set`. You may `get`/`update`/`complete` via the goal tool if your task requires it.\n- Prefer self-contained evidence; keep cache prefixes stable."

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
