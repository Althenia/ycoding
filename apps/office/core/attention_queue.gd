## Pending human attention.
##
## A question, permission or guardrail request is a real, durable thing a session
## is BLOCKED on. The office must show it and let the user answer it, and it must
## never invent an answer, a default, or an approval on the user's behalf.
##
## Two rules are correctness, not styling:
##   * a request carries the answers the runtime actually offers, so the UI cannot
##     present a choice the service would reject;
##   * DEMO has no requests, because a synthetic office cannot ask for anything.
class_name AttentionQueue
extends RefCounted

## The three request families, as they appear on the wire.
const KIND_QUESTION := "question"
const KIND_PERMISSION := "permission"
const KIND_GUARDRAIL := "guardrail"

## The replies the schema allows for permission and guardrail requests.
const REPLIES := ["once", "always", "reject"]

## The replies a HARD review allows. The runtime states the restriction on the wire
## (`Guardrail.Request.hardReview`), and a hard review permits only a ONE-TIME approval or a
## rejection - never a session-wide one. Offering `always` for one would present a permission
## the user does not have, and the runtime would refuse it.
const HARD_REPLIES := ["once", "reject"]

## The wire field that marks a request as a hard review (packages/schema/src/guardrail.ts).
const HARD_REVIEW_FIELD := "hardReview"

var _requests: Dictionary = {}
var _order: Array[String] = []


## Record or refresh a pending request. Returns false when the request has no id or
## no kind, because such a request could never be answered.
func push(kind: String, request_id: String, session_id: String, data: Dictionary = {}) -> bool:
	if request_id.is_empty() or kind.is_empty():
		return false
	if not _requests.has(request_id):
		_order.append(request_id)
	_requests[request_id] = {
		"id": request_id,
		"kind": kind,
		"session_id": session_id,
		"data": data,
	}
	return true


## Drop a request once it has been answered, rejected or superseded.
##
## The runtime answers a request exactly once, so a stale entry must not linger
## and offer an action the service would now refuse.
func resolve(request_id: String) -> bool:
	if not _requests.has(request_id):
		return false
	_requests.erase(request_id)
	_order.erase(request_id)
	return true


func has(request_id: String) -> bool:
	return _requests.has(request_id)


func count() -> int:
	return _requests.size()


## Pending requests oldest first, so the queue is stable across refreshes.
func pending() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for request_id in _order:
		if _requests.has(request_id):
			out.append(_requests[request_id])
	return out


## The request a session is blocked on, if any. A session can only be blocked on
## one thing at a time in practice, so the oldest wins.
func for_session(session_id: String) -> Dictionary:
	for entry in pending():
		if str(entry["session_id"]) == session_id:
			return entry
	return {}


## Whether a session is waiting on a human.
func blocks(session_id: String) -> bool:
	return not for_session(session_id).is_empty()


## Clear everything, used when the projection is replaced.
func clear() -> void:
	_requests.clear()
	_order.clear()


## The reply a request accepts, or {} when the request cannot be answered.
##
## Permission and guardrail requests take one of three literals. A question takes
## the options the runtime supplied, as arrays of selected labels.
static func reply_shape(request: Dictionary) -> Dictionary:
	match str(request.get("kind", "")):
		KIND_PERMISSION, KIND_GUARDRAIL:
			# A hard review offers the restricted set, so the controls the UI builds can never
			# be the ones the runtime would refuse.
			var allowed := HARD_REPLIES if is_hard_review(request) else REPLIES
			return {"type": "literal", "allowed": allowed}
		KIND_QUESTION:
			var questions: Array = (request.get("data", {}) as Dictionary).get("questions", [])
			var options: Array = []
			for question in questions:
				if not (question is Dictionary):
					continue
				var labels: Array = []
				for option in (question as Dictionary).get("options", []):
					if option is Dictionary:
						labels.append(str((option as Dictionary).get("label", "")))
					else:
						labels.append(str(option))
				options.append(labels)
			return {"type": "answers", "options": options}
	return {}


## The payload for a question reply. Answers are positional and each is a list of
## selected labels, matching `Question.Reply`.
static func answers_payload(selected: Array) -> Dictionary:
	return {"answers": selected}


## The payload for a permission or guardrail reply.
##
## Returns {} for anything outside the literal set rather than forwarding it, so a
## malformed reply is refused here instead of by the service.
static func literal_payload(reply: String) -> Dictionary:
	if not REPLIES.has(reply):
		return {}
	return {"reply": reply}


## The payload for a literal reply to a specific request, so a restriction on the REQUEST is
## enforced where the payload is built rather than only where the controls are.
##
## `hard` is passed in rather than read from a request dictionary because the two callers have
## different things in hand: the UI has the request, and a test has only the fact. The
## restriction itself is one rule either way.
static func literal_payload_for(request_id: String, reply: String, hard: bool) -> Dictionary:
	request_id = request_id
	if hard and not HARD_REPLIES.has(reply):
		return {}
	return literal_payload(reply)


## Whether the runtime marked this request a HARD review.
##
## Read from the wire, never inferred: the schema declares `hardReview` on a guardrail request
## and gives a permission request no such field, so the flag is absent rather than false for
## everything else. A request that does not carry it is an ordinary one.
static func is_hard_review(request: Dictionary) -> bool:
	var data: Variant = request.get("data", {})
	if not (data is Dictionary):
		return false
	return bool((data as Dictionary).get(HARD_REVIEW_FIELD, false))