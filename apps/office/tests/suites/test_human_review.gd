## Human review and question handling tests (R6-04).
##
## The acceptance is: "Equivalent once/reject/session-only where valid, hard review
## restrictions; human decisions not LLM dialogue."
##
## The runtime states the restriction on the wire: `Guardrail.Request` carries `hardReview`
## (packages/schema/src/guardrail.ts), and a hard review permits only a ONE-TIME approval or a
## rejection. The office offered `once / always / reject` on EVERY review and never read the
## field at all, so the UI offered a session-wide approval the runtime would refuse - and a
## permission boundary presented as a normal choice is the worst kind of defect, because the
## user believes they made a decision the runtime accepted.
##
## Each clause fails differently, so each is a separate property:
##
##   * HARD RESTRICTION - a hard review offers only `once` and `reject`, and says why;
##   * ORDINARY REVIEW - an ordinary review still offers the session-scoped `always`;
##   * EQUIVALENCE - what the UI offers is exactly what `AttentionQueue` will accept, so a
##     control can never produce a payload the service refuses;
##   * QUESTIONS ARE ANSWERS - a question's reply is the `answers` payload with the labels the
##     runtime supplied, never a literal reply;
##   * DECISIONS ARE NOT DIALOGUE - a human decision is recorded as a decision, not appended to
##     the conversation as if the model or the user had spoken.
extends RefCounted


func run(t) -> void:
	test_a_hard_review_offers_only_once_and_reject(t)
	test_a_hard_review_never_offers_a_session_wide_approval(t)
	test_an_ordinary_review_still_offers_the_session_approval(t)
	test_the_offered_replies_are_exactly_what_the_queue_accepts(t)
	test_a_hard_review_payload_cannot_be_built_for_a_session_approval(t)
	test_a_question_replies_with_its_own_answers_payload(t)
	test_a_question_never_replies_with_a_literal_review_reply(t)
	test_a_decision_is_recorded_as_a_decision_not_as_dialogue(t)
	test_a_hard_review_is_labelled_as_one(t)


## A guardrail request in the shape the wire sends, with the hard flag as the schema names it.
func _guardrail(request_id: String, hard: bool) -> Dictionary:
	var request := {
		"id": request_id, "sessionID": "ses_a", "rootSessionID": "ses_a",
		"action": "shell", "resources": ["rm -rf build"],
		"ruleIDs": ["rule-1"], "reason": "this removes files",
		"standard": false,
	}
	if hard:
		request["hardReview"] = true
	return request


## A permission request. The schema has no hard flag for a permission, so it never carries one.
func _permission(request_id: String) -> Dictionary:
	return {
		"id": request_id, "sessionID": "ses_a", "action": "write",
		"resources": ["src/main.ts"], "reason": "the agent wants to edit a file",
	}


## A question with the options the runtime supplied.
func _question(request_id: String) -> Dictionary:
	return {
		"id": request_id, "sessionID": "ses_a",
		"questions": [{"text": "which environment?", "options": [{"label": "staging"}, {"label": "production"}]}],
	}


## Record one request the way the runtime actually delivers it.
##
## A permission and a guardrail arrive as their own EPHEMERAL events, but a QUESTION arrives on
## `session.task.updated` as a `question_asked` change - driving it through the guardrail event
## would give the queue the wrong kind, and the test would then be asserting about a request
## the product never receives.
func _store(store: OfficeStore, kind: String, data: Dictionary) -> void:
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-a",
	})
	if kind == AttentionQueue.KIND_QUESTION:
		store.apply({
			"type": Wire.TASK_UPDATED, "sessionID": "ses_a",
			"data": {"change": {"type": Wire.CHANGE_QUESTION_ASKED, "question": data}},
			"sourceEpoch": "epoch-a",
		})
		return
	var type := Wire.PERMISSION_ASKED
	if kind == AttentionQueue.KIND_GUARDRAIL:
		type = Wire.GUARDRAIL_ASKED
	store.apply({
		"type": type, "sessionID": "ses_a", "data": data, "sourceEpoch": "epoch-a",
	})


## The replies a request OFFERS, which is what the drawer turns into controls.
func _offered(store: OfficeStore, request_id: String) -> Array:
	var request: Dictionary = store.attention.for_session("")
	for entry in store.attention.pending():
		if str(entry["id"]) == request_id:
			request = entry
	var shape := AttentionQueue.reply_shape(request)
	if str(shape.get("type", "")) == "literal":
		return shape.get("allowed", [])
	return []


## A HARD review offers a one-time approval and a rejection, and nothing else.
func test_a_hard_review_offers_only_once_and_reject(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_GUARDRAIL, _guardrail("grq_hard", true))
	var offered := _offered(store, "grq_hard")
	t.check(offered.has("once"), "a hard review offers a one-time approval (%s)" % str(offered))
	t.check(offered.has("reject"), "and a rejection (%s)" % str(offered))


## The restriction itself: no session-wide approval may be offered for a hard review. The
## runtime would refuse it, so offering it presents a permission the user does not have.
func test_a_hard_review_never_offers_a_session_wide_approval(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_GUARDRAIL, _guardrail("grq_hard", true))
	var offered := _offered(store, "grq_hard")
	t.check(
		not offered.has("always"),
		"a hard review never offers a session-wide approval (%s)" % str(offered)
	)
	# And the payload cannot be built for it either, so the restriction holds even if a
	# caller bypassed the list.
	t.check(
		AttentionQueue.literal_payload_for("grq_hard", "always", true).is_empty(),
		"and a session-wide payload cannot be built for a hard review"
	)


## An ORDINARY review keeps the session-scoped approval, because withholding it would make
## the restriction meaningless by applying it everywhere.
func test_an_ordinary_review_still_offers_the_session_approval(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_GUARDRAIL, _guardrail("grq_ordinary", false))
	var offered := _offered(store, "grq_ordinary")
	t.check(offered.has("always"), "an ordinary review offers the session approval (%s)" % str(offered))
	t.check(offered.has("once"), "and a one-time approval")
	t.check(offered.has("reject"), "and a rejection")
	# A permission request likewise, since the schema gives it no hard flag at all.
	_store(store, AttentionQueue.KIND_PERMISSION, _permission("prq_ordinary"))
	var permission_offered := _offered(store, "prq_ordinary")
	t.check(
		permission_offered.has("always"),
		"a permission request offers the session approval (%s)" % str(permission_offered)
	)


## EQUIVALENCE. Whatever the UI offers, the queue must accept, and whatever the queue
## accepts must be one of the offered replies. A control that can produce a refused payload
## is a control that lies.
func test_the_offered_replies_are_exactly_what_the_queue_accepts(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_GUARDRAIL, _guardrail("grq_hard", true))
	var offered := _offered(store, "grq_hard")
	# Every offered reply builds a payload.
	for reply in offered:
		t.check(
			not AttentionQueue.literal_payload_for("grq_hard", reply, true).is_empty(),
			"the offered reply '%s' builds a payload" % reply
		)
	# Every reply the queue can build for this request IS offered.
	for reply in AttentionQueue.REPLIES:
		var built := AttentionQueue.literal_payload_for("grq_hard", reply, true)
		t.check_equal(
			not built.is_empty(), offered.has(reply),
			"whether '%s' is accepted matches whether it is offered" % reply
		)


## The payload guard is not merely a list the UI happens to consult.
func test_a_hard_review_payload_cannot_be_built_for_a_session_approval(t) -> void:
	t.check(
		AttentionQueue.literal_payload_for("grq_h", "always", true).is_empty(),
		"a session-wide approval is refused for a hard review"
	)
	t.check(
		not AttentionQueue.literal_payload_for("grq_h", "once", true).is_empty(),
		"a one-time approval is accepted"
	)
	t.check(
		not AttentionQueue.literal_payload_for("grq_h", "reject", true).is_empty(),
		"and a rejection is accepted"
	)
	# An ordinary review keeps all three.
	for reply in AttentionQueue.REPLIES:
		t.check(
			not AttentionQueue.literal_payload_for("grq_o", reply, false).is_empty(),
			"an ordinary review accepts '%s'" % reply
		)
	# A reply that is not in the schema's literal set is refused in every case.
	t.check(
		AttentionQueue.literal_payload_for("grq_o", "maybe", false).is_empty(),
		"a reply the schema does not declare is refused"
	)


## A question is answered with the ANSWERS payload, carrying the labels the runtime supplied.
func test_a_question_replies_with_its_own_answers_payload(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_QUESTION, _question("qst_1"))
	var request: Dictionary = store.attention.for_session("ses_a")
	var shape := AttentionQueue.reply_shape(request)
	t.check_equal(str(shape.get("type", "")), "answers", "a question replies with answers")
	var options: Array = shape.get("options", [])
	t.check_equal(options.size(), 1, "one question is one group of options")
	if options.size() == 1:
		t.check_equal(
			options[0], ["staging", "production"] as Array,
			"and the labels are the runtime's own, in its order"
		)
	var payload := AttentionQueue.answers_payload(["staging"])
	t.check_equal(
		payload, {"answers": ["staging"]}, "the payload carries the chosen answers"
	)


## A question must never be answered with a literal review reply. The runtime would refuse
## it, and the user's choice would be lost silently.
func test_a_question_never_replies_with_a_literal_review_reply(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_QUESTION, _question("qst_2"))
	var offered := _offered(store, "qst_2")
	t.check(offered.is_empty(), "a question offers no literal replies (%s)" % str(offered))
	# The literal helper builds a payload only for a reply the schema declares.
	t.check_equal(
		AttentionQueue.literal_payload("once"), {"reply": "once"},
		"a declared reply builds a literal payload"
	)
	t.check(
		AttentionQueue.literal_payload("which environment? ").is_empty(),
		"and a question's text is not a reply the literal helper will build"
	)
	var request: Dictionary = store.attention.for_session("ses_a")
	var shape := AttentionQueue.reply_shape(request)
	t.check_equal(str(shape.get("type", "")), "answers", "a question's shape is answers, not a literal")


## A human decision is a DECISION, not dialogue. It is never appended to the conversation as
## if the user or the model had spoken, and no narration is invented for it.
func test_a_decision_is_recorded_as_a_decision_not_as_dialogue(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_GUARDRAIL, _guardrail("grq_d", true))
	var before := store.conversation_items("ses_a").size()
	# The human answers.
	store.attention.resolve("grq_d")
	t.check(
		not store.attention.has("grq_d"),
		"the request is no longer pending once answered"
	)
	# Answering must not have written a conversation row: a decision is not something anyone
	# said, and inventing a line for it would present a human act as model output.
	t.check_equal(
		store.conversation_items("ses_a").size(), before,
		"answering adds no conversation row"
	)


## A hard review is LABELLED as one, so the user knows why the session-wide approval is
## missing rather than assuming the UI is broken.
func test_a_hard_review_is_labelled_as_one(t) -> void:
	var store := OfficeStore.new()
	_store(store, AttentionQueue.KIND_GUARDRAIL, _guardrail("grq_l", true))
	var request: Dictionary = store.attention.for_session("ses_a")
	t.check(
		AttentionQueue.is_hard_review(request),
		"the queue reports the request as a hard review"
	)
	var ordinary: Dictionary = _guardrail("grq_n", false)
	t.check(
		not AttentionQueue.is_hard_review(ordinary),
		"and an ordinary guardrail request is not one"
	)
	t.check(
		not AttentionQueue.is_hard_review(_permission("prq_1")),
		"nor is a permission request, which the schema gives no hard flag"
	)
	t.check(
		not AttentionQueue.is_hard_review({}),
		"nor is an empty request"
	)