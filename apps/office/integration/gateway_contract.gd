## HTTP route, payload and streaming contract of the local YCoding service.
##
## Every value here was read from the live service, not from the handoff pack:
##   packages/protocol/src/groups/{session,message,event,health}.ts
## and confirmed against a real loopback server by
## `tests/integration/transport_contract.gd`.
##
## This file is names and shapes only. It performs no I/O, so both the live and
## demo paths can share it without touching the network.
class_name Gateway
extends RefCounted

## --- Routes ---------------------------------------------------------------

const HEALTH := "/api/health"
const EVENT := "/api/event"
const SESSION_LIST := "/api/session"
const SESSION_ACTIVE := "/api/session/active"

## The event feed is volatile by contract: a slow consumer overflows and fails
## the stream, and events during a disconnection are missed. Recoverable history
## comes from the durable per-session log instead.
const EVENT_STREAM := "/api/event"

static func session(session_id: String) -> String:
	return "/api/session/%s" % session_id

static func snapshot(session_id: String) -> String:
	return "/api/session/%s/snapshot" % session_id

static func messages(session_id: String) -> String:
	return "/api/session/%s/message" % session_id

static func prompt(session_id: String) -> String:
	return "/api/session/%s/prompt" % session_id

static func interrupt(session_id: String) -> String:
	return "/api/session/%s/interrupt" % session_id

## Switch the model used by subsequent steps. The service refuses the switch when
## the current context cannot fit the target model, so this is a real request
## rather than a local preference.
static func switch_model(session_id: String) -> String:
	return "/api/session/%s/model" % session_id

static func subagents(parent_id: String) -> String:
	return "/api/session/%s/subagent" % parent_id

## Human attention. A session blocked on a question, a permission or a guardrail
## review is answered through these. All three take a JSON body and answer 204.
static func question_reply(session_id: String, request_id: String) -> String:
	return "/api/session/%s/question/%s/reply" % [session_id, request_id]

static func question_reject(session_id: String, request_id: String) -> String:
	return "/api/session/%s/question/%s/reject" % [session_id, request_id]

static func permission_reply(session_id: String, request_id: String) -> String:
	return "/api/session/%s/permission/%s/reply" % [session_id, request_id]

static func guardrail_reply(session_id: String, request_id: String) -> String:
	return "/api/session/%s/guardrail/%s/reply" % [session_id, request_id]


## Durable session log. Read it as an SSE stream, not as a JSON request.
static func log(session_id: String, after: int, follow: bool) -> String:
	return "/api/experimental/session/%s/log?after=%d&follow=%s" % [
		session_id,
		after,
		"true" if follow else "false",
	]

## --- Response framing -----------------------------------------------------

## Read routes return `<route>Result` envelopes: the payload is nested under
## `data`. This applies to session list, active, and the message list.
const ENVELOPE_DATA := "data"

## Snapshot is the exception: it is returned top-level, NOT wrapped in `data`.
## Its members are `sourceEpoch`, `session`, `messages` and `watermark`.
const SNAPSHOT_EPOCH := "sourceEpoch"
const SNAPSHOT_SESSION := "session"
const SNAPSHOT_MESSAGES := "messages"
const SNAPSHOT_WATERMARK := "watermark"

## The watermark marks the last durable sequence included in a snapshot, so a
## client resumes the log with `after = watermark.seq`.
const WATERMARK_TYPE := "log.synced"
const WATERMARK_AGGREGATE := "aggregateID"
const WATERMARK_SEQ := "seq"

## The message list returns `data` plus a `cursor`, and has no pagination: it
## always returns the full transcript.
const MESSAGES_CURSOR := "cursor"

## --- Streaming ------------------------------------------------------------

## SSE frames are `data: <json>` followed by a blank line. The service emits no
## `id:`, `event:` or `retry:` field, so the stream is not resumable by
## Last-Event-ID and must be re-established from the durable log instead.
const SSE_DATA_PREFIX := "data: "

## Heartbeats arrive as comment lines and carry no event.
const SSE_HEARTBEAT := ": keep-alive"

## The first frame on `/api/event` is always `server.connected`, and it carries
## the `sourceEpoch` that identifies the server process epoch.
const SERVER_CONNECTED := "server.connected"
const SOURCE_EPOCH := "sourceEpoch"

## --- Session runtime status -----------------------------------------------

## `/api/session/active` returns only sessions with a foreground drain owned by
## this process. A session that exists but is not executing is absent, which is
## the documented contract rather than an error.
const ACTIVE_RUNNING := "running"

## --- Admission ------------------------------------------------------------

## `delivery` selects when an admitted prompt becomes visible. `steer` promotes
## at the next safe step boundary; `queue` waits until the session would idle.
const DELIVERY_STEER := "steer"
const DELIVERY_QUEUE := "queue"

## Reusing a prompt `id` reconciles an exact retry only when the session, prompt
## and delivery mode match. A conflicting reuse is rejected.
const PROMPT_ID := "id"
const PROMPT_TEXT := "text"
const PROMPT_DELIVERY := "delivery"
const PROMPT_RESUME := "resume"

## --- Auth -----------------------------------------------------------------

## Optional HTTP Basic. The username is fixed; the password comes from the
## service registration file (mode 0600) and is never sent over plaintext
## outside loopback.
const AUTH_USERNAME := "ycoding"
const AUTH_CHALLENGE := "Basic realm=\"Secure Area\""
const AUTH_HEADER := "Authorization"
const AUTH_TOKEN_QUERY := "auth_token"

## --- Location -------------------------------------------------------------

## Location is passed as a query deepObject or as headers. Session routes take
## it from the session row, so the client sends none for those routes.
const LOCATION_DIRECTORY_QUERY := "location[directory]"
const LOCATION_WORKSPACE_QUERY := "location[workspace]"
const LOCATION_DIRECTORY_HEADER := "x-ycoding-directory"
const LOCATION_WORKSPACE_HEADER := "x-ycoding-workspace"
