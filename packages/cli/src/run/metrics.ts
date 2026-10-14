import type { EventSubscribeOutput, YCodingClient } from "@ycoding-ai/client/promise"

type StepEvent<Type extends string> = Extract<EventSubscribeOutput, { type: Type }>["data"]
type Tokens = StepEvent<"session.step.ended">["tokens"]
type Model = StepEvent<"session.step.started">["model"]
type Task = Awaited<ReturnType<YCodingClient["session"]["subagent"]["list"]>>["data"][number]
type Metrics = Awaited<ReturnType<YCodingClient["session"]["usageReport"]>>["total"]

const zeroTokens: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/** Accumulates the metrics of the root Session's steps in one run. */
export function createRunMetrics() {
  const models = new Map<string, Model>()
  let steps = 0
  let tokens = zeroTokens
  let cost = 0
  let limit: number | undefined
  let peakInput: number | undefined

  return {
    started(model: Model) {
      models.set(JSON.stringify([model.providerID, model.id, model.variant, model.profile]), model)
    },
    settled(step: { tokens?: Tokens; cost?: number; contextLimit?: number }) {
      steps++
      cost += step.cost ?? 0
      // A zero limit means the model reports no context window, as in the session diagnostics.
      if (step.contextLimit !== undefined && step.contextLimit > 0) limit = step.contextLimit
      if (!step.tokens) return
      tokens = {
        input: tokens.input + step.tokens.input,
        output: tokens.output + step.tokens.output,
        reasoning: tokens.reasoning + step.tokens.reasoning,
        cache: {
          read: tokens.cache.read + step.tokens.cache.read,
          write: tokens.cache.write + step.tokens.cache.write,
        },
      }
      peakInput = Math.max(peakInput ?? 0, step.tokens.input + step.tokens.cache.read + step.tokens.cache.write)
    },
    summary() {
      return {
        steps,
        tokens,
        cost,
        context: {
          ...(limit === undefined ? {} : { limit }),
          ...(peakInput === undefined ? {} : { peakInput }),
        },
        models: [...models.values()],
      }
    },
  }
}

/**
 * Reads every provider request recorded for the root Session family inside the run window.
 * `session.usageReport` selects the root Session, all descendant Sessions (managed subagents and
 * hidden compaction helpers), and applies `from` inclusively and `to` exclusively to request times.
 * Title requests are recorded under the Session they name.
 */
export async function readRunUsage(
  client: YCodingClient,
  sessionID: string,
  window: { from: number; to: number },
) {
  const report = await readReport(client, sessionID, window)
  const subagents = new Map((await readTasks(client, sessionID)).map((task) => [task.sessionID, task]))
  const helpers = report.rows.filter((row) => row.key !== sessionID && !subagents.has(row.key))
  const helperAgents = await Promise.all(
    helpers.map((row) => client.session.get({ sessionID: row.key }).then((session) => session.agent)),
  )
  const rows = new Map(report.rows.map((row) => [row.key, row]))
  return {
    total: usage(report.total),
    children: [
      ...[...subagents.values()].map((task) => ({
        sessionID: task.sessionID,
        kind: "subagent" as const,
        agent: task.agent,
        status: task.state,
        ...usage(rows.get(task.sessionID)),
      })),
      ...helpers.map((row, index) => ({
        sessionID: row.key,
        kind: "helper" as const,
        ...(helperAgents[index] === undefined ? {} : { agent: helperAgents[index] }),
        ...usage(row),
      })),
    ],
  }
}

async function readReport(client: YCodingClient, sessionID: string, window: { from: number; to: number }) {
  const pages = []
  let offset: number | undefined
  do {
    const page = await client.session.usageReport({
      sessionID,
      group: "session",
      from: window.from,
      to: Math.max(window.to, window.from + 1),
      limit: 200,
      offset,
    })
    pages.push(page)
    offset = page.nextOffset
  } while (offset !== undefined)
  return { total: pages[0].total, rows: pages.flatMap((page) => page.rows) }
}

async function readTasks(client: YCodingClient, parentID: string): Promise<Task[]> {
  const direct: Task[] = []
  let cursor: string | undefined
  do {
    const page = await client.session.subagent.list({ parentID, limit: 10, cursor })
    direct.push(...page.data)
    cursor = page.cursor.next
  } while (cursor !== undefined)
  return [...direct, ...(await Promise.all(direct.map((task) => readTasks(client, task.sessionID)))).flat()]
}

function usage(metrics?: Metrics) {
  return {
    tokens: metrics?.tokens ?? zeroTokens,
    ...(metrics?.cost === undefined ? {} : { cost: metrics.cost, costProvenance: metrics.costProvenance }),
    requests: {
      logical: metrics?.logical ?? 0,
      physical: metrics?.physical ?? 0,
      helpers: metrics?.helpers ?? 0,
    },
  }
}
