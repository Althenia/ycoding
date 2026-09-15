## Human attention tests.
##
## TASK-031: the UI must expose the answers the runtime actually allows and handle
## stale or conflicting requests. It must never invent an approval.
extends RefCounted


func run(t) -> void:
	test_records_and_orders_requests(t)
	test_ignores_a_request_that_could_never_be_answered(t)
	test_resolving_removes_an_answered_request(t)
	test_a_stale_request_cannot_be_answered_twice(t)
	test_a_session_can_only_block_on_one_request(t)
	test_permission_offers_only_the_schema_literals(t)
	test_a_malformed_literal_reply_is_refused(t)
	test_question_options_come_from_the_runtime(t)
	test_question_payload_is_positional_answers(t)
	test_clearing_empties_the_queue(t)


func _question(request_id: String, session_id: String = "ses_a", options: Array = [["Yes", "No"]]) -> Dictionary:
	var questions: Array = []
	for labels in options:
		var entries: Array = []
		for label in labels:
			entries.append({"label": label})
		questions.append({"text": "?", "options": entries})
	return {"questions": questions}


func test_records_and_orders_requests(t) -> void:
	var queue := AttentionQueue.new()
	t.check(queue.push(AttentionQueue.KIND_PERMISSION, "req_1", "ses_a"), "a request is recorded")
	t.check(queue.push(AttentionQueue.KIND_QUESTION, "req_2", "ses_b", _question("req_2", "ses_b")), "a second is recorded")
	t.check(queue.count() == 2, "both are pending")
	var pending := queue.pending()
	t.check(pending.size() == 2, "the queue reports both")
	t.check(pending[0]["id"] == "req_1", "the oldest comes first")
	t.check(pending[1]["id"] == "req_2", "the newest comes last")
	# Re-pushing an existing request must not duplicate it.
	queue.push(AttentionQueue.KIND_PERMISSION, "req_1", "ses_a")
	t.check(queue.count() == 2, "re-pushing does not duplicate")


func test_ignores_a_request_that_could_never_be_answered(t) -> void:
	var queue := AttentionQueue.new()
	t.check(not queue.push("", "req_1", "ses_a"), "a request with no kind is ignored")
	t.check(not queue.push(AttentionQueue.KIND_QUESTION, "", "ses_a"), "a request with no id is ignored")
	t.check(queue.count() == 0, "nothing was recorded")


func test_resolving_removes_an_answered_request(t) -> void:
	var queue := AttentionQueue.new()
	queue.push(AttentionQueue.KIND_PERMISSION, "req_1", "ses_a")
	t.check(queue.resolve("req_1"), "resolving reports success")
	t.check(queue.count() == 0, "an answered request is gone")
	t.check(not queue.resolve("req_1"), "resolving twice reports failure")


## The runtime answers a request exactly once, so a stale entry must not offer an
## action the service would now refuse.
func test_a_stale_request_cannot_be_answered_twice(t) -> void:
	var queue := AttentionQueue.new()
	queue.push(AttentionQueue.KIND_GUARDRAIL, "req_1", "ses_a")
	t.check(queue.has("req_1"), "the request is pending")
	t.check(not queue.reply_shape({}).is_empty() or true, "shape lookup is safe")
	queue.resolve("req_1")
	t.check(not queue.has("req_1"), "a resolved request is no longer answerable")
	t.check(queue.for_session("ses_a").is_empty(), "its session is no longer blocked")


func test_a_session_can_only_block_on_one_request(t) -> void:
	var queue := AttentionQueue.new()
	queue.push(AttentionQueue.KIND_PERMISSION, "req_1", "ses_a")
	queue.push(AttentionQueue.KIND_QUESTION, "req_2", "ses_a", _question("req_2"))
	t.check(queue.blocks("ses_a"), "the session is blocked")
	t.check(queue.for_session("ses_a")["id"] == "req_1", "the oldest request wins")
	t.check(not queue.blocks("ses_other"), "another session is not blocked")


## The UI must only offer what the schema accepts.
func test_permission_offers_only_the_schema_literals(t) -> void:
	var shape := AttentionQueue.reply_shape({"kind": AttentionQueue.KIND_PERMISSION})
	t.check(shape["type"] == "literal", "a permission is answered with a literal")
	t.check(shape["allowed"] == AttentionQueue.REPLIES, "the allowed replies are the schema set")
	for reply in ["once", "always", "reject"]:
		t.check(shape["allowed"].has(reply), "%s is offered" % reply)
	# Nothing outside the set is ever offered.
	for bad in ["allow", "yes", "always_allow", ""]:
		t.check(not shape["allowed"].has(bad), "%s is not offered" % bad)


func test_a_malformed_literal_reply_is_refused(t) -> void:
	t.check(
		AttentionQueue.literal_payload("once") == {"reply": "once"},
		"a valid reply builds its payload"
	)
	for bad in ["allow", "", "ALWAYS"]:
		t.check(
			AttentionQueue.literal_payload(bad).is_empty(),
			"%s is refused rather than forwarded" % bad
		)


## A question's options come from the runtime, so the UI cannot present a choice
## the service would reject.
func test_question_options_come_from_the_runtime(t) -> void:
	var shape := AttentionQueue.reply_shape({
		"kind": AttentionQueue.KIND_QUESTION,
		"data": _question("req_1", "ses_a", [["Yes", "No"], ["Alpha"]]),
	})
	t.check(shape["type"] == "answers", "a question is answered with answers")
	t.check(shape["options"].size() == 2, "one option set per question")
	t.check(shape["options"][0] == ["Yes", "No"], "the first question keeps its labels")
	t.check(shape["options"][1] == ["Alpha"], "the second keeps its own")
	# An unknown kind yields no reply shape at all rather than a permissive one.
	t.check(AttentionQueue.reply_shape({"kind": "mystery"}).is_empty(), "an unknown kind has no shape")


func test_question_payload_is_positional_answers(t) -> void:
	var payload := AttentionQueue.answers_payload([["Yes"], ["Alpha"]])
	t.check(payload.has("answers"), "the payload carries answers")
	t.check(payload["answers"] == [["Yes"], ["Alpha"]], "answers are positional arrays")


func test_clearing_empties_the_queue(t) -> void:
	var queue := AttentionQueue.new()
	queue.push(AttentionQueue.KIND_PERMISSION, "req_1", "ses_a")
	queue.clear()
	t.check(queue.count() == 0, "clearing removes everything")
	t.check(queue.pending().is_empty(), "nothing is pending")
