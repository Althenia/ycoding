## Gateway contract tests.
##
## These pin the route strings and framing names the client sends. They are pure
## string assertions, so they run in the headless unit suite; the matching
## end-to-end proof that a real server agrees lives in
## tests/integration/transport_contract.gd.
extends RefCounted

func run(t) -> void:
	test_builds_session_routes(t)
	test_builds_attention_routes(t)
	test_log_is_a_stream_query(t)
	test_snapshot_is_not_enveloped(t)
	test_stream_framing_constants(t)
	test_delivery_modes(t)
	test_auth_username(t)

## Each derived route must match the protocol's literal path.
func test_builds_session_routes(t) -> void:
	t.check(Gateway.session("ses_1") == "/api/session/ses_1", "session route")
	t.check(Gateway.snapshot("ses_1") == "/api/session/ses_1/snapshot", "snapshot route")
	t.check(Gateway.messages("ses_1") == "/api/session/ses_1/message", "message route")
	t.check(Gateway.prompt("ses_1") == "/api/session/ses_1/prompt", "prompt route")
	t.check(Gateway.interrupt("ses_1") == "/api/session/ses_1/interrupt", "interrupt route")
	t.check(Gateway.subagents("ses_1") == "/api/session/ses_1/subagent", "subagent route")

## Human attention. Each reply path must match the protocol's literal route, or a
## desktop approval is POSTed to a path no live route serves. The guardrail route
## carries an extra `request` segment between the session and the request id.
func test_builds_attention_routes(t) -> void:
	t.check(
		Gateway.question_reply("ses_1", "req_1") == "/api/session/ses_1/question/req_1/reply",
		"question reply route"
	)
	t.check(
		Gateway.question_reject("ses_1", "req_1") == "/api/session/ses_1/question/req_1/reject",
		"question reject route"
	)
	t.check(
		Gateway.permission_reply("ses_1", "req_1") == "/api/session/ses_1/permission/req_1/reply",
		"permission reply route"
	)
	t.check(
		Gateway.guardrail_reply("ses_1", "req_1") == "/api/session/ses_1/guardrail/request/req_1/reply",
		"guardrail reply route"
	)

## The log route takes an exclusive `after` cursor and a literal boolean
## `follow`, and it is consumed as SSE rather than as a JSON request.
func test_log_is_a_stream_query(t) -> void:
	t.check(
		Gateway.log("ses_1", 0, false) == "/api/experimental/session/ses_1/log?after=0&follow=false",
		"log cursor starts at zero"
	)
	t.check(
		Gateway.log("ses_1", 42, true) == "/api/experimental/session/ses_1/log?after=42&follow=true",
		"log follows from a watermark seq"
	)

## A regression guard: snapshot is top-level, so wrapping it in `data` would
## silently break every transcript read.
func test_snapshot_is_not_enveloped(t) -> void:
	t.check(Gateway.ENVELOPE_DATA == "data", "envelope key")
	t.check(Gateway.SNAPSHOT_EPOCH == "sourceEpoch", "snapshot epoch key")
	t.check(Gateway.SNAPSHOT_MESSAGES == "messages", "snapshot messages key")
	t.check(
		Gateway.SNAPSHOT_EPOCH != Gateway.ENVELOPE_DATA,
		"snapshot epoch is read top-level, not from the data envelope"
	)

## The service emits only `data:` lines. Claiming an `id:` or `retry:` field
## would imply resumability the wire does not provide.
func test_stream_framing_constants(t) -> void:
	t.check(Gateway.SSE_DATA_PREFIX == "data: ", "SSE data prefix")
	t.check(Gateway.SERVER_CONNECTED == "server.connected", "first frame type")
	t.check(Gateway.WATERMARK_TYPE == "log.synced", "watermark type")
	t.check(Gateway.SSE_HEARTBEAT == ": keep-alive", "heartbeat is a comment line")

func test_delivery_modes(t) -> void:
	t.check(Gateway.DELIVERY_STEER == "steer", "steer delivery literal")
	t.check(Gateway.DELIVERY_QUEUE == "queue", "queue delivery literal")

func test_auth_username(t) -> void:
	t.check(Gateway.AUTH_USERNAME == "ycoding", "fixed basic-auth username")
