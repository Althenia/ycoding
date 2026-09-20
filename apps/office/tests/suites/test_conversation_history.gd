## Canonical conversation history tests (R6-01).
##
## The kit requires the desktop to render ACTUAL session history: "canonical messages,
## ordered and source-linked", verified by "send, see response, close/open inspector, switch
## sessions, restart desktop, confirm same durable content". The office built its transcript
## only from live events it happened to observe, so a restart or a session the user had not
## watched showed nothing.
##
## This is the read that fixes that, and every clause fails differently:
##
##   * CANONICAL - the rows come from the service's message list, not from remembered events;
##   * REASONING IS NOT SOCIAL - the kit forbids rendering private reasoning as a message,
##     in those words;
##   * SYSTEM IS LABELLED - a system-generated observation is marked as such rather than
##     presented as the user's or the agent's own words;
##   * SOURCE-LINKED - each row carries its message id, so a row can be traced to its source
##     and a durable row can displace a remembered one for the same message;
##   * ORDERED - the order is the service's own, and the wall clock is never consulted;
##   * SCOPED - a late answer for a session the user has left cannot become the current
##     history;
##   * HONEST FAILURE - a read that cannot complete leaves the history as unread and says so,
##     rather than presenting a partial list as the whole of it.
##
## The wire shape is taken from the live schema, not invented:
##   * every message has `id`, `type`, and `time.created`;
##   * a user message carries top-level `text`; an assistant carries `content`, an array of
##     tagged parts whose `text` parts hold the words and whose `reasoning` parts hold private
##     thinking.
extends RefCounted


func run(t) -> void:
	test_a_user_message_becomes_its_own_row(t)
	test_an_assistant_message_becomes_an_answer_row(t)
	test_private_reasoning_is_never_rendered(t)
	test_a_system_observation_is_labelled_as_one(t)
	test_every_row_carries_its_source_message_id(t)
	test_rows_keep_the_service_order(t)
	test_a_late_answer_for_another_session_is_not_installed(t)
	test_a_failed_read_says_so_rather_than_showing_a_partial(t)
	test_a_tool_part_is_reported_as_tool_output(t)
	test_an_empty_history_is_empty_rather_than_absent(t)


## A user message, in the shape the service sends.
func _user(id: String, text: String, created: int = 1000) -> Dictionary:
	return {"id": id, "type": "user", "text": text, "time": {"created": created}}


## An assistant message whose content holds the given parts.
func _assistant(id: String, parts: Array, created: int = 2000) -> Dictionary:
	return {
		"id": id, "type": "assistant", "agent": "lead",
		"model": {"providerID": "openrouter", "id": "some-model"},
		"content": parts, "time": {"created": created},
	}


func _text_part(text: String) -> Dictionary:
	return {"type": "text", "text": text, "phase": "final_answer"}


func _reasoning_part(text: String) -> Dictionary:
	return {"type": "reasoning", "text": text}


func _system(id: String, text: String) -> Dictionary:
	return {"id": id, "type": "system", "text": text}


## A user's own words are the user's row.
func test_a_user_message_becomes_its_own_row(t) -> void:
	var rows: Array[Dictionary] = ConversationHistory.project([_user("msg_u1", "deploy the fix")])
	t.check_equal(rows.size(), 1, "the user message is one row")
	if rows.is_empty():
		return
	t.check_equal(
		str(rows[0].get("description", "")), "deploy the fix",
		"and carries the user's own words"
	)
	t.check_equal(str(rows[0].get("kind", "")), "prompt", "marked as the user's turn")


## An assistant's words are an answer, taken from its TEXT parts.
func test_an_assistant_message_becomes_an_answer_row(t) -> void:
	var rows: Array[Dictionary] = ConversationHistory.project([
		_assistant("msg_a1", [_text_part("I changed the file.")]),
	])
	t.check_equal(rows.size(), 1, "the assistant message is one row")
	if rows.is_empty():
		return
	t.check_equal(
		str(rows[0].get("description", "")), "I changed the file.",
		"and carries the assistant's own words"
	)
	t.check_equal(str(rows[0].get("kind", "")), "answer", "marked as an answer")


## The kit's own words: "Do not render private reasoning as social messages." A reasoning
## part is the model's private thinking, not something it said to anyone, so it is not a row
## at all - and it must not be smuggled in as part of another row's text either.
func test_private_reasoning_is_never_rendered(t) -> void:
	var private_words := "an internal deliberation the user must never be shown"
	# A message that is ONLY reasoning produces no row.
	var only_reasoning: Array[Dictionary] = ConversationHistory.project([
		_assistant("msg_r1", [_reasoning_part(private_words)]),
	])
	t.check(only_reasoning.is_empty(), "a reasoning-only message renders no row")
	# A message with BOTH must show the words and not the thinking.
	var mixed: Array[Dictionary] = ConversationHistory.project([
		_assistant("msg_r2", [_reasoning_part(private_words), _text_part("the answer")]),
	])
	t.check_equal(mixed.size(), 1, "the mixed message is one row")
	var rendered := ""
	for row in mixed:
		rendered += str(row.get("description", "")) + " "
	t.check(
		rendered.contains("the answer"), "the visible words are rendered"
	)
	t.check(
		not rendered.contains("internal deliberation"), "and the private thinking is not"
	)
	# Any other text the projection builds must be clean too, including its tooltips.
	for row in mixed:
		for key in row:
			t.check(
				not str(row[key]).contains("internal deliberation"),
				"no field of the row carries the private thinking (%s)" % str(key)
			)


## A system observation is generated by the runtime, not written by a person. The kit
## requires it to be labelled as such.
func test_a_system_observation_is_labelled_as_one(t) -> void:
	var rows: Array[Dictionary] = ConversationHistory.project([_system("msg_s1", "context compacted")])
	t.check_equal(rows.size(), 1, "the system message is one row")
	if rows.is_empty():
		return
	t.check_equal(str(rows[0].get("kind", "")), "observation", "marked as an observation")
	t.check(
		not bool(rows[0].get("source_verified", true)),
		"and not presented as a person's verified words"
	)


## Every row must be traceable to the message it came from, so a durable row can displace a
## remembered row for the same message and a bubble can open its exact source.
func test_every_row_carries_its_source_message_id(t) -> void:
	var rows: Array[Dictionary] = ConversationHistory.project([
		_user("msg_u1", "first"),
		_assistant("msg_a1", [_text_part("second")]),
		_system("msg_s1", "third"),
	])
	t.check_equal(rows.size(), 3, "all three are rows")
	var ids: Array[String] = []
	for row in rows:
		var message_id := str(row.get("message_id", ""))
		ids.append(message_id)
		t.check(not message_id.is_empty(), "every row names its source message")
	t.check_equal(
		ids, ["msg_u1", "msg_a1", "msg_s1"] as Array[String],
		"and each names its OWN message"
	)


## The order is the service's own. The wall clock is never consulted, because a replay can
## deliver a burst whose recorded times are seconds apart in any order.
func test_rows_keep_the_service_order(t) -> void:
	var rows: Array[Dictionary] = ConversationHistory.project([
		_user("msg_u1", "first", 9000),
		_assistant("msg_a1", [_text_part("second")], 3000),
		_user("msg_u2", "third", 7000),
	])
	var texts: Array[String] = []
	for row in rows:
		texts.append(str(row.get("description", "")))
	t.check_equal(
		texts, ["first", "second", "third"] as Array[String],
		"the rows keep the order they were given in"
	)


## A late answer for a session the user has LEFT must not become the current history. The
## same rule the folder switch and the model catalogue already follow.
func test_a_late_answer_for_another_session_is_not_installed(t) -> void:
	var history := ConversationHistory.new()
	history.start("ses_a")
	t.check(history.is_pending(), "the read is in flight")
	# The user moves on before the answer arrives.
	history.start("ses_b")
	# The answer for A arrives now. It belongs to a session the user has LEFT, so it must
	# not be installed. Asserting "empty OR unchanged" passes whichever way the code
	# behaves, so the row count is asserted directly instead.
	history.install("ses_a", [_user("msg_u1", "alpha only")])
	t.check_equal(
		history.rows_for("ses_a").size(), 0,
		"the departed session's late answer is NOT installed"
	)
	t.check_equal(
		history.rows_for("ses_b").size(), 0,
		"and it is not installed under the session the user moved to"
	)
	t.check(
		not history.has_read("ses_a"),
		"the departed session is still recorded as unread"
	)
	t.check(history.is_pending(), "the read it did not answer is still in flight")
	t.check_equal(
		history.current_session(), "ses_b",
		"and the session the user is on is unchanged"
	)
	# The answer for B is installed, because that is where the user is.
	history.install("ses_b", [_user("msg_u2", "beta only")])
	t.check_equal(history.rows_for("ses_b").size(), 1, "the current session's read installs")
	t.check(history.has_read("ses_b"), "and is recorded as read")


## A read that cannot complete leaves the history UNREAD and says so. Presenting a partial
## list as the whole of it is the same class of untruth as inventing one.
func test_a_failed_read_says_so_rather_than_showing_a_partial(t) -> void:
	var history := ConversationHistory.new()
	# An EARLIER successful read must not stand in for a later failed one, or a failure
	# would show old content as if it were current.
	history.start("ses_a")
	history.install("ses_a", [_user("msg_u1", "an earlier read")])
	t.check_equal(history.rows_for("ses_a").size(), 1, "the earlier read installed")
	history.start("ses_a")
	history.fail("ses_a", "The service refused the read (HTTP 500).")
	t.check(
		not history.is_pending(),
		"a failed read is no longer pending"
	)
	t.check(
		not history.last_error().strip_edges().is_empty(),
		"and the reason is readable rather than silent"
	)
	t.check(
		not history.has_read("ses_a"),
		"the session is NOT recorded as read"
	)
	t.check_equal(
		history.rows_for("ses_a").size(), 0,
		"and the stale rows of the earlier read are gone, not shown as current"
	)


## A tool part is tool output, not something the agent said. It is reported as its own kind
## so it is never read as an answer.
func test_a_tool_part_is_reported_as_tool_output(t) -> void:
	var rows: Array[Dictionary] = ConversationHistory.project([
		_assistant("msg_t1", [{
			"type": "tool", "tool": "shell", "callID": "call_1",
			"state": {"status": "completed", "input": {"command": "echo hi"}, "output": "hi"},
		}]),
	])
	t.check_equal(rows.size(), 1, "the tool part is one row")
	if rows.is_empty():
		return
	t.check_equal(str(rows[0].get("kind", "")), "tool", "marked as tool output")
	t.check(
		str(rows[0].get("description", "")).contains("shell"),
		"and names the tool it was (%s)" % str(rows[0].get("description", ""))
	)


## A session with no messages reads as EMPTY, which is a fact about the session. It must not
## read as "not loaded", or a genuinely empty session would show a spinner forever.
func test_an_empty_history_is_empty_rather_than_absent(t) -> void:
	var history := ConversationHistory.new()
	history.start("ses_a")
	history.install("ses_a", [])
	t.check(not history.is_pending(), "the read settled")
	t.check(
		history.has_read("ses_a"),
		"and the session is recorded as read, so it is not awaited again"
	)
	t.check(
		history.rows_for("ses_a").is_empty(),
		"an empty history has no rows"
	)
	t.check_equal(history.last_error(), "", "and is not an error")
