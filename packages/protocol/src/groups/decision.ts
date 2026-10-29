import { Form } from "@ycoding-ai/schema/form"
import { Question } from "@ycoding-ai/schema/question"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { optional } from "@ycoding-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const DecisionItem = Schema.Struct({
  kind: Schema.Literals(["permission", "guardrail", "question", "form", "review"]),
  sessionID: Schema.String,
  sessionTitle: Schema.String,
  directory: Schema.String,
  id: Schema.String,
  summary: Schema.String,
  options: Schema.Union([Schema.Array(Question.Info), Form.Fields, SessionReview.Payload]).pipe(optional),
  decide: Schema.Array(Schema.Struct({ label: Schema.String, argv: Schema.Array(Schema.String), template: Schema.Literal(true).pipe(optional), hint: Schema.String.pipe(optional) })),
}).annotate({ identifier: "Decision.Item" })
export interface DecisionItem extends Schema.Schema.Type<typeof DecisionItem> {}

export const DecisionGroup = HttpApiGroup.make("server.decision").add(
  HttpApiEndpoint.get("decision.list", "/api/decision", { success: Schema.Struct({ data: Schema.Array(DecisionItem) }) }).annotateMerge(
    OpenApi.annotations({ identifier: "decision.list", summary: "List pending decisions across Sessions and Locations",
      description: "List live requests from the loaded Location snapshot and open durable review items from all non-archived Sessions. Never load missing services; a Location evicted after the snapshot may be rebuilt. Decide commands use exact API operations; template entries require answer values matching options.",
    }),
  ),
)
