## SSE parser contract tests (TEST-007, TEST-008).
##
## The parser is the boundary between raw network bytes and wire events, so these
## cover the framing rules the real server actually produces plus the failure
## modes a client must survive. Everything here runs the production parser.
extends RefCounted


func run(t) -> void:
	test_single_chunk_event(t)
	test_split_mid_data(t)
	test_utf8_split_across_chunks(t)
	test_crlf_and_split_crlf(t)
	test_lone_cr(t)
	test_comment_ignored(t)
	test_multiline_data_joined(t)
	test_event_name(t)
	test_id_and_retry(t)
	test_unknown_field_ignored(t)
	test_incomplete_event_stays_pending(t)
	test_oversize_reports_error_and_recovers(t)


func _bytes(input: String) -> PackedByteArray:
	return input.to_utf8_buffer()


func test_single_chunk_event(t) -> void:
	var parser := SseParser.new()
	var events := parser.feed(_bytes("data: hello\n\n"))
	t.check_equal(events.size(), 1, "one complete event is emitted")
	t.check_equal(events[0]["data"], "hello", "data payload decoded")


## The server writes `data: <json>\n\n`; a chunk boundary can fall anywhere.
func test_split_mid_data(t) -> void:
	var parser := SseParser.new()
	var first := parser.feed(_bytes("data: hel"))
	var second := parser.feed(_bytes("lo\n\n"))
	t.check(first.is_empty(), "a partial event is not emitted early")
	t.check_equal(second.size(), 1, "the event completes on the next chunk")
	t.check_equal(second[0]["data"], "hello", "split payload reassembled")


## A multibyte character split across chunks must not corrupt.
func test_utf8_split_across_chunks(t) -> void:
	var parser := SseParser.new()
	var full := _bytes("data: 日本語\n\n")
	var cut := full.size() - 5
	var first := parser.feed(full.slice(0, cut))
	var second := parser.feed(full.slice(cut))
	t.check(first.is_empty(), "partial multibyte event stays pending")
	t.check_equal(second.size(), 1, "event completes")
	t.check_equal(second[0]["data"], "日本語", "multibyte text preserved exactly")


func test_crlf_and_split_crlf(t) -> void:
	var crlf := SseParser.new()
	t.check_equal(crlf.feed(_bytes("data: a\r\n\r\n")).size(), 1, "CRLF framing")
	var split := SseParser.new()
	split.feed(_bytes("data: a\r"))
	t.check_equal(split.feed(_bytes("\n\r\n")).size(), 1, "CRLF split between chunks")


func test_lone_cr(t) -> void:
	var parser := SseParser.new()
	t.check_equal(parser.feed(_bytes("data: a\r\r")).size(), 1, "a lone CR terminates the event")


## Heartbeats arrive as comment lines and must never surface as events.
func test_comment_ignored(t) -> void:
	var parser := SseParser.new()
	t.check(parser.feed(_bytes(": keep-alive\n\n")).is_empty(), "comment produces no event")


func test_multiline_data_joined(t) -> void:
	var parser := SseParser.new()
	var events := parser.feed(_bytes("data: one\ndata: two\n\n"))
	t.check_equal(events.size(), 1, "one event")
	t.check_equal(events[0]["data"], "one\ntwo", "data lines join with a newline")


func test_event_name(t) -> void:
	var parser := SseParser.new()
	var events := parser.feed(_bytes("event: x\ndata: y\n\n"))
	t.check_equal(events.size(), 1, "one event")
	t.check_equal(events[0]["event"], "x", "event name captured")
	t.check_equal(events[0]["data"], "y", "data captured")


func test_id_and_retry(t) -> void:
	var parser := SseParser.new()
	var events := parser.feed(_bytes("id: 5\nretry: 250\ndata: z\n\n"))
	t.check_equal(events.size(), 1, "one event")
	t.check_equal(events[0]["id"], "5", "id captured")
	t.check_equal(events[0]["retry"], 250, "retry parsed as an integer")


func test_unknown_field_ignored(t) -> void:
	var parser := SseParser.new()
	var events := parser.feed(_bytes("foo: bar\ndata: z\n\n"))
	t.check_equal(events.size(), 1, "one event")
	t.check_equal(events[0]["data"], "z", "unknown field does not corrupt the event")


## An EOF-incomplete event is not a successful message.
func test_incomplete_event_stays_pending(t) -> void:
	var parser := SseParser.new()
	var events := parser.feed(_bytes("data: partial"))
	t.check(events.is_empty(), "incomplete event is not emitted")
	t.check(parser.has_pending(), "incomplete event is reported as pending")


## Oversize input must be reported and must not poison later valid input.
func test_oversize_reports_error_and_recovers(t) -> void:
	var parser := SseParser.new()
	var oversize := PackedByteArray()
	oversize.resize(1024 * 1024 + 64)
	oversize.fill(65)
	parser.feed(oversize)
	t.check(not parser.last_error().is_empty(), "oversize input sets a readable error")
	var events := parser.feed(_bytes("data: ok\n\n"))
	t.check_equal(events.size(), 1, "the parser still works after an oversize line")
	t.check_equal(events[0]["data"], "ok", "recovered event decoded")
