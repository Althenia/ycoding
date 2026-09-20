## Rich transcript detail tests (R6-02).
##
## The acceptance is: "Markdown/code/tool result/attachments where supported; escape
## untrusted markup and no hidden chain-of-thought fabrication."
##
## "Where supported" is the operative phrase, and this client's answer is already decided by
## a security gate: `test_asset_provenance.gd` FORBIDS a markup-rendering control in the
## transcript and requires message text to reach the screen through plain, inert labels,
## verbatim. So markdown is NOT supported here, and rendering it would breach that boundary.
## What remains is the detail the kit actually asks for, all of it as inert data:
##
##   * CODE - a fenced block in a message is detail worth its own row, and its language and
##     body are carried as text;
##   * TOOL RESULT - a tool call's output is detail, bounded so a huge result cannot make the
##     row unusable, and marked when it is cut;
##   * ATTACHMENTS - the files a message names are listed, because a message that refers to a
##     file is unusable without knowing which;
##   * NO FABRICATION - nothing is invented for a part the runtime did not send, and private
##     reasoning never becomes text.
##
## Every clause is about text being CARRIED, never interpreted. Nothing added here may
## introduce a control that renders markup, because that gate exists for a reason: a message
## can contain shell-shaped text from anywhere.
extends RefCounted


func run(t) -> void:
	test_a_fenced_code_block_is_its_own_row(t)
	test_a_code_row_carries_its_language_and_body(t)
	test_markup_is_never_rendered_as_markup(t)
	test_tool_output_is_bounded_and_says_when_it_is_cut(t)
	test_a_message_that_names_files_lists_them(t)
	test_an_attachment_with_no_name_is_still_reported(t)
	test_private_reasoning_never_becomes_a_code_or_tool_row(t)
	test_nothing_is_invented_for_a_part_the_runtime_did_not_send(t)
	test_an_unclosed_fence_never_swallows_the_message(t)


## A message whose text contains a fenced block, in the shape a model writes one.
func _with_fence(body: String, language: String = "") -> String:
	return "Here is the change:\n```%s\n%s\n```\nand that is all." % [language, body]


func _assistant(id: String, parts: Array) -> Dictionary:
	return {
		"id": id, "type": "assistant", "agent": "lead",
		"model": {"providerID": "openrouter", "id": "some-model"},
		"content": parts, "time": {"created": 2000},
	}


func _text_part(text: String) -> Dictionary:
	return {"type": "text", "text": text, "phase": "final_answer"}


func _user(id: String, text: String, files: Array = []) -> Dictionary:
	var message := {"id": id, "type": "user", "text": text, "time": {"created": 1000}}
	if not files.is_empty():
		message["files"] = files
	return message


## A fenced block is a distinct kind of content, so it gets its own row rather than being
## buried in the surrounding prose.
func test_a_fenced_code_block_is_its_own_row(t) -> void:
	var rows := ConversationHistory.project([
		_assistant("msg_c1", [_text_part(_with_fence("const a = 1", "typescript"))]),
	])
	var code_rows := rows.filter(func(r): return str(r.get("kind", "")) == "code")
	t.check_equal(code_rows.size(), 1, "the fenced block is its own row")
	# And the prose around it is still shown, so the answer is not lost.
	var answer_rows := rows.filter(func(r): return str(r.get("kind", "")) == "answer")
	t.check(
		answer_rows.size() >= 1,
		"the surrounding prose is still an answer row"
	)


## The code row carries the language and the body, so the detail is usable rather than
## merely present.
func test_a_code_row_carries_its_language_and_body(t) -> void:
	var rows := ConversationHistory.project([
		_assistant("msg_c2", [_text_part(_with_fence("const a = 1", "typescript"))]),
	])
	var code_rows := rows.filter(func(r): return str(r.get("kind", "")) == "code")
	if code_rows.is_empty():
		t.check(false, "a code row exists")
		return
	var text := str(code_rows[0].get("description", ""))
	t.check(text.contains("const a = 1"), "the code body is carried")
	t.check(text.contains("typescript"), "and the language is named")
	# The fences themselves are the delimiter, not content.
	t.check(not text.contains("```"), "the fence markers are not part of the body")


## Markup in a message is TEXT, never markup. The kit says "escape untrusted markup", and
## this client's answer is stronger than escaping: it renders through inert labels only.
func test_markup_is_never_rendered_as_markup(t) -> void:
	var hostile := "[b]bold[/b] [url=x]link[/url] <script>alert(1)</script>"
	var rows := ConversationHistory.project([
		_assistant("msg_m1", [_text_part(hostile)]),
	])
	var text := ""
	for row in rows:
		text += str(row.get("description", "")) + " "
	t.check(
		text.contains("[b]"), "the markup survives as literal text"
	)
	t.check(
		text.contains("<script>"), "including anything HTML-shaped"
	)


## A tool result is detail, and a result can be enormous. It is bounded so one call cannot
## make the row unusable, and the cut is MARKED rather than silent.
func test_tool_output_is_bounded_and_says_when_it_is_cut(t) -> void:
	var huge := "x".repeat(ConversationHistory.TOOL_OUTPUT_LIMIT * 3)
	var rows := ConversationHistory.project([
		_assistant("msg_t1", [{
			"type": "tool", "tool": "shell", "callID": "call_1",
			"state": {"status": "completed", "input": {}, "output": huge},
		}]),
	])
	var tool_rows := rows.filter(func(r): return str(r.get("kind", "")) == "tool")
	t.check_equal(tool_rows.size(), 1, "the tool call is one row")
	if tool_rows.is_empty():
		return
	var text := str(tool_rows[0].get("description", ""))
	t.check(
		text.length() < huge.length(),
		"the output is bounded rather than carried whole"
	)
	t.check(
		text.contains(ConversationHistory.TRUNCATION_MARK),
		"and the cut is marked rather than silent"
	)
	# A SMALL result is carried whole, so the bound does not cut what fits.
	var small := ConversationHistory.project([
		_assistant("msg_t2", [{
			"type": "tool", "tool": "shell", "callID": "call_2",
			"state": {"status": "completed", "input": {}, "output": "done"},
		}]),
	])
	var small_tool := small.filter(func(r): return str(r.get("kind", "")) == "tool")
	if small_tool.size() == 1:
		t.check(
			not str(small_tool[0].get("description", "")).contains(ConversationHistory.TRUNCATION_MARK),
			"a small result is not marked as cut"
		)


## A fence the runtime never CLOSED is prose, not a block. Treating it as an open block would
## swallow everything after it into a code row the runtime never delimited, so text the
## runtime sent would disappear from the transcript.
func test_an_unclosed_fence_never_swallows_the_message(t) -> void:
	# A fence that opens and never closes, with real content after it.
	var text := "Here is the change:\n```typescript\nconst a = 1\nand the rest of what I meant to say"
	var rows := ConversationHistory.project([_assistant("msg_u1", [_text_part(text)])])
	var all_text := ""
	for row in rows:
		all_text += str(row.get("description", "")) + "\n"
	t.check(
		all_text.contains("const a = 1"),
		"the text after an unclosed fence is not lost"
	)
	t.check(
		all_text.contains("the rest of what I meant to say"),
		"and neither is the rest of the message"
	)
	# A fence with nothing after it is likewise preserved rather than vanishing.
	var bare := ConversationHistory.project([_assistant("msg_u2", [_text_part("done\n```")])])
	var bare_text := ""
	for row in bare:
		bare_text += str(row.get("description", "")) + " "
	t.check(
		not bare_text.strip_edges().is_empty(),
		"a message ending in an unclosed fence still produces text (%s)" % bare_text.strip_edges()
	)


## A message that names files is unusable without knowing which. The names are listed as
## text, and nothing about the file's CONTENT is invented.
func test_a_message_that_names_files_lists_them(t) -> void:
	var rows := ConversationHistory.project([
		_user("msg_f1", "look at these", [
			{"name": "report.md", "mime": "text/markdown"},
			{"name": "chart.png", "mime": "image/png"},
		]),
	])
	var all_text := ""
	for row in rows:
		all_text += str(row.get("description", "")) + " "
	t.check(all_text.contains("report.md"), "the first file is named")
	t.check(all_text.contains("chart.png"), "and the second")
	# The transcript must not claim to have the file's contents.
	t.check(
		not all_text.contains("text/markdown"),
		"and no mime type is presented as content"
	)


## An attachment the runtime did not name is still reported, because the message referred to
## it. It is described by what IS known rather than given an invented name.
func test_an_attachment_with_no_name_is_still_reported(t) -> void:
	var rows := ConversationHistory.project([
		_user("msg_f2", "see attached", [{"mime": "application/pdf"}]),
	])
	var all_text := ""
	for row in rows:
		all_text += str(row.get("description", "")) + " "
	t.check(
		not all_text.strip_edges().is_empty(),
		"the message still produces text"
	)
	t.check(
		all_text.contains("attachment") or all_text.contains("file"),
		"and an unnamed attachment is still reported as one (%s)" % all_text.strip_edges()
	)


## Private reasoning never becomes a code row or a tool row either - the exclusion applies to
## every kind, not only to answers.
func test_private_reasoning_never_becomes_a_code_or_tool_row(t) -> void:
	var private_words := "an internal deliberation the user must never be shown"
	var rows := ConversationHistory.project([
		_assistant("msg_p1", [
			{"type": "reasoning", "text": private_words + "\n```\nsecret code\n```"},
			_text_part("the answer"),
		]),
	])
	for row in rows:
		for key in row:
			t.check(
				not str(row[key]).contains("internal deliberation"),
				"no row field carries the private thinking (%s)" % str(key)
			)
	t.check(
		not rows.any(func(r): return str(r.get("kind", "")) == "code"),
		"and a fence inside private thinking does not become a code row"
	)


## Nothing is invented for a part the runtime did not send. A tool call with no output says
## it has none rather than describing output that does not exist.
func test_nothing_is_invented_for_a_part_the_runtime_did_not_send(t) -> void:
	var rows := ConversationHistory.project([
		_assistant("msg_n1", [{
			"type": "tool", "tool": "shell", "callID": "call_1",
			"state": {"status": "running", "input": {}},
		}]),
	])
	var tool_rows := rows.filter(func(r): return str(r.get("kind", "")) == "tool")
	t.check_equal(tool_rows.size(), 1, "the running call is one row")
	if tool_rows.is_empty():
		return
	var text := str(tool_rows[0].get("description", ""))
	t.check(
		not text.contains("output"), "no output is claimed for a call that has none"
	)
	t.check(
		text.contains("shell"), "and the tool it was is still named"
	)


## The boundary clause - no markup-rendering control may be added to the transcript - is
## enforced by `test_asset_provenance.gd`, which scans every suite and runs the drawer against
## hostile text. It is NOT duplicated here: the scan's own pattern names the control it
## forbids, and only the scanner's own file is excused from matching it, so a copy of that
## check in another suite is itself a hit. The property is asserted where it is owned.
