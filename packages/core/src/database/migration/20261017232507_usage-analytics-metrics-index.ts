import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261017232507_usage-analytics-metrics-index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`usage_analytics_request_metrics_idx\` ON \`usage_analytics_request\` (\`time_created\`,\`id\`,\`session_id\`,\`project_id\`,\`directory\`,\`workspace_id\`,\`session_updated\`,\`agent\`,\`source\`,\`model\`,\`usage_anchor\`,\`task_path\`,\`request\`,\`attempts\`,\`continuation\`,\`cache_read_reported\`,\`cost\`,json_extract(tokens, '$.input'),json_extract(tokens, '$.output'),json_extract(tokens, '$.reasoning'),json_extract(tokens, '$.cache.read'),json_extract(tokens, '$.cache.write'),json_extract(timing, '$.firstOutputMs'),json_extract(timing, '$.totalMs'),json_extract(timing, '$.generatedTokens'),json_extract(timing, '$.generationDurationNs'),json_extract(timing, '$.observedGenerationDurationNs'),json_type(timing, '$.generationDurationNs'));`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
