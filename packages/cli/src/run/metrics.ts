import type { EventSubscribeOutput, YCodingClient } from "@ycoding-ai/client/promise"

type StepEvent<Type extends string> = Extract<EventSubscribeOutput, { type: Type }>["data"]
type Tokens = StepEvent<"session.step.ended">["tokens"]
type Model = StepEvent<"session.step.started">["model"]
type Task = Awaited<ReturnType<YCodingClient["session"]["subagent"]["list"]>>["data"][number]
type Metrics = Awaited<ReturnType<YCodingClient["session"]["usageReport"]>>["total"]

const zeroTokens: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

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
        context: { ...(limit === undefined ? {} : { limit }), ...(peakInput === undefined ? {} : { peakInput }) },
        models: [...models.values()],
      }
    },
  }
}

export function createRunActivity() {
  const sessions = new Map<string, { steps: number; turns: number; counted: boolean }>()
  const session = (sessionID: string) => {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created = { steps: 0, turns: 0, counted: false }
    sessions.set(sessionID, created)
    return created
  }
  return {
    observe(event: EventSubscribeOutput) {
      switch (event.type) {
        case "session.step.ended":
        case "session.step.failed":
          session(event.data.sessionID).steps++
          return
        case "session.input.promoted": {
          const current = session(event.data.sessionID)
          if (current.counted) return
          current.counted = true
          current.turns++
          return
        }
        case "session.execution.started":
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          session(event.data.sessionID).counted = false
          return
      }
    },
    steps(sessionID: string) {
      return sessions.get(sessionID)?.steps
    },
    turns(sessionID: string) {
      return sessions.get(sessionID)?.turns ?? 0
    },
  }
}

export async function readRunUsage(
  client: YCodingClient,
  sessionID: string,
  window: { from: number; to: number },
  activity: ReturnType<typeof createRunActivity>,
) {
  const report = await readReport(client, sessionID, window)
  const subagents = new Map((await readTasks(client, sessionID)).map((task) => [task.sessionID, task]))
  const helpers = report.rows.filter((row) => row.key !== sessionID && !subagents.has(row.key))
  const helperAgents = await Promise.all(
    helpers.map((row) => client.session.get({ sessionID: row.key }).then((session) => session.agent)),
  )
  const rows = new Map(report.rows.map((row) => [row.key, row]))
  const counted = [sessionID, ...subagents.keys()]
  return {
    total: {
      ...usage(report.total),
      steps: counted.reduce((sum, id) => sum + (activity.steps(id) ?? 0), 0),
      turns: counted.reduce((sum, id) => sum + activity.turns(id), 0),
    },
    children: [
      ...[...subagents.values()].map((task) => ({
        sessionID: task.sessionID,
        kind: "subagent" as const,
        agent: task.agent,
        status: task.state,
        ...usage(rows.get(task.sessionID)),
        steps: activity.steps(task.sessionID) ?? 0,
        turns: activity.turns(task.sessionID),
      })),
      ...helpers.map((row, index) => {
        const steps = activity.steps(row.key)
        return {
          sessionID: row.key,
          kind: "helper" as const,
          ...(helperAgents[index] === undefined ? {} : { agent: helperAgents[index] }),
          ...usage(row),
          ...(steps ? { steps } : {}),
        }
      }),
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
    requests: { logical: metrics?.logical ?? 0, physical: metrics?.physical ?? 0, helpers: metrics?.helpers ?? 0 },
  }
}
