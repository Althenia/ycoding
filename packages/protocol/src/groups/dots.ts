import { Dots } from "@ycoding-ai/schema/dots"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError } from "../errors.js"

const ThreadID = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const Page = {
  cursor: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)).pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50))), Schema.optional),
}

export const DotsGroup = HttpApiGroup.make("server.dots")
  .add(HttpApiEndpoint.get("dots.get", "/api/dots", {
    success: Schema.Struct({ data: Dots.NativeStatus }), error: [InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.get", summary: "Read global Dots access, prerequisites and connection" })))
  .add(HttpApiEndpoint.put("dots.set", "/api/dots", {
    payload: Dots.AccessSet, success: Schema.Struct({ data: Dots.NativeStatus }),
    error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.set", summary: "Change Dots access to every existing and future eligible Session at an exact revision" })))
  .add(HttpApiEndpoint.post("dots.attach", "/api/dots/computer", {
    payload: Dots.ComputerAttach, success: Schema.Struct({ data: Dots.NativeStatus }), error: [InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.attach", summary: "Attach this computer's Dots executor to the account's Dot" })))
  .add(HttpApiEndpoint.post("dots.detach", "/api/dots/computer/detach", {
    payload: Dots.ComputerDetach, success: Schema.Struct({ data: Dots.NativeStatus }), error: [InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.detach", summary: "Detach this computer's Dots executor from the account's Dot" })))
  .add(HttpApiEndpoint.post("dots.remove", "/api/dots/computer/remove", {
    payload: Dots.ComputerRemove, success: Schema.Struct({ data: Dots.NativeStatus }), error: [InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.remove", summary: "Remove this computer from the ChatGPT account and turn Dots access off" })))
  .add(HttpApiEndpoint.get("dots.threads", "/api/dots/threads", {
    success: Schema.Struct({ data: Dots.ThreadList }), error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.threads", summary: "List the Dot's root and task threads and its tasks" })))
  .add(HttpApiEndpoint.get("dots.task.updates", "/api/dots/tasks/:taskID/updates", {
    params: { taskID: ThreadID }, query: Page, success: Schema.Struct({ data: Dots.TaskUpdates }), error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.task.updates", summary: "Read one page of a Dot task's updates" })))
  .add(HttpApiEndpoint.get("dots.thread.read", "/api/dots/thread/:threadID", {
    params: { threadID: ThreadID }, query: Page, success: Schema.Struct({ data: Dots.Transcript }), error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.thread.read", summary: "Read one page of a Dot thread transcript, newest turns first" })))
  .add(HttpApiEndpoint.post("dots.thread.send", "/api/dots/thread/:threadID/message", {
    params: { threadID: ThreadID }, payload: Dots.ThreadSend, success: Schema.Struct({ data: Dots.SendResult }), error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.thread.send", summary: "Send, steer or queue one user message into a Dot thread exactly once" })))
  .add(HttpApiEndpoint.post("dots.thread.interrupt", "/api/dots/thread/:threadID/interrupt", {
    params: { threadID: ThreadID }, payload: Dots.ThreadInterrupt, success: Schema.Struct({ data: Dots.InterruptResult }), error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.thread.interrupt", summary: "Interrupt the active turn of a Dot thread" })))
  .add(HttpApiEndpoint.post("dots.resume", "/api/dots/resume", {
    success: Schema.Struct({ data: Dots.ResumeResult }), error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.resume", summary: "Resume the Dot runtime once" })))
  .add(HttpApiEndpoint.get("dots.thread.requests", "/api/dots/thread/:threadID/requests", {
    params: { threadID: ThreadID }, success: Schema.Struct({ data: Dots.PendingRequests }), error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.thread.requests", summary: "List the approval and input requests pending on a Dot thread" })))
  .add(HttpApiEndpoint.post("dots.thread.respond", "/api/dots/thread/:threadID/requests/:requestID", {
    params: { threadID: ThreadID, requestID: ThreadID }, payload: Dots.RequestResponse, success: Schema.Struct({ data: Dots.RespondResult }),
    error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.thread.respond", summary: "Answer one pending Dot thread request exactly once" })))
