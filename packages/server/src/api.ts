import { makeDefaultApi } from "@ycoding-ai/protocol/api"
import { Struct } from "effect"
import { HttpApi, HttpApiGroup } from "effect/unstable/httpapi"
import { LocationMiddleware } from "./location"
import { FormLocationMiddleware } from "./middleware/form-location"
import { SessionLocationMiddleware } from "./middleware/session-location"

const contract = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  // FormLocationMiddleware contains the temporary `sessionID === "global"` MCP elicitation hack.
  // Do not use that sentinel with general session APIs.
  formLocationMiddleware: FormLocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const Api = HttpApi.make(contract.identifier)
  .annotateMerge(contract.annotations)
  .add(
    contract.groups["server.health"],
    ...Object.values(
      Struct.omit(contract.groups, [
        "server.health",
        "server.session",
        "server.providerUsage",
        "server.review",
        "server.incident",
      ]),
    ),
    HttpApiGroup.make("server.session")
      .annotateMerge(contract.groups["server.session"].annotations)
      .add(
        contract.groups["server.session"].endpoints["session.active"],
        ...Object.values(
          Struct.omit(contract.groups["server.session"].endpoints, [
            "session.active",
            "session.promptCosts",
            "session.taskCosts",
          ]),
        ),
      ),
    HttpApiGroup.make("server.providerUsage")
      .annotateMerge(contract.groups["server.providerUsage"].annotations)
      .add(
        contract.groups["server.providerUsage"].endpoints["providerUsage.list"],
        contract.groups["server.providerUsage"].endpoints["providerUsage.get"],
      ),
  )
